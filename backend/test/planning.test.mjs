import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { extractTasks } from '../planner.mjs';
import { createAuthorizer, createAppleAuthorizer } from '../apple.mjs';
import { generateKeyPairSync } from 'node:crypto';
import { createLimiter } from '../limits.mjs';
import { createPlanningServer } from '../server.mjs';
import { subjectHash } from '../app-attest.mjs';
import { HttpError } from '../errors.mjs';

const task = { title: 'Appointment', startTimes: ['21:00'], fillsRemainingTime: false };
const completed = tasks => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ tasks }) }] }] });
const reply = body => async () => Response.json(body);

test('Luna request uses strict schema, no reasoning, no storage and no tools', async () => {
  const result = await extractTasks('Appointment at 2100', { apiKey: 'test-key', fetchImpl: async (url, request) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(request.headers.Authorization, 'Bearer test-key');
    const body = JSON.parse(request.body);
    assert.equal(body.model, 'gpt-6-luna');
    assert.equal(body.store, false);
    assert.equal(body.reasoning.effort, 'none');
    assert.equal(body.text.format.strict, true);
    assert.equal(body.input, 'Appointment at 2100');
    assert.equal(body.tools, undefined);
    return Response.json(completed([task]));
  } });
  assert.deepEqual(result, { tasks: [task] });
});

test('refusal, incomplete, malformed and oversized outputs never become a partial plan', async () => {
  const bad = [
    { ...completed([task]), status: 'incomplete' },
    { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }] },
    { status: 'completed', output: [] },
    completed(Array(25).fill(task)),
    completed([{ ...task, fillsRemainingTime: 'yes' }]),
    completed([{ ...task, title: '' }]),
    completed([{ ...task, startTimes: [42] }]),
  ];
  for (const body of bad) await assert.rejects(extractTasks('Task', { apiKey: 'fake', fetchImpl: reply(body) }), error => error.status === 502);
});

test('upstream billing and authentication errors do not expose upstream secrets', async () => {
  await assert.rejects(extractTasks('Task', { apiKey: 'fake', fetchImpl: async () => new Response('private upstream details', { status: 401 }) }),
    error => error.status === 503 && !error.message.includes('private'));
});

const monthly = { environment: 'Production', transactionId: '123', originalTransactionId: '100',
  productId: 'com.GregAdams.TimeBoxed.pro.monthly', type: 'Auto-Renewable Subscription', expiresDate: Date.now() + 60_000 };
const lifetime = { ...monthly, productId: 'com.GregAdams.TimeBoxed.pro.lifetime', type: 'Non-Consumable' };
function authorizer({ proof = monthly, latest = proof, status = 1, renewal = {}, invalidSignature = false } = {}) {
  const verifier = {
    verifyAndDecodeTransaction: async token => { if (invalidSignature) throw new Error('Invalid signature'); return token === 'proof' ? proof : latest; },
    verifyAndDecodeRenewalInfo: async () => renewal,
  };
  const client = {
    getTransactionInfo: async () => ({ signedTransactionInfo: 'latest' }),
    getAllSubscriptionStatuses: async () => ({ data: [{ lastTransactions: [{ status, signedTransactionInfo: 'latest', signedRenewalInfo: 'renewal' }] }] }),
  };
  return createAuthorizer({ verifiers: { Production: verifier }, clients: { Production: client }, environments: ['Production'] });
}

test('monthly and lifetime purchases authorize against current Apple data', async () => {
  assert.equal(await authorizer()('proof'), 'Production:100');
  assert.equal(await authorizer({ proof: lifetime })('proof'), 'Production:100');
});

test('invalid signatures, other products, expired subscriptions and refunds are rejected', async () => {
  for (const options of [
    { invalidSignature: true },
    { proof: { ...monthly, productId: 'another.app.product' } },
    { status: 2 }, { status: 3 }, { status: 5 },
    { latest: { ...monthly, expiresDate: Date.now() - 1000 } },
    { latest: { ...monthly, revocationDate: Date.now() } },
    { latest: { ...monthly, originalTransactionId: 'someone-else' } },
    { proof: lifetime, latest: { ...lifetime, revocationDate: Date.now() } },
  ]) await assert.rejects(authorizer(options)('proof'), error => error.status === 403);
});

test('billing grace requires a current signed grace expiration for the same subscription', async () => {
  const latest = { ...monthly, expiresDate: Date.now() - 1000 };
  const renewal = { originalTransactionId: '100', gracePeriodExpiresDate: Date.now() + 60_000 };
  assert.equal(await authorizer({ latest, status: 4, renewal })('proof'), 'Production:100');
  await assert.rejects(authorizer({ latest, status: 4, renewal: { ...renewal, originalTransactionId: 'other' } })('proof'));
  await assert.rejects(authorizer({ latest, status: 4, renewal: { ...renewal, gracePeriodExpiresDate: Date.now() - 1000 } })('proof'));
});

test('daily quotas use hashed stable purchase IDs, reset by day and fail closed without Redis', async () => {
  const counts = new Map();
  const redis = { isReady: true, eval: async (script, { keys }) => {
    assert.ok(script.includes("redis.call('EXPIRE'"));
    assert.ok(!keys[0].includes('purchase-secret'));
    const count = (counts.get(keys[0]) ?? 0) + 1;
    counts.set(keys[0], count);
    return count;
  } };
  const limit = createLimiter(redis, { dailyLimit: 2 });
  const day = new Date('2026-10-19T12:00:00Z');
  await limit('purchase-secret', day);
  await limit('purchase-secret', day);
  await assert.rejects(limit('purchase-secret', day), error => error.status === 429);
  await limit('purchase-secret', new Date('2026-10-20T12:00:00Z'));
  redis.isReady = false;
  await assert.rejects(limit('purchase-secret', day), error => error.status === 503);
});

