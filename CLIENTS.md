# Connecting clients to ptygate's model gateways

This guide explains how to use the `/cpa/` and `/9router/` gateways from **any**
client — a terminal command, an SDK, an IDE plugin, or an agent — not just
OpenCode.

ptygate runs both gateways as managed child processes and exposes them on the
**same public port** as the web terminal. There is no second port to expose and
no separate hostname to configure. Each gateway has its own API token; they are
not interchangeable.

---

## 1. What you need

Collect these three values once, from the ptygate startup log:

| Name | Where it comes from | Used for |
|---|---|---|
| **Public origin** | The address you open in the browser, e.g. `https://example.com` | The `https://...` part of every URL below |
| **API token** | Log line `API token (Authorization: Bearer ...): <token>` | All `/cpa/v1/...` model calls |
| **Management key** | Log line `Management key: <key>` | The management panel and `/cpa/v8/management/...` only |

Both secrets are also stored in `$HOME/.ptygate/cliproxyapi/secrets.json` with
`0600` permissions. You can override them with `CLIPROXYAPI_API_KEY` and
`CLIPROXYAPI_MANAGEMENT_KEY` before starting the server.

> The **API token** and the **management key** are different. Using the wrong
> one gives `401 Unauthorized`. A ptygate terminal login cookie is never used
> for `/cpa/v1/...`.

---

## 2. The three rules that matter

1. **The API base URL includes `/cpa/v1`.**

   ```
   https://<your-public-origin>/cpa/v1
   ```

   If you use only `https://<your-public-origin>`, requests land at the site
   root, which ptygate does not route to CLIProxyAPI. You will see `404 Not
   Found`.

2. **Authenticate with a Bearer token.**

   ```
   Authorization: Bearer <API token>
   ```

3. **Model discovery may need an explicit path.**

   Many tools build their model-list URL from the *origin* of the base URL and
   ignore its path, turning `https://<origin>/cpa/v1` into
   `https://<origin>/v1/models`. If the tool supports a discovery/model-list
   endpoint override, set it to the absolute path:

   ```
   /cpa/v1/models
   ```

   If the tool does not support an override, check whether it has a separate
   "API base" field where you can put the full origin plus `/cpa/v1`.

`CLIPROXYAPI_PUBLIC_URL` is **optional** and only changes a log line. It does
not affect routing, authentication, or discovery.

---

## 3. Verify the gateway first

Run these before configuring any client. Replace the placeholders.

```sh
export CPA_ORIGIN="https://<your-public-origin>"
export CPA_API_TOKEN="<API token from the startup log>"

# Is the gateway up?
curl "$CPA_ORIGIN/cpa/healthz"

# Can the token list models?
curl -H "Authorization: Bearer $CPA_API_TOKEN" \
  "$CPA_ORIGIN/cpa/v1/models"

# Can it answer a chat request?
curl -H "Authorization: Bearer $CPA_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"<model-id>","messages":[{"role":"user","content":"hi"}]}' \
  "$CPA_ORIGIN/cpa/v1/chat/completions"
```

A successful `/cpa/v1/models` response looks like:

```json
{"data":[{"id":"<model-id>","object":"model"}]}
```

If `data` is empty, the gateway is working but no upstream provider has been
configured yet. Add accounts/keys in the management panel first:

```
https://<your-public-origin>/cpa/management.html
```

Enter the **management key** there.

---

## 4. Generic OpenAI-compatible client

Most tools accept two settings. Use:

| Setting | Value |
|---|---|
| API base / endpoint | `https://<your-public-origin>/cpa/v1` |
| API key | `<API token from the startup log>` |

Common environment-variable names (use the ones your tool documents):

```sh
export OPENAI_API_BASE="https://<your-public-origin>/cpa/v1"
export OPENAI_BASE_URL="https://<your-public-origin>/cpa/v1"
export OPENAI_API_KEY="<API token>"
```

If the tool also has a **model list URL** setting, set it to:

```
https://<your-public-origin>/cpa/v1/models
```

and pick a model ID from that response.

### OpenAI SDK — Node.js

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://<your-public-origin>/cpa/v1",
  apiKey: process.env.CPA_API_TOKEN,
});

const reply = await client.chat.completions.create({
  model: "<model-id>",
  messages: [{ role: "user", content: "Hello" }],
});
console.log(reply.choices[0].message.content);
```

### OpenAI SDK — Python

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://<your-public-origin>/cpa/v1",
    api_key="<API token>",
)

reply = client.chat.completions.create(
    model="<model-id>",
    messages=[{"role": "user", "content": "Hello"}],
)
print(reply.choices[0].message.content)
```

Do not hard-code the token in source files. Read it from an environment
variable or a secret file.

---

## 5. OpenCode

Use the `opencode-models-discovery` plugin so models appear in `/models`
automatically. Put this in `opencode.json` (project) or
`~/.config/opencode/opencode.json` (all projects):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-models-discovery@2.2.0"],
  "providers": {
    "acme": {
      "name": "cliproxy-acme",
      "env": ["ACME_API_KEY"],
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "https://<your-public-origin>/cpa/v1",
        "apiKey": "{env:ACME_API_KEY}",
        "modelsDiscovery": {
          "enabled": true,
          "endpoint": "/cpa/v1/models",
          "smartModelName": true,
          "timeoutMs": 15000
        }
      }
    }
  }
}
```

Then, in the shell that starts OpenCode (or the desktop app's environment):

```sh
export ACME_API_KEY="<API token from the startup log>"
opencode
```

Inside OpenCode:

```
/models-discovery-refresh
/models
```

Models appear as `acme/<model-id>`. Select one in `/models`, or set a default:

```json
"model": "acme/<model-id>"
```

### Why each field is there

| Field | Reason |
|---|---|
| `baseURL` with `/cpa/v1` | Chat completions must be sent to the gateway path, not the site root. |
| `apiKey` with `{env:ACME_API_KEY}` | The discovery plugin sends this as `Authorization: Bearer ...`. `env` alone declares the variable but is not enough for discovery to authenticate. |
| `endpoint: "/cpa/v1/models"` | The plugin resolves endpoints from the **origin** of `baseURL`, discarding `/cpa/v1`. Without this override it calls `/v1/models` at the root and finds nothing. |
| `timeoutMs: 15000` | A cold gateway or slow upstream can exceed the 5 s default. |
| `env: ["ACME_API_KEY"]` | Declares the credential for the OpenCode provider runtime. |

The variable `{env:NAME}` is substituted by OpenCode when it loads the config,
so the secret never has to be written into the JSON file.

---

## 6. Management API

The management panel at `/cpa/management.html` uses these endpoints with the
**management key**, not the API token:

```
GET /cpa/v8/management/config
GET /cpa/v0/management/config
```

Example:

```sh
curl -H "Authorization: Bearer <management key>" \
  "https://<your-public-origin>/cpa/v8/management/config"
```

The gateway rewrites the management page so it automatically calls
`/cpa/v8/management/...` instead of `/v8/management/...` at the site root. You
do not need to type a port or server address in the page.

---

## 7. The 9router gateway (`/9router/`)

9router is a second, independent model gateway. It uses its own API token and
its own dashboard password; neither works with `/cpa/`.

### What you need

From the ptygate startup log:

| Name | Log line | Used for |
|---|---|---|
| **9router API token** | `9router] API token (Authorization: Bearer ...): <token>` | All `/9router/v1/...` model calls |
| **Dashboard password** | `9router] Dashboard password: <password>` | `/9router/dashboard` only |

Both are stored in `$HOME/.ptygate/ninerouter/secrets.json` with `0600`
permissions. The API key is created automatically through 9router's local
management API on first start.

### API base and verification

```
https://<your-public-origin>/9router/v1
Authorization: Bearer <9router API token>
```

```sh
export N9_ORIGIN="https://<your-public-origin>"
export N9_API_TOKEN="<9router API token from the startup log>"

