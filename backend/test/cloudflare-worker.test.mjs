import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../cloudflare/worker.mjs';

test('Cloudflare ingress preserves exact signed bytes and assertion for one fixed private service', async () => {
  const body = Buffer.from('{ "brainDump": "Dogs 🐕 at 21:00", "transaction": "signed.proof.value" }\n');
  let calls = 0;
  const response = await worker.fetch(new Request('https://planning.example/v1/plan', {
    method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-App-Attest-Assertion': 'assertion',
      'CF-Connecting-IP': '203.0.113.5', 'X-Forwarded-For': 'attacker-supplied', Cookie: 'private', Authorization: 'unwanted' },
  }), { PLANNING_BACKEND: { fetch: async (request, options) => {
    calls++;
    assert.equal(request.url, 'http://backend:3000/v1/plan');
    assert.equal(request.method, 'POST');
    assert.deepEqual(Buffer.from(await request.arrayBuffer()), body);
    assert.equal(request.headers.get('X-App-Attest-Assertion'), 'assertion');
    assert.equal(request.headers.get('CF-Connecting-IP'), '203.0.113.5');
    for (const name of ['Cookie', 'Authorization', 'X-Forwarded-For']) assert.equal(request.headers.get(name), null);
    assert.equal(options.redirect, 'manual');
    return Response.json({ tasks: [] });
  } } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), { tasks: [] });
  assert.equal(calls, 1);
});

test('Cloudflare ingress rejects arbitrary paths, queries, methods, insecure requests and oversized bodies', async () => {
  const env = { PLANNING_BACKEND: { fetch: () => assert.fail('Must not reach the private network') } };
  const cases = [
    ['https://planning.example/admin', {}, 404],
    ['https://planning.example/v1/plan?target=http://other.local', {}, 404],
    ['https://planning.example/v1/plan', {}, 405],
    ['http://planning.example/v1/plan', {}, 400],
    ['https://planning.example/v1/plan', { method: 'POST', body: '{}' }, 415],
    ['https://planning.example/v1/plan', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '48001' } }, 413],
  ];
  for (const [url, init, status] of cases) assert.equal((await worker.fetch(new Request(url, init), env)).status, status);
});

test('Cloudflare ingress preserves auth errors and rejects redirects without retrying', async () => {
  for (const status of [401, 403, 429, 302]) {
    let calls = 0;
    const response = await worker.fetch(new Request('https://planning.example/v1/plan', {
      method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' },
    }), { PLANNING_BACKEND: { fetch: async () => {
      calls++;
      return new Response('{}', { status, headers: { Location: 'https://elsewhere.example' } });
    } } });
    assert.equal(response.status, status === 302 ? 502 : status);
    assert.equal(response.headers.get('Location'), null);
    assert.equal(calls, 1);
  }
});

test('Cloudflare health checks reflect the Mac backend readiness', async () => {
  const response = await worker.fetch(new Request('https://planning.example/health'), {
    PLANNING_BACKEND: { fetch: async request => {
      assert.equal(request.url, 'http://backend:3000/health');
      return Response.json({ ok: false }, { status: 503 });
    } },
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false });
});
