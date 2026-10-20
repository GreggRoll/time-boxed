import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createClient } from 'redis';
import { once } from 'node:events';
import { createPlanningServer } from '../server.mjs';
import cbor from 'cbor';
import { createAppAttest, subjectHash, signedPlanPayload, verifyAppleAttestation } from '../app-attest.mjs';

const bundleIdentifier = 'com.GregAdams.TimeBoxed';
const appIdPrefix = 'J3YZVWSX7K';
const keyID = () => randomBytes(32).toString('base64');
const sha = value => createHash('sha256').update(value).digest();

function assertionFor({ body, privateKey, count = 1, bundle = bundleIdentifier }) {
  const auth = Buffer.concat([sha(`${appIdPrefix}.${bundle}`), Buffer.from([0]), Buffer.alloc(4)]);
  auth.writeUInt32BE(count, 33);
  const nonce = sha(Buffer.concat([auth, sha(signedPlanPayload(body))]));
  const sign = createSign('SHA256'); sign.update(nonce);
  return cbor.encode({ signature: sign.sign(privateKey), authenticatorData: auth }).toString('base64');
}

test('real attestation verifier rejects forged Apple certificate data', () => {
  assert.throws(() => verifyAppleAttestation({ attestation: cbor.encode({ fmt: 'apple-appattest', authData: Buffer.alloc(100), attStmt: { x5c: [Buffer.alloc(2), Buffer.alloc(2)] } }) }));
});

test('App Attest configuration never silently enables development verification', () => {
  assert.throws(() => createAppAttest({}, { bundleIdentifier, appIdPrefix, environment: 'disabled' }));
});

test('cryptographic request binding, replay resistance and registration ownership with real Redis', { skip: !process.env.TEST_REDIS_URL }, async t => {
  const redis = createClient({ url: process.env.TEST_REDIS_URL });
  await redis.connect();
  t.after(async () => { await redis.quit(); });
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
  const app = createAppAttest(redis, { bundleIdentifier, appIdPrefix,
    // Only the Apple registration ceremony is stubbed. Assertions use the real P-256 verifier.
    attestVerifier: options => ({ keyId: options.keyId, publicKey, environment: 'production', receipt: Buffer.from('test receipt') }) });
  const owner = `test-${randomBytes(16).toString('hex')}`;
  const keyId = keyID();
  const fakeAttestation = Buffer.from('test registration').toString('base64');
  const registration = await app.challenge(owner, keyId);
  assert.equal(registration.registered, false);
  await app.register({ keyId, challenge: registration.challenge, attestation: fakeAttestation });
  await assert.rejects(app.register({ keyId, challenge: registration.challenge, attestation: fakeAttestation }), error => error.status === 401);
  await assert.rejects(app.challenge('different-owner', keyId), error => error.status === 401);

  function bodyFor(challenge, brainDump = 'Task at 2100') { return Buffer.from(JSON.stringify({ keyId, challenge, brainDump, transaction: 'a.b.c' })); }
  const nonce = await app.challenge(owner, keyId);
  assert.equal(nonce.registered, true);
  const body = bodyFor(nonce.challenge);
  const signature = assertionFor({ body, privateKey: keys.privateKey });
  assert.equal(await app.assert(JSON.parse(body), body, signature), subjectHash(owner));
  await assert.rejects(app.assert(JSON.parse(body), body, signature), error => error.status === 401);

  await t.test('changing notes, app identity or signature fails verification', async () => {
    for (const mutation of ['body', 'app', 'signature']) {
      const next = await app.challenge(owner, keyId);
      const original = bodyFor(next.challenge);
      const sent = mutation === 'body' ? bodyFor(next.challenge, 'Altered instructions') : original;
      let signed = assertionFor({ body: original, privateKey: keys.privateKey, count: 2,
        bundle: mutation === 'app' ? 'malicious.app' : bundleIdentifier });
      if (mutation === 'signature') signed = Buffer.from('garbage').toString('base64');
      await assert.rejects(app.assert(JSON.parse(sent), sent, signed), error => error.status === 401);
    }
  });
  await t.test('fresh challenges cannot reuse an old signature counter', async () => {
    const next = await app.challenge(owner, keyId);
    const sent = bodyFor(next.challenge);
    await assert.rejects(app.assert(JSON.parse(sent), sent, assertionFor({ body: sent, privateKey: keys.privateKey, count: 1 })), error => error.status === 401);
  });
  await t.test('expired challenges cannot authorize model requests', async () => {
    const next = await app.challenge(owner, keyId);
    const name = `attest:challenge:${subjectHash(next.challenge)}`;
    await redis.del(name);
    const sent = bodyFor(next.challenge);
    await assert.rejects(app.assert(JSON.parse(sent), sent, assertionFor({ body: sent, privateKey: keys.privateKey, count: 2 })), error => error.status === 401);
  });
  await t.test('simultaneous replay permits exactly one request', async () => {
    const next = await app.challenge(owner, keyId);
    const sent = bodyFor(next.challenge);
    const signed = assertionFor({ body: sent, privateKey: keys.privateKey, count: 2 });
    const results = await Promise.allSettled([app.assert(JSON.parse(sent), sent, signed), app.assert(JSON.parse(sent), sent, signed)]);
    assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  });
  await t.test('re-registration cannot reset a key counter or replace its owner', async () => {
    const challenge = randomBytes(32).toString('base64url');
    const challengeKey = `attest:challenge:${subjectHash(challenge)}`;
    await redis.set(challengeKey, JSON.stringify({ keyId, subject: subjectHash('attacker'), purpose: 'register', expiresAt: Date.now() + 120000 }), { EX: 120 });
    await assert.rejects(app.register({ keyId, challenge, attestation: fakeAttestation }), error => error.status === 401);
    const record = await redis.hGetAll(`attest:key:${subjectHash(keyId)}`);
    assert.equal(record.counter, '2');
    assert.equal(record.subject, subjectHash(owner));
  });
  await t.test('production rejects development registration even if the verifier returns it', async () => {
    const dev = createAppAttest(redis, { bundleIdentifier, appIdPrefix, attestVerifier: options => ({ keyId: options.keyId, publicKey, environment: 'development' }) });
    const devKey = keyID();
    const pending = await dev.challenge(owner, devKey);
    await assert.rejects(dev.register({ keyId: devKey, challenge: pending.challenge, attestation: fakeAttestation }), error => error.status === 401);
  });
  await t.test('the real HTTP gate permits one model call and blocks its replay', async () => {
    let modelCalls = 0;
    const server = createPlanningServer({ appAttest: app, authorize: async () => owner, limit: async () => {},
      generate: async () => { modelCalls++; return { tasks: [] }; } });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const next = await app.challenge(owner, keyId);
      const sent = bodyFor(next.challenge);
      const signature = assertionFor({ body: sent, privateKey: keys.privateKey, count: 3 });
      const url = `http://127.0.0.1:${server.address().port}/v1/plan`;
      const request = () => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Attest-Assertion': signature }, body: sent });
      assert.equal((await request()).status, 200);
      assert.equal((await request()).status, 401);
      const unsigned = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: sent });
      assert.equal(unsigned.status, 401);
      assert.equal(modelCalls, 1);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
  await redis.del(`attest:key:${subjectHash(keyId)}`, `attest:registrations:${new Date().toISOString().slice(0, 10)}:${subjectHash(owner)}`);
});
