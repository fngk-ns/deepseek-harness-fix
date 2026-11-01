# @deepseek-ai/dsh-ai-route-account

Signs the harness in to **AI Route** (`https://aiapi.hoj.kr`) with OAuth 2.0 Authorization Code + PKCE and keeps the
grant (access + refresh token) in the credential store under `ai-route-account/default`.

- `startSignIn(callbackOrigin)` opens one attempt: it registers `/oauth/ai-route/callback` on the Host loopback web
  server, returns the authorization URL for the UI to open in the system browser, exchanges the code and stores the grant.
- `accessToken()` returns a valid access token, refreshing it through the refresh token when needed.
- `getUsage()` reads `GET /api/v1/me/usage` (credits and token counts only), `listModels()` reads `GET /api/v1/models`.
- `signOut()` revokes the grant server-side and deletes the local record.

Emits `ai-route-account/changed` whenever the stored grant or the attempt changes.