test('global quota bounds total model calls across purchases', async () => {
  let global = 0;
  const redis = { isReady: true, eval: async (_script, { keys }) => keys[0].includes(':global:') ? ++global : 1 };
  const limit = createLimiter(redis, { globalDailyLimit: 2 });
  await limit('one'); await limit('two');
  await assert.rejects(limit('three'), error => error.status === 429);
});

async function withServer(deps, run) {
  const server = createPlanningServer({ appAttest: { assert: async () => subjectHash('purchase') }, ...deps });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
const post = (url, body) => fetch(`${url}/v1/plan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('HTTP endpoint authenticates and limits before making one model call', async () => {
  const calls = [];
  await withServer({ authorize: async proof => { calls.push('auth'); assert.equal(proof, 'a.b.c'); return 'purchase'; },
    limit: async subject => { calls.push('limit'); assert.equal(subject, 'purchase'); },
    generate: async text => { calls.push('model'); assert.equal(text, 'Late meeting'); return { tasks: [task] }; } }, async url => {
    const response = await post(url, { brainDump: 'Late meeting', transaction: 'a.b.c' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { tasks: [task] });
    assert.deepEqual(calls, ['auth', 'limit', 'model']);
  });
});

test('missing proof, oversized notes and invalid body are rejected before model spending', async () => {
  await withServer({ authorize: () => assert.fail('Should not authorize'), generate: () => assert.fail('Should not call OpenAI') }, async url => {
    for (const [body, status] of [[{ brainDump: 'Task' }, 401], [{ brainDump: 'x'.repeat(4001), transaction: 'a.b.c' }, 400], [null, 400]]) {
      assert.equal((await post(url, body)).status, status);
    }
    assert.equal((await fetch(`${url}/v1/plan`)).status, 405);
    assert.equal((await fetch(`${url}/missing`)).status, 404);
  });
});

test('unpaid and rate-limited requests never call OpenAI', async () => {
  for (const status of [403, 429]) await withServer({
    authorize: async () => { if (status === 403) throw new HttpError(403, 'Pro required'); return 'purchase'; },
    limit: async () => { throw new HttpError(429, 'Daily limit'); },
    generate: () => assert.fail('Should not call OpenAI'),
  }, async url => { assert.equal((await post(url, { brainDump: 'Task', transaction: 'a.b.c' })).status, status); });
});

test('unexpected failures return no secrets and readiness reflects quota storage', async () => {
  await withServer({ authorize: async () => { throw new Error('private key and notes'); }, ready: () => false }, async url => {
    const response = await post(url, { brainDump: 'Task', transaction: 'a.b.c' });
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes('private key'));
    assert.equal((await fetch(`${url}/health`)).status, 503);
  });
});

test('real Apple verifier rejects forged purchase proofs without contacting OpenAI', async () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const authorize = createAppleAuthorizer({
    APPLE_BUNDLE_ID: 'com.GregAdams.TimeBoxed', APPLE_APP_ID: '6762071236',
    APPLE_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    APPLE_KEY_ID: 'TESTKEY123', APPLE_ISSUER_ID: '00000000-0000-0000-0000-000000000000',
    APPLE_ENVIRONMENT: 'Production',
  });
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const forged = `${encode({ alg: 'none' })}.${encode(monthly)}.invalid-signature`;
  await assert.rejects(authorize(forged), error => error.status === 403);
});

test('server defaults deny model runs without App Attest, even with a valid-looking purchase', async () => {
  await withServer({ appAttest: undefined, authorize: async () => assert.fail('App integrity must be checked first'),
    generate: () => assert.fail('An unauthenticated caller must never invoke OpenAI') }, async url => {
    assert.equal((await post(url, { brainDump: 'Task', transaction: 'a.b.c' })).status, 401);
  });
});

test('App Attest proof must belong to the same purchase that Apple verifies', async () => {
  await withServer({ appAttest: { assert: async () => subjectHash('another-purchase') }, authorize: async () => 'purchase',
    generate: () => assert.fail('A different purchase must not invoke OpenAI') }, async url => {
    assert.equal((await post(url, { brainDump: 'Task', transaction: 'a.b.c' })).status, 403);
  });
});

test('challenge and registration routes never invoke the model', async () => {
  const events = [];
  await withServer({ authorize: async () => { events.push('pro'); return 'purchase'; },
    appAttest: { challenge: async (subject, keyId) => { assert.equal(subject, 'purchase'); assert.equal(keyId, 'key'); return { challenge: 'nonce', registered: false }; },
      register: async input => { assert.equal(input.attestation, 'attestation'); events.push('register'); } },
    generate: () => assert.fail('App setup must never invoke OpenAI') }, async url => {
    const setup = await fetch(`${url}/v1/attest/challenge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keyId: 'key', transaction: 'a.b.c' }) });
    assert.equal(setup.status, 200);
    assert.deepEqual(await setup.json(), { challenge: 'nonce', registered: false });
    const register = await fetch(`${url}/v1/attest/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keyId: 'key', challenge: 'nonce', attestation: 'attestation' }) });
    assert.equal(register.status, 200);
    assert.deepEqual(events, ['pro', 'register']);
  });
});
