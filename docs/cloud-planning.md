# Cloud planning with GPT-6 Luna

The iOS app calls a small Node backend. The backend verifies the user's Pro purchase with Apple, enforces shared daily limits in Redis, and asks `gpt-6-luna` to extract tasks using a strict JSON schema. Scheduling remains in Swift. Cloud planning works on the app's iOS 17+ deployment target without requiring Apple Intelligence.

## Where to put the OpenAI key

For local backend development, put it in **`backend/.env`**:

```dotenv
OPENAI_API_KEY=your-key-here
```

The local file has been created with empty secret fields and is ignored by Git. New checkouts can copy `backend/.env.example` to `backend/.env`. Do not put the key in Swift, Info.plist, an Xcode build setting, the web prototype's `NEXT_PUBLIC_*` variables, or chat. The iOS app only needs the public backend endpoint.

For the hosted app, add the same value in **Render → time-boxed-planning → Environment → OPENAI_API_KEY**. Your local `.env` is not uploaded to Render.

## Hosting options

For the Mac mini deployment with Docker, private Redis, Cloudflare Tunnel and mandatory App Attest, use [Mac mini hosting](mac-mini-hosting.md). This is the current deployment path.

## Optional managed hosting: Render

Use the root `render.yaml` Blueprint to create a Node web service and a private Render Key Value instance. The Blueprint selects paid, persistent service plans; Render shows their charges before creation. The persistent store keeps usage counters across service restarts. It contains hashed purchase identifiers and counters, not brain dumps.

1. Make this code available on the Git branch you want to deploy.
2. In Render, choose **New → Blueprint**, connect this repository and branch, and use `render.yaml`.
3. Supply the secret environment variables when prompted. `OPENAI_API_KEY` is your OpenAI project key. The Apple fields below are separate credentials for checking Pro purchases.
4. Review the resources and costs, then deploy. The web service runs `npm ci --ignore-scripts && npm test`, then `npm start`. The Blueprint disables automatic deploys so later repository pushes do not immediately change production.
5. Visit `https://<your-service>.onrender.com/health`. It should return `{"ok":true}`.
6. Set **`PlanningAPIURL`** in `TimeBoxed/Info.plist` to **`https://<your-service>.onrender.com/v1/plan`**, then rebuild the iOS app. Leave the OpenAI key out of this file.

Render manages HTTPS. Both services use the same region and the Key Value URL is injected automatically as `REDIS_URL`. See [Render web services](https://render.com/docs/web-services), [Blueprint configuration](https://render.com/docs/blueprint-spec), and [Key Value](https://render.com/docs/key-value).

The backend now also requires `APP_ATTEST_APP_ID_PREFIX` and production App Attest request signatures. The Mac mini guide describes enrollment and real-device testing; unsigned clients cannot call `/v1/plan`.

## Apple purchase verification

Create an **In-App Purchase key** in **App Store Connect → Users and Access → Integrations → Keys → In-App Purchase**. This is different from the App Store Connect API key used to upload TestFlight builds. Download the `.p8` file and keep it private. Apple's [key-generation instructions](https://developer.apple.com/help/app-store-connect/configure-in-app-purchase-settings/generate-keys-for-in-app-purchases/) describe the process.

Set these backend environment variables:

| Variable | Value |
| --- | --- |
| `APPLE_ISSUER_ID` | Issuer ID shown in App Store Connect |
| `APPLE_KEY_ID` | The In-App Purchase key's ID |
| `APPLE_PRIVATE_KEY` | Full contents of its `.p8` file, including BEGIN/END lines |
| `APPLE_BUNDLE_ID` | `com.GregAdams.TimeBoxed` |
| `APPLE_APP_ID` | `6762071236` — confirm this is the app's numeric Apple ID |
| `APPLE_ENVIRONMENT` | `Production` for App Store, TestFlight, and App Review; `Sandbox` for a sandbox-only instance |

For a local `.env`, put `APPLE_PRIVATE_KEY` in double quotes and use literal `\n` between PEM lines. Render's environment editor accepts the complete multiline value. The two public Apple root certificates in `backend/certs/` are downloaded from [Apple PKI](https://www.apple.com/certificateauthority/); they are not private keys.

The backend verifies Apple's JWS signature and app identity, then requests the current purchase or subscription status from Apple. Refunded lifetime purchases and expired or revoked subscriptions are denied. Signed billing grace periods are supported. Production accepts Apple's sandbox environment for TestFlight and App Review; it never accepts Xcode's local StoreKit signatures.

## Limits and privacy

The defaults allow **30 planning attempts per purchase per UTC day**, with an overall ceiling of **10,000 attempts per UTC day** across the service. Adjust `PLANNING_DAILY_LIMIT` and `PLANNING_GLOBAL_DAILY_LIMIT` in Render. Attempts that reach the model, including upstream failures, count toward the limit. Redis failures stop generation instead of bypassing quotas.

The app asks permission before sending a brain dump to OpenAI. It sends only the current notes and signed purchase proof to the backend. Only the notes go to OpenAI. Other days, calendar contents, and reminder contents are not sent. The app also offers explicit on-device Apple Intelligence planning on supported devices; it does not silently switch providers.

The backend does not log notes, keys, or purchase proofs. It uses `store: false` for Responses requests; this does not disable OpenAI's standard abuse-monitoring retention. Review [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data). The updated local privacy page in `docs/index.html` should be published alongside the cloud-enabled release, and App Store privacy disclosures should reflect the new processing.

## Local checks

With Node 22+:

```sh
cd backend
npm ci --ignore-scripts
npm test
```

To run the real service locally, fill the required variables in `backend/.env`, provide a Redis instance via `REDIS_URL`, and run `npm start` from `backend`. Use a trusted HTTPS endpoint or tunnel to connect the iOS app; the app intentionally requires HTTPS.

Backend tests use mocked OpenAI and Apple responses. iOS tests cover the HTTP contract, overflow priorities, expanded daily hours, and persistence across day switches. These tests do not spend API credits.

Before shipping, exercise a real App Store sandbox/TestFlight Pro purchase against the deployed service with local StoreKit configuration set to **None**. Check representative brain dumps for task completeness, priorities, and exact times; live Luna quality and account access still need verification with the configured key. Every AI task currently receives 30 minutes, up to 24 distinct tasks per request. Tasks that cannot fit remain priorities and stay in the original notes.
