import { createHash } from 'node:crypto';
import { HttpError } from './errors.mjs';

// Atomic counters survive service restarts and apply across replicas. Only hashed purchase IDs are stored.
export function createLimiter(redis, { dailyLimit = 30, globalDailyLimit = 10000 } = {}) {
  return async function limit(subject, now = new Date()) {
    if (!redis.isReady) throw new HttpError(503, 'Cloud planning is temporarily unavailable.');
    const day = now.toISOString().slice(0, 10);
    const hash = createHash('sha256').update(subject).digest('hex');
    const count = await redis.eval(`
      local count = redis.call('INCR', KEYS[1])
      if count == 1 then redis.call('EXPIRE', KEYS[1], 172800) end
      return count
    `, { keys: [`planning:daily:${day}:${hash}`], arguments: [] });
    if (Number(count) > dailyLimit) throw new HttpError(429, 'Daily planning limit reached. Try again tomorrow.');
    const global = await redis.eval(`
      local count = redis.call('INCR', KEYS[1])
      if count == 1 then redis.call('EXPIRE', KEYS[1], 172800) end
      return count
    `, { keys: [`planning:global:${day}`], arguments: [] });
    if (Number(global) > globalDailyLimit) throw new HttpError(429, 'Cloud planning is busy. Please try again tomorrow.');
  };
}

// Apply before any Apple verification work. Hash addresses; never log them or trust arbitrary proxy headers.
export function createIngressLimiter(redis, { requestsPerMinute = 60, globalRequestsPerMinute = 3000 } = {}) {
  return async function checkIngress(address) {
    if (!redis.isReady) throw new HttpError(503, 'Cloud planning is temporarily unavailable.');
    const minute = Math.floor(Date.now() / 60_000);
    for (const [identity, maximum] of [[subjectHashForLimit(address), requestsPerMinute], ['global', globalRequestsPerMinute]]) {
      const count = await redis.eval(`
        local count = redis.call('INCR', KEYS[1])
        if count == 1 then redis.call('EXPIRE', KEYS[1], 120) end
        return count
      `, { keys: [`planning:ingress:${minute}:${identity}`], arguments: [] });
      if (Number(count) > maximum) throw new HttpError(429, 'Too many requests. Please try again shortly.');
    }
  };
}
function subjectHashForLimit(value) { return createHash('sha256').update(value).digest('hex'); }
