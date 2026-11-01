# @deepseek-ai/dsh-llm-ai-route

Registers the `ai-route` provider route. Requests go to `https://aiapi.hoj.kr/api/v1/chat/completions` through the
shared pi-ai OpenAI-compatible transport with the signed-in account's access token as the bearer credential.

The model catalog is the account's own `GET /models` listing (exactly what the user's plan includes, in server order),
refreshed every `modelsMaxAgeMs` and on every sign-in change. Uncensored models carry a red shield badge, free models a
"Free" badge. Signed out, the route offers no models and a request fails with `MISSING_CREDENTIAL`.