curl "$N9_ORIGIN/9router/healthz"

curl -H "Authorization: Bearer $N9_API_TOKEN" \
  "$N9_ORIGIN/9router/v1/models"

curl -H "Authorization: Bearer $N9_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"<model-id>","messages":[{"role":"user","content":"hi"}]}' \
  "$N9_ORIGIN/9router/v1/chat/completions"
```

The same model-discovery caveat applies: if a tool ignores the path in its base
URL, set its discovery endpoint to the absolute path
`/9router/v1/models`.

### OpenAI SDK examples

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://<your-public-origin>/9router/v1",
  apiKey: process.env.N9_API_TOKEN,
});
```

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://<your-public-origin>/9router/v1",
    api_key="<9router API token>",
)
```

### OpenCode

Add a separate provider entry; do not reuse the CLIProxyAPI provider key:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-models-discovery@2.2.0"],
  "providers": {
    "ninerouter": {
      "name": "9router",
      "env": ["N9_API_TOKEN"],
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "https://<your-public-origin>/9router/v1",
        "apiKey": "{env:N9_API_TOKEN}",
        "modelsDiscovery": {
          "enabled": true,
          "endpoint": "/9router/v1/models",
          "smartModelName": true,
          "timeoutMs": 15000
        }
      }
    }
  }
}
```

### Dashboard

Open `https://<your-public-origin>/9router/dashboard` and sign in with the
dashboard password from the startup log. Use it to add upstream providers and
keys. It is intentionally separate from the terminal login and the API token.

9router is installed with npm into `$HOME/.ptygate/ninerouter/`, with its data
under that directory's `data/` folder. Use `NINEROUTER_VERSION` to pin a
version, `NINEROUTER_SKIP_UPDATE=1` to reuse the installed package, and
`NINEROUTER_PORT` to fix its loopback port.

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `404 Not Found` on `/chat/completions` or `/v1/models` | Base URL is missing `/cpa/v1` or `/9router/v1` | Use the full gateway API base |
| `401 Unauthorized` on `/cpa/v1/...` | Missing/wrong token, or using the management key | Send `Authorization: Bearer <CLIProxyAPI API token>` |
| `401 Unauthorized` on `/9router/v1/...` | Missing/wrong token, or using the dashboard password | Send `Authorization: Bearer <9router API token>` |
| `503` from `/cpa/*` or `/9router/*` | Gateway install or child startup failed | Read the startup log; the terminal still works |
| Models list is empty (`data: []`) | No upstream provider configured yet | Open that gateway's management page and add accounts/keys |
| OpenCode finds 0 models | Discovery had no Bearer token or wrong discovery endpoint | Add `settings.apiKey` and an absolute `modelsDiscovery.endpoint` |
| Management page says “v8 Management API not found” | Page is calling `/v8/...` at the root | Hard-refresh `/cpa/management.html`; the gateway rewrite should prevent this |
| First management-page load is slow | Gateway downloads its panel on first open | Wait a few seconds and retry |
| `ALLOW_PRIVATE_ONLY=1` blocks a client | The IP policy applies to every route, including `/cpa/*` and `/9router/*` | Disable it or allow the client IP |

---

## 9. Security notes

- Keep every API token, management key, and dashboard password out of git. Use
  environment variables or the `0600` sidecar files.
- Use HTTPS so Bearer tokens and dashboard passwords are not sent in clear text.
- CLIProxyAPI's API token grants model access; its management key grants
  configuration access. Rotate them by changing `CLIPROXYAPI_API_KEY` /
  `CLIPROXYAPI_MANAGEMENT_KEY` and restarting.
- 9router's API token grants model access; its dashboard password grants
  configuration access. Rotate them through the 9router dashboard or by editing
  `$HOME/.ptygate/ninerouter/secrets.json` and restarting.
- Both gateways run in the same container as ptygate with the same resource
  limits. Neither is a separate host or a process supervisor.
