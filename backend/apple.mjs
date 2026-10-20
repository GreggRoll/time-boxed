import { readFileSync } from 'node:fs';
import { AppStoreServerAPIClient, Environment, SignedDataVerifier, Status, Type } from '@apple/app-store-server-library';
import { HttpError } from './errors.mjs';

const products = {
  monthly: 'com.GregAdams.TimeBoxed.pro.monthly',
  lifetime: 'com.GregAdams.TimeBoxed.pro.lifetime',
};
const denied = () => new HttpError(403, 'An active Pro purchase is required. Try restoring purchases.');

export function requireEnv(env, key) {
  if (!env[key]?.trim()) throw new Error(`Set the ${key} environment variable before starting the planning service.`);
  return env[key];
}

// Dependency injection lets tests exercise expired, refunded and grace-period purchases without Apple credentials.
export function createAuthorizer({ verifiers, clients, environments }) {
  return async function authorize(signedTransaction) {
    let proof, verifier, client;
    for (const environment of environments) {
      try {
        proof = await verifiers[environment].verifyAndDecodeTransaction(signedTransaction);
        verifier = verifiers[environment];
        client = clients[environment];
        break;
      } catch { /* Try only the explicitly configured Apple environments. Never trust unverified payloads. */ }
    }
    if (!proof?.transactionId || !proof.originalTransactionId || proof.revocationDate || proof.isUpgraded ||
        !Object.values(products).includes(proof.productId)) throw denied();

    if (proof.productId === products.lifetime) {
      // Re-fetch from Apple so an old signed purchase cannot bypass a later refund.
      const current = await client.getTransactionInfo(proof.transactionId);
      const transaction = await verifier.verifyAndDecodeTransaction(current.signedTransactionInfo);
      if (transaction.productId !== products.lifetime || transaction.type !== Type.NON_CONSUMABLE ||
          transaction.revocationDate || transaction.transactionId !== proof.transactionId ||
          transaction.originalTransactionId !== proof.originalTransactionId) throw denied();
    } else {
      const current = await client.getAllSubscriptionStatuses(proof.originalTransactionId);
      let active = false;
      for (const group of current.data ?? []) {
        for (const item of group.lastTransactions ?? []) {
          if (![Status.ACTIVE, Status.BILLING_GRACE_PERIOD].includes(item.status)) continue;
          const transaction = await verifier.verifyAndDecodeTransaction(item.signedTransactionInfo);
          if (transaction.productId !== products.monthly || transaction.type !== Type.AUTO_RENEWABLE_SUBSCRIPTION ||
              transaction.originalTransactionId !== proof.originalTransactionId || transaction.revocationDate || transaction.isUpgraded) continue;
          if (item.status === Status.ACTIVE && transaction.expiresDate > Date.now()) active = true;
          if (item.status === Status.BILLING_GRACE_PERIOD && item.signedRenewalInfo) {
            const renewal = await verifier.verifyAndDecodeRenewalInfo(item.signedRenewalInfo);
            if (renewal.originalTransactionId === proof.originalTransactionId && renewal.gracePeriodExpiresDate > Date.now()) active = true;
          }
        }
      }
      if (!active) throw denied();
    }
    return `${proof.environment}:${proof.originalTransactionId}`;
  };
}

export function createAppleAuthorizer(env) {
  const bundleId = requireEnv(env, 'APPLE_BUNDLE_ID');
  const appAppleId = Number(requireEnv(env, 'APPLE_APP_ID'));
  if (!Number.isSafeInteger(appAppleId) || appAppleId <= 0) throw new Error('APPLE_APP_ID must be the numeric app ID from App Store Connect.');
  const privateKey = requireEnv(env, 'APPLE_PRIVATE_KEY').replaceAll('\\n', '\n');
  const keyId = requireEnv(env, 'APPLE_KEY_ID');
  const issuerId = requireEnv(env, 'APPLE_ISSUER_ID');
  // Production also accepts real App Store sandbox purchases for TestFlight/App Review.
  // Sandbox-only instances cannot accept production proofs. Xcode local StoreKit proofs are never accepted.
  const environments = env.APPLE_ENVIRONMENT === 'Sandbox' ? [Environment.SANDBOX] : [Environment.PRODUCTION, Environment.SANDBOX];
  const roots = ['AppleRootCA-G2.cer', 'AppleRootCA-G3.cer'].map(name => readFileSync(new URL(`./certs/${name}`, import.meta.url)));
  const verifiers = {}, clients = {};
  for (const environment of environments) {
    verifiers[environment] = new SignedDataVerifier(roots, true, environment, bundleId, appAppleId);
    clients[environment] = new AppStoreServerAPIClient(privateKey, keyId, issuerId, bundleId, environment);
  }
  return createAuthorizer({ verifiers, clients, environments });
}
