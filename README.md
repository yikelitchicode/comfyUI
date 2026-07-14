# ComfyUI on Cloudflare with GPT Image 2

This repository runs the official ComfyUI browser interface without Python,
PyTorch, a GPU, checkpoints, or custom-node execution. The only executable node
is `GPT Image 2`, backed by the OpenAI-compatible ChickenDog endpoint at
`https://chickendog.cc/v1/images/generations`.

The frontend build is the official
[`Comfy-Org/ComfyUI_frontend`](https://github.com/Comfy-Org/ComfyUI_frontend)
`v1.48.2` release. Its archive is pinned by SHA-256 and downloaded during the
Pages build. The original
[`comfy-org/comfyui`](https://github.com/comfy-org/comfyui) repository remains
the upstream protocol reference, but its Python inference engine is deliberately
not copied or deployed.

## Architecture

```text
Browser
  |  official ComfyUI static UI
  v
Cloudflare Pages
  |  /api/* and /ws via Pages Functions service binding
  v
Cloudflare Worker (not exposed on workers.dev)
  |  one Durable Object per opaque browser session
  +-- WebSocket status and execution events
  +-- SQLite queue, settings, and the latest 100 jobs
  +-- alarm-driven serial job execution
  |
  +--> ChickenDog.cc/v1/images/generations (gpt-image-2 only)
  |
  +--> R2 (generated image bytes)
```

Pages serves static assets without invoking a Function. `_routes.json` sends
only `/api/*` and `/ws` through the service binding, which keeps request usage
predictable. The ChickenDog API key exists only as a Worker secret.

## Supported ComfyUI API

The adapter implements the small protocol surface required by the official UI:

- `/api/object_info`, `/api/prompt`, `/api/jobs`, `/api/queue`, `/api/history`
- `/api/view`, `/api/settings`, `/api/system_stats`, `/api/extensions`
- `/ws` with `status`, `execution_start`, `executing`, `executed`,
  `execution_success`, and `execution_error` events

Unknown nodes are rejected. A prompt must contain exactly one `GPTImage2` node;
the model is forced to `gpt-image-2` server-side regardless of browser input.

## Local checks

Node.js 20 or newer is required.

```bash
npm install
npm run check
npm test
npm run build
```

The frontend archive is about 20 MB and the extracted `dist/` directory is not
committed. For Worker development, create `.dev.vars`:

```text
CHICKENDOG_API_KEY=your_chickendog_key
```

Then run `npm run dev:worker`. A complete same-origin local UI requires either a
Pages preview deployment or a local proxy that sends `/api/*` and `/ws` to that
Worker.

## Cloudflare deployment

Create both production and local-preview R2 buckets once:

```bash
npx wrangler r2 bucket create comfyui-images
npx wrangler r2 bucket create comfyui-images-preview
```

Store the provider credential and deploy the Worker first:

```bash
npx wrangler secret put CHICKENDOG_API_KEY --config wrangler.worker.jsonc
npm run deploy:worker
```

Create the Pages project once, then deploy the pinned official frontend and its
two proxy Functions:

```bash
npx wrangler pages project create comfyui-gpt-image
npm run deploy:pages
```

`wrangler.jsonc` binds `API` to the `comfyui-gpt-image-api` Worker. If the
Cloudflare account uses a different service or Pages project name, change those
two config files together.

After the Pages hostname is known, set `ALLOWED_ORIGIN` in
`wrangler.worker.jsonc` to its exact origin and redeploy. This is an origin
check, not user authentication. Before exposing a provider-funded deployment,
protect the Pages hostname with Cloudflare Access or an equivalent identity
policy; otherwise anyone can spend the ChickenDog API quota.

## Storage and retention

Each browser session has an independent Durable Object and serial queue. A
session can hold three pending jobs by default. SQLite retains the latest 100
terminal jobs and R2 objects; older rows and images are deleted together. These
limits are controlled by `MAX_QUEUE` and `MAX_HISTORY`.

Cloudflare free allowances and pricing can change. R2 currently documents 10
GB-month of Standard storage, one million Class A operations, ten million Class
B operations per month, and free Internet egress. Durable Object and Workers
usage are billed separately, and GPT Image generation is never included in
Cloudflare's free tier. Confirm current limits before production rollout:

- <https://developers.cloudflare.com/durable-objects/platform/pricing/>
- <https://developers.cloudflare.com/r2/pricing/>

## Upstream updates

To update the UI, change `FRONTEND_VERSION`, `FRONTEND_URL`, and
`FRONTEND_SHA256` in `scripts/fetch-frontend.mjs`, then run the full checks and a
browser smoke test. ComfyUI frontend protocol changes can require matching
updates in `src/worker.js`; do not float to `latest` during builds.

The official frontend is GPL-3.0-only. Its release archive includes the upstream
license and credit files in `dist/`.
