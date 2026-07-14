# ChickenDog Flow

API-only image workflow UI deployed on Vercel. It uses ChickenDog SSO and the user's managed image-group API key to call GPT Image and Grok through sub2api. Provider keys are never exposed to browser JavaScript.

## Required Vercel environment variables

```text
COMFY_SESSION_SECRET=<at least 32 random characters>
MAIN_APP_ORIGIN=https://chickendog.cc
COMFY_PUBLIC_ORIGIN=https://comfyui-chi.vercel.app
SUB2API_BASE_URL=https://chickendog.cc
SUB2API_IMAGE_GROUP_ID=14
OPENAI_IMAGE_MODEL=gpt-image-2
OPENAI_IMAGE_MODELS=gpt-image-1,gpt-image-1.5,gpt-image-2,grok-2-image,grok-imagine-image,grok-imagine-image-quality
```

Set `COMFY_SESSION_SECRET` for Production, Preview, and Development in Vercel. Use a different secret from the main site's JWT secret.

## Login flow

1. The authenticated main site sends its bearer token to `POST /api/sso/start`.
2. The Vercel function validates the user with sub2api and provisions a dedicated `Comfy API` key in image group 14.
3. A 60-second encrypted login ticket redirects the browser to `/api/auth/callback`.
4. The callback sets a 12-hour `HttpOnly`, `Secure`, `SameSite=Lax` session cookie.
5. Image requests go through `/api/images/generate`; the browser never receives the managed API key.

## Local checks

```bash
npm run check
npm test
```

Use `vercel dev` when testing the serverless routes locally.
