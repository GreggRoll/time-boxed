import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createClient } from 'redis';
import { createAppleAuthorizer, requireEnv } from './apple.mjs';
import { extractTasks } from './planner.mjs';
import { createLimiter } from './limits.mjs';
import { HttpError } from './errors.mjs';

function send(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(body));
}

export function createPlanningServer({ authorize, limit, generate, ready = () => true }) {
  return createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/health') {
        send(response, ready() ? 200 : 503, { ok: ready() });
        return;
      }
      if (request.url !== '/v1/plan') throw new HttpError(404, 'Not found.');
      if (request.method !== 'POST') throw new HttpError(405, 'Use POST.');
      if (!request.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Use application/json.');
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 48_000) throw new HttpError(413, 'Request is too large.');
        chunks.push(chunk);
      }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new HttpError(400, 'Invalid JSON.'); }
      if (!input || typeof input.brainDump !== 'string' || !input.brainDump.trim() || Array.from(input.brainDump).length > 4000) {
        throw new HttpError(400, 'Add a brain dump of up to 4,000 characters.');
      }
      if (typeof input.transaction !== 'string' || input.transaction.length > 24_000 || input.transaction.split('.').length !== 3) {
        throw new HttpError(401, 'A signed Pro purchase is required.');
      }
      const subject = await authorize(input.transaction);
      await limit(subject);
      const result = await generate(input.brainDump);
      send(response, 200, result);
    } catch (error) {
      // Never log notes, purchase proofs, API keys, or upstream error bodies.
      send(response, error instanceof HttpError ? error.status : 503,
        { error: error instanceof HttpError ? error.message : 'Cloud planning is temporarily unavailable. Please try again.' });
    }
  });
}

export async function start(env = process.env) {
  const apiKey = requireEnv(env, 'OPENAI_API_KEY');
  const authorize = createAppleAuthorizer(env);
  const redis = createClient({ url: requireEnv(env, 'REDIS_URL'), disableOfflineQueue: true, socket: { connectTimeout: 5000 } });
  redis.on('error', () => console.error('Planning quota store is unavailable.'));
  await redis.connect();
  function positiveInt(key, fallback) {
    const value = Number(env[key] ?? fallback);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer.`);
    return value;
  }
  const limit = createLimiter(redis, {
    dailyLimit: positiveInt('PLANNING_DAILY_LIMIT', 30),
    globalDailyLimit: positiveInt('PLANNING_GLOBAL_DAILY_LIMIT', 10000),
  });
  const server = createPlanningServer({ authorize, limit, generate: brainDump => extractTasks(brainDump, { apiKey }), ready: () => redis.isReady });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.listen(positiveInt('PORT', 3000), '0.0.0.0', () => console.log('Time Boxed planning service is ready.'));
  process.on('SIGTERM', () => server.close(() => { redis.destroy(); process.exit(0); }));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch(() => { console.error('Planning service could not start. Check required environment variables and Redis connectivity.'); process.exit(1); });
}
