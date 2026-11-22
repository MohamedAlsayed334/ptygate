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
| `NINEROUTER_VERSION` | `0.5.119` | Pin the 9router npm package version. |
| `NINEROUTER_SKIP_UPDATE` | `0` | Set to `1` to reuse an installed 9router package without checking npm. |
| `NINEROUTER_PORT` | Free port | Fixed loopback port for the 9router child process. |
| `NINEROUTER_API_KEY` | Auto-created | Reuse an existing 9router API key (must already exist in 9router's database). |
| `NINEROUTER_INITIAL_PASSWORD` | Auto-generated | Dashboard password used on first 9router startup. |
| `NINEROUTER_PUBLIC_URL` | Log placeholder | Your public origin, used only in the startup log. |
| `GITHUB_TOKEN` | Unset | Avoids GitHub API rate limits during CLIProxyAPI release checks. |

## Pages and endpoints

Everything is served from the same public origin, e.g.
`https://your-domain.example`.

### Web pages (open in a browser)

| Page | URL | Login needed? |
|---|---|---|
| Terminal login | `/login` | No — enter the terminal token here. |
| Web terminal | `/` | Yes — the login sets a `wt_session` cookie. |
| CLIProxyAPI management panel | `/cpa/management.html` | The page opens freely, but its API calls need the management key. |
| 9router dashboard | `/9router/dashboard` | Yes — use the 9router dashboard password from the startup log. |

The gateway automatically points the management page at `/cpa/v8/management/...`,
so just open `/cpa/management.html` and enter the **management key** from the
startup log. Do not add a separate port or path. The panel is downloaded by
CLIProxyAPI on first open, so allow a few seconds on the very first load.

### Endpoints for programs

| Endpoint | Auth needed | What it is |
|---|---|---|
| `GET /healthz` | None | Is ptygate up? Returns `ok`. |
| `GET /cpa/healthz` | None | Is the CLIProxyAPI gateway up? |
| `GET /9router/healthz` | None | Is the 9router gateway up? |
| `GET /api/terminal/metrics` | Terminal session cookie | Container CPU/memory/disk stats. |
| `/cpa/v1/models` | **CLIProxyAPI API token** (Bearer) | List available models. |
| `/cpa/v1/chat/completions` | **CLIProxyAPI API token** (Bearer) | Chat completions (OpenAI format). |
| `/cpa/v1/responses`, `/cpa/v1/messages`, etc. | **CLIProxyAPI API token** (Bearer) | Other provider-compatible formats. |
| `/cpa/v0/management/*`, `/cpa/v8/management/*` | **CLIProxyAPI management key** | Accounts, keys, config. |
| `/9router/v1/models` | **9router API token** (Bearer) | List available models. |
| `/9router/v1/chat/completions` | **9router API token** (Bearer) | Chat completions (OpenAI format). |
| `/9router/v1/responses`, `/9router/v1/messages`, etc. | **9router API token** (Bearer) | Other formats supported by 9router. |
| `/9router/api/*` | 9router dashboard session | 9router management API (proxied under the prefix). |
| `/ws` | Session cookie + `ptygate.v1` subprotocol | Terminal WebSocket. |
| `/cpa/v1/realtime`, `/cpa/v1/responses/ws`, etc. | CLIProxyAPI's own auth | WebSocket AI routes (tunnelled). |
| `/9router/ws`, `/9router/responses`, etc. | 9router's own auth | WebSocket routes (tunnelled). |

A ptygate browser login is **not** needed for either gateway's `/v1/...` routes —
use the API token printed for that gateway in the startup log. Point any
OpenAI-compatible client at one of:

```
https://<your-public-origin>/cpa/v1
Authorization: Bearer <CLIProxyAPI API token>

https://<your-public-origin>/9router/v1
Authorization: Bearer <9router API token>
```

For step-by-step client setup (SDKs, OpenCode, management APIs, and
troubleshooting), see [CLIENTS.md](CLIENTS.md).

If IP restriction is enabled with `ALLOW_PRIVATE_ONLY=1`, it applies to **every**
route above, including `/healthz`, `/cpa/*`, and `/9router/*`.

## CLIProxyAPI gateway (`/cpa/`)

The app mounts [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
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

## 9router gateway (`/9router/`)

The app also mounts [9router](https://github.com/decolua/9router) on the same
public port. On startup ptygate:

1. Installs the pinned npm package into `$HOME/.ptygate/ninerouter/` using a
   project-local npm prefix — no global install or root access is needed. Set
   `NINEROUTER_VERSION` to change the pin, or `NINEROUTER_SKIP_UPDATE=1` to reuse
   the existing package.
2. Creates a stable machine identity and a private dashboard password in
   `$HOME/.ptygate/ninerouter/secrets.json` and `data/` (all `0600`). The
   dashboard password is printed once at startup.
3. Starts 9router's standalone server on a loopback port with `DATA_DIR` under
   that install directory, then creates an API key through 9router's local
   management API. The key is saved in `secrets.json` and printed at startup.
4. Reverse-proxies `/9router/` to the loopback server. No second port is exposed,
   and the child dies with ptygate.

The first install downloads a ~60 MB npm package and may build/install SQLite
runtime files, so allow a few minutes on a cold container. If installation or
startup fails, the terminal and `/cpa/` keep running; `/9router/` returns `503`
with the reason and logs it.

Open `/9router/dashboard` with the dashboard password from the startup log to
add upstream providers. Agents should use the separate API token:

```
https://<your-public-origin>/9router/v1
Authorization: Bearer <9router API token>
```

Anyone who can reach a gateway route can attempt to authenticate to that
gateway. Keep all tokens and passwords secret and use HTTPS when your hosting
platform provides it. Shell commands run with the same permissions as the Node
process; this app does not grant `sudo` or root privileges.
