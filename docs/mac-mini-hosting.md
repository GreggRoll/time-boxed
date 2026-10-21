# Host Time Boxed on the Mac mini

This deployment runs the Node backend, a private Redis store, and a Cloudflare Tunnel in Docker. A small Cloudflare Worker with a Workers VPC Service can supply a stable `workers.dev` HTTPS hostname without buying a domain. A free ngrok hostname remains an alternative. OpenAI still runs GPT-6 Luna remotely. There is no Render or managed Redis subscription in this setup; OpenAI usage, electricity and internet service remain separate costs. Workers VPC is currently free during open beta.

## Current security model

Every model run requires all of the following:

1. An App Attest key certified by Apple for `J3YZVWSX7K.com.GregAdams.TimeBoxed` in the **production** environment.
2. A random, single-use challenge that expires after two minutes.
3. An App Attest assertion signing the exact request bytes, including its notes, purchase proof, key ID and challenge. The signature also binds `POST` and `/v1/plan`.
4. A counter greater than the previously accepted assertion, updated atomically in Redis.
5. An active Pro purchase independently verified with Apple's current server data, belonging to the same purchase identity as the attested key.
6. The per-purchase and service-wide usage limits. Requests are also throttled before Apple verification work.

Scripts, copied purchase tokens alone, forged headers and replays cannot pass these checks. There is no app-wide shared password, simulator bypass, or configuration flag to disable app verification. App Attest is not a guarantee against a compromised device abusing the genuine app; quotas still bound that risk. Devices without App Attest can use manual planning and supported on-device planning, but cannot bypass verification to use cloud generation. See [Apple's App Attest server validation](https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server).

App Attest public keys, receipts, purchase-identity hashes and counters are persistent Redis records. Planning notes are not written to Redis. Daily quota records expire after two days; short-lived challenge and ingress-throttle records expire after two minutes. App Attest enrollment records stay until retired or the datastore is cleared. Back up the Redis volume as sensitive service metadata, even though it contains no OpenAI or Apple API private keys.

## Secrets

The existing `backend/.env` holds the initial OpenAI and Apple credentials. The installer copies them once into `~/Library/Application Support/TimeBoxedHost/.env` for the running service; later installs preserve that runtime file. Rotate production credentials there, then recreate the backend container. Git ignores this file and its editor backups. `backend/.dockerignore` is an allowlist: the Docker build cannot copy `.env`, `.secrets`, local `node_modules`, Git history or backups. Runtime images copy only the application, installed dependencies and public Apple trust certificates.

Additional configuration:

```dotenv
APP_ATTEST_APP_ID_PREFIX=J3YZVWSX7K
APP_ATTEST_ENVIRONMENT=production
```

Confirm the prefix in **Apple Developer → Certificates, Identifiers & Profiles → Identifiers → Time Boxed**. It is usually your Team ID. The Compose production deployment explicitly requires the production App Attest environment. `REDIS_URL` is automatically set to the private Redis container. Keep `.env` mode `600`.

`~/Library/Application Support/TimeBoxedHost/.secrets/cloudflare-tunnel-token` holds the Cloudflare connector token after installation (the repository also contains an ignored, empty setup placeholder). Keep that directory mode `700` and its token file mode `600`; neither is committed or built into an image. The tunnel container runs with `HOST_UID`/`HOST_GID` (default `501`/`20`) so it can read this file without exposing it in command arguments. Set those two variables to the output of `id -u` and `id -g` when using another Mac user.

Do not share output from `docker inspect` or an unredacted `docker compose config`: those administrator tools can display runtime environment secrets. Use `docker compose config --quiet` to validate configuration without displaying it.

## Start locally

From the repository:

```sh
cd backend
docker compose config --quiet
docker compose up -d --build --wait
docker compose ps
```

There are **no host port mappings**, including for Redis. Check the service from inside its container:

```sh
docker compose exec -T backend node -e "fetch('http://127.0.0.1:3000/health').then(async r => { console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1) })"
```

`/health` returns only readiness. `/v1/plan` cannot run a model without the app assertion and verified Pro purchase. App setup endpoints never invoke OpenAI.

## Give the app a stable HTTPS address

### Cloudflare without buying a domain

The Cloudflare connection supports a free `workers.dev` Worker in front of a **Workers VPC Service** and the Mac's private Cloudflare Tunnel. This is the current Cloudflare setup: see [Cloudflare deployment](../backend/cloudflare/README.md) for resources, permissions, validation and rollback. Workers VPC is free on all Workers plans during its open beta; standard Workers plan limits still apply. It does not use a temporary Quick Tunnel address.

The configured app endpoint is `https://timeboxed-planning.timeboxed-greggroll.workers.dev/v1/plan`. Readiness is available at [`/health`](https://timeboxed-planning.timeboxed-greggroll.workers.dev/health). Public smoke checks verify a healthy Mac origin and rejection of unsigned/forged planning requests. Real-device App Attest and Pro validation are still required before a broad app release.

### Alternative: free ngrok hostname

The [ngrok Free plan](https://ngrok.com/docs/pricing-limits/free-plan-limits) includes one assigned hostname, automatic HTTPS, 20,000 HTTP requests/month and 1 GB outgoing transfer/month. The [assigned hostname remains yours while the account exists](https://ngrok.com/blog/free-static-domains-ngrok-users); the endpoint has no session timeout. Free service has usage caps and no production uptime guarantee. Requests stop when a quota is exhausted; monitor the dashboard before expanding to all paid users. No plan upgrade is performed by this setup.

An already-enrolled planning run normally makes **two requests** (challenge and plan). First enrollment normally makes four (challenge, registration, new challenge, plan). Thus 20,000 requests supports fewer than 10,000 planning runs/month after enrollment, health checks, failures and other traffic. OpenAI usage remains separate.

1. Create an account at [ngrok signup](https://dashboard.ngrok.com/signup) and stay on **Free**. Find your assigned domain and your agent authtoken in the dashboard.
2. Build the backend and run the login installer below. Then run this from the repository root in a local Terminal:

   ```sh
   backend/scripts/configure-ngrok.sh
   ```

3. Enter the assigned hostname (without `https://` or a path) and paste the authtoken at the hidden prompt. The script writes `~/Library/Application Support/TimeBoxedHost/.secrets/ngrok.yml` with mode `600`, validates it, and starts the ngrok profile. The token is never in Git, Docker image layers or command arguments. It is readable by administrators of this Mac.
4. Keep **Full Capture** disabled in ngrok dashboard settings. It is opt-in; leaving it off stores request metadata without full headers/bodies. Local inspection is disabled in the installed agent config. ngrok terminates public HTTPS and relays traffic through its encrypted tunnel, so it is also a service provider processing API traffic. See [Traffic Inspector privacy settings](https://ngrok.com/docs/obs/traffic-inspection).
5. Check `https://YOUR-ASSIGNED-HOSTNAME/health` from outside the network. Native API calls do not encounter the free plan's browser warning. For a browser health check, use `curl -H 'ngrok-skip-browser-warning: 1' https://YOUR-ASSIGNED-HOSTNAME/health`.
6. Set `PlanningAPIURL` in `TimeBoxed/Info.plist` to `https://YOUR-ASSIGNED-HOSTNAME/v1/plan`, then build the new app and perform the real-device checks below.

The login job detects the private ngrok config and starts it automatically. For a manual start:

```sh
cd "$HOME/Library/Application Support/TimeBoxedHost"
TRUST_PROXY=ngrok docker compose --profile ngrok up -d --wait
```

`TRUST_PROXY` selects the rate limiter's client-IP header. The ngrok mode uses only the **last** `X-Forwarded-For` entry that ngrok appends; caller-supplied earlier entries and Cloudflare headers are ignored. This setting is safe only with the private container ingress in this Compose file. There are no host port mappings or router port-forwarding requirements. App Attest and purchase checks remain mandatory regardless of the hostname or headers.

### Optional Cloudflare Tunnel with an existing domain

Use a domain you control, such as `api.your-domain.com`. A temporary Quick Tunnel hostname is not a production endpoint. Configure only one tunnel provider; remove the private ngrok config before choosing Cloudflare in the login job.

1. Add the domain to your Cloudflare account and complete its DNS setup.
2. In Cloudflare, choose **Networking → Tunnels → Create Tunnel**.
3. After installing the login service below, store the connector token (only the token value) in `~/Library/Application Support/TimeBoxedHost/.secrets/cloudflare-tunnel-token`. Do not put it in Git or paste it into chat.
4. Add a published application route: public hostname `api.your-domain.com`, service **HTTP**, URL **`backend:3000`**. The container hostname is `backend`, not `localhost`.
5. Start the connector:

   ```sh
   cd "$HOME/Library/Application Support/TimeBoxedHost"
   TRUST_PROXY=cloudflare docker compose --profile public up -d --wait
   ```

6. Verify `https://api.your-domain.com/health` from outside your network.
7. Set `PlanningAPIURL` in `TimeBoxed/Info.plist` to `https://api.your-domain.com/v1/plan`, then build the new app.

The API uses App Attest and Pro checks as its authentication. A browser-login Cloudflare Access policy would block normal iOS API calls, so do not add one to these API routes. Leave API responses uncached. Do not expose Redis or open inbound router ports. Cloudflare reaches the backend through an outbound tunnel. See [Cloudflare Tunnel setup](https://developers.cloudflare.com/tunnel/get-started/).

## App signing and real-device validation

The app includes the App Attest entitlement. Debug builds request the development environment; Release builds request production. Enable App Attest for the registered App ID and refresh the signing profile if Xcode reports that the entitlement is missing.

Use a physical device with a **TestFlight/App Store build** to validate against this production backend. App Attest is not available in Simulator. Xcode's local StoreKit purchase proofs are also intentionally rejected by the server. For development-device testing, use a separate private staging deployment configured for development App Attest; never relax the production service.

Before announcing cloud planning to paying users, verify registration, a successful plan, a repeated plan using the same key, and a restore/reinstall flow with a real App Store sandbox purchase. Tests exercise real P-256 assertion cryptography, exact request binding and Redis replay counters; they do not replace Apple's real-device attestation ceremony.

## Login startup and keeping the Mac awake

After the image is built:

```sh
backend/scripts/install-mac-host.sh
```

This installs runtime files under `~/Library/Application Support/TimeBoxedHost` and the startup job `~/Library/LaunchAgents/com.gregadams.timeboxed.backend.plist`. The runtime directory and credentials are private to your Mac user and outside the Git checkout. On login, it starts Docker Desktop, waits for the engine, starts the existing deployment, and keeps the Mac awake while on AC power with `caffeinate -s`. A private ngrok configuration starts the ngrok profile; otherwise a populated Cloudflare token starts the public profile. It does not rebuild images at login. Logs are under `~/Library/Logs/TimeBoxed/`.

A full reboot or power failure still requires signing in/unlocking FileVault before a per-user Docker Desktop deployment resumes. Container restart policies recover process crashes after Docker is running; Docker health status alone does not restart a hung process. Plan Mac updates and service recovery accordingly. The app's manual planner remains available during backend downtime.

To stop the login service:

```sh
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.gregadams.timeboxed.backend.plist"
```

To stop the containers without deleting data:

```sh
cd "$HOME/Library/Application Support/TimeBoxedHost"
docker compose --profile ngrok --profile public down
```

Do **not** use `down -v`: it deletes the persistent Redis volume and all enrolled App Attest keys. The app can re-enroll after a datastore loss, but that temporarily interrupts cloud planning.

## Tests and updates

```sh
cd backend
npm ci --ignore-scripts
npm test
docker compose --profile verify run --build --rm verification
```

The verification profile uses a separate disposable Redis container and no runtime secret file. It tests forged/mutated assertions, wrong purchase ownership, expired challenges, old counters, concurrent replay, re-registration, and production/development separation. Exactly one signed request in the HTTP replay test reaches the mocked model. Test runs spend no OpenAI credits.

For updates, review the changes and back up the Redis volume. Build the new image from the repository with `cd backend && docker compose build backend`, then rerun `backend/scripts/install-mac-host.sh` from the repository root to refresh runtime code and restart the login job. Existing runtime secrets are preserved. Use the manual startup commands above for your selected tunnel. Keep Docker Desktop and the Node/Redis/tunnel images updated; image tags in this setup track maintained release lines. An interrupted model response is not automatically retried, to avoid duplicate API spending.
