# Cloudflare ingress for the Mac mini

The public `workers.dev` URL is a small proxy. It connects to one **Workers VPC Service**, which connects through the private `timeboxed-mac-mini` tunnel to `http://backend:3000` in Docker. No purchased domain, router port forwarding, or public Redis port is required.

Configured endpoint: **https://timeboxed-planning.timeboxed-greggroll.workers.dev/v1/plan**. Readiness: **https://timeboxed-planning.timeboxed-greggroll.workers.dev/health**. Resource IDs and bindings are recorded in `deployment.json`.

The Mac backend still verifies App Attest and current Pro entitlements before invoking OpenAI. The Worker has no OpenAI key, Apple private key, or static app password. It preserves the exact signed request bytes, forwards only API headers, allows only the four known routes, and never follows redirects or retries. Public health checks reach the actual Mac backend.

Workers VPC is [free on all Workers plans during open beta](https://developers.cloudflare.com/workers-vpc/). Standard [Workers Free request/CPU limits](https://developers.cloudflare.com/workers/platform/limits/) still apply. This setup does not upgrade the account or agree to paid billing. OpenAI usage is billed separately. Review beta availability and pricing before a broad production launch.

`deployment.json` records non-secret resource IDs and the Worker upload metadata. The `PLANNING_BACKEND` binding must have type `vpc_service` and the created service ID. Create the VPC HTTP service with this shape, substituting the recorded tunnel ID:

```json
{
  "name": "timeboxed-planning-backend",
  "type": "http",
  "host": {
    "hostname": "backend",
    "resolver_network": { "tunnel_id": "TUNNEL_ID" }
  },
  "http_port": 3000
}
```

The account's Workers subdomain and the Worker's `workers.dev` route must be enabled. Deploy `worker.mjs` as a module using `metadata` from `deployment.json` through the Cloudflare API's multipart Worker upload. Workers/VPC resource management needs `workers-scripts.read`, `workers-scripts.write`, `connectivity-directory.read`, `connectivity-directory.admin`, and `connectivity-directory.bind`, in addition to Tunnel read/write permissions.

Store the tunnel connector token only in `~/Library/Application Support/TimeBoxedHost/.secrets/cloudflare-tunnel-token`, mode `600`. The startup job automatically enables the Cloudflare profile when that file is populated (and no ngrok config exists). The Docker tunnel container can resolve the private `backend` hostname. No public-hostname DNS record is needed for this VPC route; the tunnel's catch-all public ingress returns 404.

```sh
cd "$HOME/Library/Application Support/TimeBoxedHost"
TRUST_PROXY=cloudflare docker compose --profile public up -d --wait
```

Before setting `PlanningAPIURL` in the app, verify public `/health` returns 200, an unsigned `/v1/plan` returns 401, and unknown routes return 404. Complete real-device App Attest and sandbox Pro enrollment before releasing cloud planning to all paid users. A successful health check does not verify Apple's enrollment ceremony.

Deployment verification completed: valid public HTTPS, health 200, unsigned and forged-assertion planning calls 401, unknown/query-modified routes 404, wrong method 405, and all responses `Cache-Control: no-store`. No authorized model call was made by these checks. The iOS Simulator build succeeds and its bundled `PlanningAPIURL` points to the configured endpoint. Physical-device enrollment and a successful real Pro planning request remain release checks.

Rollback: disable this Worker's `workers.dev` route and stop only the tunnel connector. Preserve the private backend, Redis volume and credential files. The app's manual planner remains usable while cloud planning is unavailable.
