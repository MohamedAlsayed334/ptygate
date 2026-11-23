# Connecting clients to the 9router gateway

This guide explains how to use ptygate's `/9router/` gateway from **any**
client — a terminal command, an SDK, an IDE plugin, or an agent — not just
OpenCode.

ptygate runs 9router as a managed child process and exposes it on the **same
public port** as the web terminal. There is no second port to expose and no
separate hostname to configure. The 9router API token and dashboard password
are different secrets; the terminal login cookie is never used for gateway
requests.

---

## 1. What you need

Collect these values once, from the ptygate startup log:

| Name | Where it comes from | Used for |
|---|---|---|
| **Public origin** | The address you open in the browser, e.g. `https://example.com` | The `https://...` part of every URL below |
| **9router API token** | Log line `9router] API token (Authorization: Bearer ...): <token>` | All `/9router/v1/...` model calls |
| **Dashboard password** | Log line `9router] Dashboard password: <password>` | `/9router/dashboard` only |

Both secrets are stored in `$HOME/.ptygate/ninerouter/secrets.json` with `0600`
permissions. The API key is created automatically through 9router's local
management API on first start. It can be overridden with `NINEROUTER_API_KEY`
before starting the server; that key must already exist in 9router's database.

> The **API token** and the **dashboard password** are different. Using the
> wrong one gives `401 Unauthorized`.

---

## 2. The three rules that matter

1. **The API base URL includes `/9router/v1`.**

   ```
   https://<your-public-origin>/9router/v1
   ```

   If you use only `https://<your-public-origin>`, requests land at the site
   root, which ptygate does not route to 9router. You will see `404 Not Found`.

2. **Authenticate with a Bearer token.**

   ```
   Authorization: Bearer <9router API token>
   ```

3. **Model discovery may need an explicit path.**

   Many tools build their model-list URL from the *origin* of the base URL and
   ignore its path, turning `https://<origin>/9router/v1` into
   `https://<origin>/v1/models`. If the tool supports a discovery/model-list
   endpoint override, set it to the absolute path:

   ```
   /9router/v1/models
   ```

   If the tool does not support an override, check whether it has a separate
   "API base" field where you can put the full origin plus `/9router/v1`.

`NINEROUTER_PUBLIC_URL` is **optional** and only changes a log line. It does not
affect routing, authentication, or discovery.

---

## 3. Verify the gateway first

Run these before configuring any client. Replace the placeholders.

```sh
export N9_ORIGIN="https://<your-public-origin>"
export N9_API_TOKEN="<9router API token from the startup log>"

# Is the gateway up?
curl "$N9_ORIGIN/9router/healthz"

# Can the token list models?
curl -H "Authorization: Bearer $N9_API_TOKEN" \
  "$N9_ORIGIN/9router/v1/models"

# Can it answer a chat request?
curl -H "Authorization: Bearer $N9_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"<model-id>","messages":[{"role":"user","content":"hi"}]}' \
  "$N9_ORIGIN/9router/v1/chat/completions"
```

A successful `/9router/v1/models` response looks like:

```json
{"data":[{"id":"<model-id>","object":"model"}]}
```

If `data` is empty, the gateway is working but no upstream provider has been
configured yet. Open the dashboard and add providers/keys first:

```
https://<your-public-origin>/9router/dashboard
```

Sign in with the dashboard password from the startup log.

---

## 4. Generic OpenAI-compatible client

Most tools accept two settings. Use:

| Setting | Value |
|---|---|
| API base / endpoint | `https://<your-public-origin>/9router/v1` |
| API key | `<9router API token from the startup log>` |

Common environment-variable names (use the ones your tool documents):

```sh
export OPENAI_API_BASE="https://<your-public-origin>/9router/v1"
export OPENAI_BASE_URL="https://<your-public-origin>/9router/v1"
export OPENAI_API_KEY="<9router API token>"
```

If the tool also has a **model list URL** setting, set it to:

```
https://<your-public-origin>/9router/v1/models
```

and pick a model ID from that response.

### OpenAI SDK — Node.js

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "https://<your-public-origin>/9router/v1",
  apiKey: process.env.N9_API_TOKEN,
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
    base_url="https://<your-public-origin>/9router/v1",
    api_key="<9router API token>",
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

Then, in the shell that starts OpenCode (or the desktop app's environment):

```sh
export N9_API_TOKEN="<9router API token from the startup log>"
opencode
```

Inside OpenCode:

```
/models-discovery-refresh
/models
```

Models appear as `ninerouter/<model-id>`. Select one in `/models`, or set a
default:

```json
"model": "ninerouter/<model-id>"
```

### Why each field is there

| Field | Reason |
|---|---|
| `baseURL` with `/9router/v1` | Chat completions must be sent to the gateway path, not the site root. |
| `apiKey` with `{env:N9_API_TOKEN}` | The discovery plugin sends this as `Authorization: Bearer ...`. `env` alone declares the variable but is not enough for discovery to authenticate. |
| `endpoint: "/9router/v1/models"` | The plugin resolves endpoints from the **origin** of `baseURL`, discarding `/9router/v1`. Without this override it calls `/v1/models` at the root and finds nothing. |
| `timeoutMs: 15000` | A cold gateway or slow upstream can exceed the 5 s default. |
| `env: ["N9_API_TOKEN"]` | Declares the credential for the OpenCode provider runtime. |

The variable `{env:NAME}` is substituted by OpenCode when it loads the config,
so the secret never has to be written into the JSON file.

---

## 6. Dashboard

Open `https://<your-public-origin>/9router/dashboard` and sign in with the
dashboard password from the startup log. Use it to add upstream providers and
API keys. It is intentionally separate from the terminal login and the model
API token.

Dashboard requests under `/9router/api/*` and the Next.js assets under
`/9router/_next/*` are proxied under the prefix, so the dashboard does not need
a second port or a different hostname.

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `404 Not Found` on `/chat/completions` or `/v1/models` | Base URL is missing `/9router/v1` | Use `https://<origin>/9router/v1` |
| `401 Unauthorized` on `/9router/v1/...` | Missing/wrong token, or using the dashboard password | Send `Authorization: Bearer <9router API token>` |
| `503` from `/9router/*` | 9router install or child startup failed | Read the startup log; the terminal still works |
| Models list is empty (`data: []`) | No upstream provider configured yet | Open `/9router/dashboard` and add providers/keys |
| OpenCode finds 0 models | Discovery had no Bearer token or wrong discovery endpoint | Add `settings.apiKey` and `modelsDiscovery.endpoint: "/9router/v1/models"` |
| `ALLOW_PRIVATE_ONLY=1` blocks a client | The IP policy applies to every route, including `/9router/*` | Disable it or allow the client IP |

---

## 8. Security notes

- Keep the API token and dashboard password out of git. Use environment
  variables or the `0600` sidecar file.
- Use HTTPS so Bearer tokens and dashboard passwords are not sent in clear
  text.
- 9router's API token grants model access; its dashboard password grants
  configuration access. Rotate them through the 9router dashboard or by editing
  `$HOME/.ptygate/ninerouter/secrets.json` and restarting.
- 9router runs in the same container as ptygate with the same resource limits.
  It is not a separate host or a process supervisor.
