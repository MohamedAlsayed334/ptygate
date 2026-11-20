# ptygate

A browser-based terminal for the account running this Node.js process. It uses
`node-pty` to start that account's shell and WebSockets to connect it to the
terminal page. It is **not SSH** and does not provide root access or bypass the
hosting provider's container restrictions.

## Run

Install dependencies, set a private token of at least 16 characters in your
hosting panel, and start the app:

```sh
npm install
npm start
```

`npm start` listens on `0.0.0.0` so a hosting platform's proxy can reach it. It
uses the panel's `PORT` or `SERVER_PORT` value. If neither is provided, copy
`.env.example` to `.env` and set `PORT` to the port allocated by your panel. The
server exits with a clear error if no port is configured; it does not silently
pick a different port. If no token is set, one is generated and printed at
startup.

Open the server address and allocated port shown by the hosting panel, then
enter the token. `/healthz` returns `ok` for a basic availability check. The
host must support WebSocket connections and route the configured port.

The terminal includes Copy and Paste controls, plus a live resource panel for
container CPU/memory and the filesystem used by the app. Container metrics may
be unavailable if the host does not expose cgroup statistics; filesystem
capacity is not a per-container storage quota. Clipboard access is controlled
by the browser: HTTPS and permission are generally required for toolbar paste.

## npm scripts

- `npm start` — start the web terminal (normal hosting command).
- `npm run dev` — start with automatic restarts while editing locally.
- `npm test` — run the module unit tests (`node --test`).

The app uses `express`, `ws`, `node-pty`, `@xterm/xterm`, and
`@xterm/addon-fit`. `node-pty` is native software, so install dependencies on
the target platform when possible.

## Settings

Set these in the hosting panel. `.env` is only a fallback for values the panel
does not provide; **panel values always win**.

### Mandatory — set these together

| Setting | Example | Why |
|---|---|---|
| `PORT` or `SERVER_PORT` | `24723` | The one port your panel forwards. The app refuses to start without it. |
| `TERMINAL_TOKEN` | `a-long-random-string` | Password for the web terminal (16+ chars). If unset, a new one is generated on every restart and printed in the log. |

### Optional

| Setting | Default | Purpose |
|---|---|---|
| `HOST` | `0.0.0.0` | Interface to listen on; leave as-is for hosting proxies. |
| `SHELL_BIN` | `SHELL` or `/bin/bash` | Shell used by the terminal. |
| `ALLOW_PRIVATE_ONLY` | `0` | Set to `1` to restrict **all** routes to private IPs. |
| `COOKIE_SECURE` | Unset | Set to `1` when the host terminates HTTPS. |
| `CLIPROXYAPI_PUBLIC_URL` | Log placeholder | Your public origin, e.g. `https://example.com`. Used only in the startup log. |
| `CLIPROXYAPI_API_KEY` | Auto-generated | Fixed API token for `/cpa/v1/...`. |
| `CLIPROXYAPI_MANAGEMENT_KEY` | Auto-generated | Fixed key for the management API/panel. |
| `CLIPROXYAPI_VERSION` | Latest release | Pin a release tag, e.g. `v8.0.80`. |
| `CLIPROXYAPI_SKIP_UPDATE` | `0` | Set to `1` to reuse the installed binary without checking GitHub. |
| `CLIPROXYAPI_PORT` | Free port | Fixed loopback port for the child process. |
| `GITHUB_TOKEN` | Unset | Avoids GitHub API rate limits during release checks. |

## Pages and endpoints

Everything is served from the same public origin, e.g.
`https://your-domain.example`.

### Web pages (open in a browser)

| Page | URL | Login needed? |
|---|---|---|
| Terminal login | `/login` | No — enter the terminal token here. |
| Web terminal | `/` | Yes — the login sets a `wt_session` cookie. |
| CLIProxyAPI management panel | `/cpa/management.html` | The page opens freely, but its API calls need the management key. |

The gateway automatically points the management page at `/cpa/v8/management/...`,
so just open `/cpa/management.html` and enter the **management key** from the
startup log. Do not add a separate port or path. The panel is downloaded by
CLIProxyAPI on first open, so allow a few seconds on the very first load.

### Endpoints for programs

| Endpoint | Auth needed | What it is |
|---|---|---|
| `GET /healthz` | None | Is ptygate up? Returns `ok`. |
| `GET /cpa/healthz` | None | Is the CLIProxyAPI gateway up? |
| `GET /api/terminal/metrics` | Terminal session cookie | Container CPU/memory/disk stats. |
| `/cpa/v1/models` | **API token** (Bearer) | List available models. |
| `/cpa/v1/chat/completions` | **API token** (Bearer) | Chat completions (OpenAI format). |
| `/cpa/v1/responses`, `/cpa/v1/messages`, etc. | **API token** (Bearer) | Other provider-compatible formats. |
| `/cpa/v0/management/*`, `/cpa/v8/management/*` | **Management key** | Accounts, keys, config. |
| `/ws` | Session cookie + `ptygate.v1` subprotocol | Terminal WebSocket. |
| `/cpa/v1/realtime`, `/cpa/v1/responses/ws`, etc. | CLIProxyAPI's own auth | WebSocket AI routes (tunnelled). |

A ptygate browser login is **not** needed for `/cpa/v1/...` — use the API token
from the startup log. Point any OpenAI-compatible client at:

```
https://<your-public-origin>/cpa/v1
Authorization: Bearer <API token>
```

If IP restriction is enabled with `ALLOW_PRIVATE_ONLY=1`, it applies to **every**
route above, including `/healthz` and `/cpa/*`.

## CLIProxyAPI gateway (`/cpa/`)

This branch also mounts [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
on the **same public port** as the terminal. On startup ptygate:

1. Downloads the latest verified Linux release asset for the container's CPU and
   libc into `$HOME/.ptygate/cliproxyapi/` (use `CLIPROXYAPI_VERSION` to pin a
   tag, or `CLIPROXYAPI_SKIP_UPDATE=1` to reuse the installed binary).
2. Generates a client API token and a management key, saved with `0600` perms in
   `secrets.json`, and writes a v8 `config.yaml` bound to `127.0.0.1`.
3. Spawns `cli-proxy-api` as a managed child process and reverse-proxies
   `/cpa/` to it. The child dies with the server, so nothing is left running
   after a container restart. No extra port needs to be exposed.

The first start downloads a ~24 MB binary, so allow a minute or two. If the
download or child process fails, the terminal keeps running and `/cpa/` returns
`503` with the reason; the error is also logged.

Use the terminal to complete CLIProxyAPI's one-time headless provider logins
(Gemini, Claude, Codex, etc.) and to add upstream keys through the management
panel. Credentials are stored under `$HOME` by CLIProxyAPI and survive restarts.

Anyone who can reach the login page can attempt to authenticate. Keep the tokens
secret and use HTTPS when your hosting platform provides it. Shell commands run
with the same permissions as the Node process; this app does not grant `sudo`
or root privileges.
