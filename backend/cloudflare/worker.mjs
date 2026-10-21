// Public HTTPS ingress only. Apple verification and OpenAI credentials stay on the Mac.
const routes = new Map([
  ['/health', 'GET'], ['/v1/attest/challenge', 'POST'],
  ['/v1/attest/register', 'POST'], ['/v1/plan', 'POST'],
]);
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const failure = (status, error) => new Response(JSON.stringify({ error }), { status, headers });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.protocol !== 'https:') return failure(400, 'Use HTTPS.');
    const method = routes.get(url.pathname);
    if (!method || url.search) return failure(404, 'Not found.');
    if (request.method !== method) return failure(405, `Use ${method}.`);
    if (method === 'POST' && !request.headers.get('Content-Type')?.startsWith('application/json')) {
      return failure(415, 'Use application/json.');
    }
    const size = request.headers.get('Content-Length');
    if (size && (!/^\d+$/.test(size) || Number(size) > (url.pathname === '/v1/attest/register' ? 100_000 : 48_000))) {
      return failure(413, 'Request is too large.');
    }
    try {
      // Fixed VPC service; preserve exact signed bytes. Never parse or serialize notes here.
      const upstream = new Request(`http://backend:3000${url.pathname}`, request);
      for (const name of [...upstream.headers.keys()]) upstream.headers.delete(name);
      for (const name of ['Content-Type', 'X-App-Attest-Assertion']) {
        const value = request.headers.get(name);
        if (value) upstream.headers.set(name, value);
      }
      // Cloudflare supplies this at ingress. Ignore caller-supplied forwarding headers.
      const client = request.headers.get('CF-Connecting-IP');
      if (client) upstream.headers.set('CF-Connecting-IP', client);
      // Redirects could disclose proofs. Never follow or retry a model request.
      const response = await env.PLANNING_BACKEND.fetch(upstream, { redirect: 'manual' });
      if (response.status >= 300 && response.status < 400) return failure(502, 'Cloud planning is temporarily unavailable.');
      return new Response(response.body, { status: response.status, headers });
    } catch {
      // Never log notes, proofs, headers, secrets, or upstream error bodies.
      console.error(JSON.stringify({ event: 'planning_origin_unavailable' }));
      return failure(503, 'Cloud planning is temporarily unavailable. Please try again.');
    }
  },
};
