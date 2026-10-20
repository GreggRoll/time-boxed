import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import cbor from 'cbor';
import { verifyAttestation, verifyAssertion } from 'node-app-attest';
import { HttpError } from './errors.mjs';
import { requireEnv } from './apple.mjs';

export const subjectHash = subject => createHash('sha256').update(subject).digest('hex');
export const signedPlanPayload = body => Buffer.concat([Buffer.from('POST\n/v1/plan\n'), body]);
const denied = () => new HttpError(401, 'App verification failed. Open Time Boxed and try again.');
const keyName = keyId => `attest:key:${subjectHash(keyId)}`;
const challengeName = challenge => `attest:challenge:${subjectHash(challenge)}`;

function base64(value, maxBytes) {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw denied();
  const data = Buffer.from(value, 'base64');
  if (data.length > maxBytes || data.toString('base64') !== value) throw denied();
  return data;
}
function validateKeyId(keyId) { if (base64(keyId, 32).length !== 32) throw denied(); }
function decodeObject(bytes) {
  const values = cbor.decodeAllSync(bytes, { max_depth: 12 });
  if (values.length !== 1 || !values[0] || typeof values[0] !== 'object') throw denied();
  return values[0];
}

// These checks supplement the verifier: certificate validity dates, exact CBOR framing and field bounds.
export function verifyAppleAttestation(options) {
  const decoded = decodeObject(options.attestation);
  const certificates = decoded.attStmt?.x5c;
  if (!Array.isArray(certificates) || certificates.length !== 2 || !Buffer.isBuffer(decoded.authData) || decoded.authData.length < 87) throw denied();
  const now = Date.now();
  for (const der of certificates) {
    if (!Buffer.isBuffer(der)) throw denied();
    const cert = new X509Certificate(der);
    if (Date.parse(cert.validFrom) > now || Date.parse(cert.validTo) < now) throw denied();
  }
  if (new X509Certificate(certificates[0]).ca || !new X509Certificate(certificates[1]).ca) throw denied();
  if (decoded.authData.readUInt16BE(53) !== 32) throw denied();
  return verifyAttestation(options);
}
export function verifyAppleAssertion(options) {
  const decoded = decodeObject(options.assertion);
  if (!Buffer.isBuffer(decoded.signature) || decoded.signature.length > 256 ||
      !Buffer.isBuffer(decoded.authenticatorData) || decoded.authenticatorData.length < 37 || decoded.authenticatorData.length > 4096) throw denied();
  return verifyAssertion(options);
}

export function createAppAttest(redis, { bundleIdentifier, appIdPrefix, environment = 'production',
  attestVerifier = verifyAppleAttestation, assertionVerifier = verifyAppleAssertion } = {}) {
  if (!bundleIdentifier || !appIdPrefix || !['production', 'development'].includes(environment)) throw new Error('Configure the App Attest app identity and environment.');
  function ready() { if (!redis.isReady) throw new HttpError(503, 'App verification is temporarily unavailable.'); }
  async function consume(challenge, keyId, purpose) {
    ready();
    validateKeyId(keyId);
    if (typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw denied();
    const value = await redis.getDel(challengeName(challenge));
    if (!value) throw denied();
    const record = JSON.parse(value);
    if (record.keyId !== keyId || record.purpose !== purpose || record.expiresAt <= Date.now()) throw denied();
    return record;
  }
  return {
    async challenge(subject, keyId) {
      ready();
      validateKeyId(keyId);
      const owner = subjectHash(subject);
      const key = await redis.hGetAll(keyName(keyId));
      const registered = !!key.publicKey;
      if (registered && (key.subject !== owner || key.environment !== environment)) throw denied();
      const challenge = randomBytes(32).toString('base64url');
      const result = await redis.set(challengeName(challenge), JSON.stringify({ keyId, subject: owner,
        purpose: registered ? 'plan' : 'register', expiresAt: Date.now() + 120_000 }), { EX: 120, NX: true });
      if (result !== 'OK') throw new HttpError(503, 'App verification is temporarily unavailable.');
      return { challenge, registered };
    },
    async register({ keyId, challenge, attestation }) {
      const proof = await consume(challenge, keyId, 'register');
      const bytes = base64(attestation, 64_000);
      let verified;
      try {
        verified = await attestVerifier({ attestation: bytes, challenge, keyId, bundleIdentifier,
          teamIdentifier: appIdPrefix, allowDevelopmentEnvironment: environment === 'development' });
      } catch { throw denied(); }
      if (verified.keyId !== keyId || verified.environment !== environment || !verified.publicKey) throw denied();
      // Registration is insert-only. Re-registering must never reset a key's replay counter or change its owner.
      const result = await redis.eval(`
        if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
        local count = redis.call('INCR', KEYS[2])
        if count == 1 then redis.call('EXPIRE', KEYS[2], 172800) end
        if count > 5 then return -1 end
        redis.call('HSET', KEYS[1], 'subject', ARGV[1], 'publicKey', ARGV[2], 'counter', '0', 'environment', ARGV[3], 'receipt', ARGV[4])
        return 1
      `, { keys: [keyName(keyId), `attest:registrations:${new Date().toISOString().slice(0, 10)}:${proof.subject}`],
        arguments: [proof.subject, verified.publicKey, environment, verified.receipt?.toString('base64') ?? ''] });
      if (Number(result) === -1) throw new HttpError(429, 'App setup limit reached. Please try again tomorrow.');
      if (Number(result) !== 1) throw denied();
    },
    async assert({ keyId, challenge }, rawBody, assertion) {
      const proof = await consume(challenge, keyId, 'plan');
      const key = await redis.hGetAll(keyName(keyId));
      if (!key.publicKey || key.subject !== proof.subject || key.environment !== environment) throw denied();
      let verified;
      try {
        verified = await assertionVerifier({ assertion: base64(assertion, 8192), payload: signedPlanPayload(rawBody),
          publicKey: key.publicKey, bundleIdentifier, teamIdentifier: appIdPrefix, signCount: Number(key.counter) });
      } catch { throw denied(); }
      if (!Number.isSafeInteger(verified.signCount) || verified.signCount <= Number(key.counter) || verified.signCount > 0x7fffffff) throw denied();
      // Atomic compare-and-set prevents concurrent requests from reusing the same counter.
      const updated = await redis.eval(`
        local old = redis.call('HGET', KEYS[1], 'counter')
        if not old or tonumber(old) ~= tonumber(ARGV[1]) or tonumber(ARGV[2]) <= tonumber(old) then return 0 end
        redis.call('HSET', KEYS[1], 'counter', ARGV[2])
        return 1
      `, { keys: [keyName(keyId)], arguments: [key.counter, String(verified.signCount)] });
      if (Number(updated) !== 1) throw denied();
      return proof.subject;
    },
  };
}

export function appAttestFromEnv(redis, env) {
  return createAppAttest(redis, {
    bundleIdentifier: requireEnv(env, 'APPLE_BUNDLE_ID'),
    appIdPrefix: requireEnv(env, 'APP_ATTEST_APP_ID_PREFIX'),
    environment: env.APP_ATTEST_ENVIRONMENT ?? 'production',
  });
}
