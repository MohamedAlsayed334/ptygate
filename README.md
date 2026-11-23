# ptygate

A browser-based terminal for the account running this Node.js process, plus a
managed [9router](https://github.com/decolua/9router) model gateway on the same
public port. The terminal uses `node-pty` and WebSockets. It is **not SSH** and
does not provide root access or bypass the hosting provider's container
restrictions.

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

- `npm start` — start the web terminal and 9router gateway (normal hosting command).
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
| `NINEROUTER_VERSION` | `latest` | Follow npm's latest 9router release, or pin a tested version such as `0.5.123`. |
| `NINEROUTER_SKIP_UPDATE` | `0` | Set to `1` to reuse an installed 9router package without checking npm. |
| `NINEROUTER_PORT` | Free port | Fixed loopback port for the 9router child process. |
| `NINEROUTER_API_KEY` | Auto-created | Reuse an existing 9router API key (must already exist in 9router's database). |
| `NINEROUTER_INITIAL_PASSWORD` | Auto-generated | Dashboard password used on first 9router startup. |
| `NINEROUTER_PUBLIC_URL` | Log placeholder | Your public origin, used only in the startup log. |

## Pages and endpoints

Everything is served from the same public origin, e.g.
`https://your-domain.example`.

### Web pages (open in a browser)

| Page | URL | Login needed? |
|---|---|---|
| Terminal login | `/login` | No — enter the terminal token here. |
| Web terminal | `/` | Yes — the login sets a `wt_session` cookie. |
| 9router dashboard | `/9router/dashboard` | Yes — use the dashboard password from the startup log. |

### Endpoints for programs

| Endpoint | Auth needed | What it is |
|---|---|---|
| `GET /healthz` | None | Is ptygate up? Returns `ok`. |
| `GET /9router/healthz` | None | Is the 9router gateway up? |
| `GET /api/terminal/metrics` | Terminal session cookie | Container CPU/memory/disk stats. |
| `/9router/v1/models` | **9router API token** (Bearer) | List available models. |
| `/9router/v1/chat/completions` | **9router API token** (Bearer) | Chat completions (OpenAI format). |
| `/9router/v1/responses`, `/9router/v1/messages`, etc. | **9router API token** (Bearer) | Other formats supported by 9router. |
| `/9router/api/*` | 9router dashboard session | 9router management API (proxied under the prefix). |
| `/ws` | Session cookie + `ptygate.v1` subprotocol | Terminal WebSocket. |
| `/9router/ws`, `/9router/responses`, etc. | 9router's own auth | WebSocket routes (tunnelled). |

A ptygate browser login is **not** needed for 9router's `/v1/...` routes — use
the API token printed in the startup log. Point any OpenAI-compatible client at:

```
https://<your-public-origin>/9router/v1
Authorization: Bearer <9router API token>
```

For step-by-step client setup (SDKs, OpenCode, dashboard, and troubleshooting),
see [CLIENTS.md](CLIENTS.md).

If IP restriction is enabled with `ALLOW_PRIVATE_ONLY=1`, it applies to **every**
route above, including `/healthz` and `/9router/*`.

## 9router gateway (`/9router/`)

The app mounts [9router](https://github.com/decolua/9router) on the same public
port as the terminal. On startup ptygate:

1. Installs the npm package into `$HOME/.ptygate/ninerouter/` using a
   project-local npm prefix — no global install or root access is needed. By
   default it resolves npm's `latest` tag on every start and only reinstalls
   when the version changes. Set `NINEROUTER_VERSION` to pin a tested release,
   or `NINEROUTER_SKIP_UPDATE=1` to reuse the existing package without checking
   npm.
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
startup fails, the terminal keeps running; `/9router/` returns `503` with the
reason and logs it.

Open `/9router/dashboard` with the dashboard password from the startup log to
add upstream providers. Agents should use the separate API token:

```
https://<your-public-origin>/9router/v1
Authorization: Bearer <9router API token>
```

### Checking the gateway version

ptygate records the version it installed:

```sh
cat "$HOME/.ptygate/ninerouter/install.json"
npm view 9router version
```

If the installed version is behind, restart ptygate. 9router resolves npm's
`latest` tag at startup; make sure `NINEROUTER_SKIP_UPDATE` is not set to `1`,
otherwise ptygate deliberately keeps the installed version. To force a tested
version instead, set `NINEROUTER_VERSION` and restart.

Anyone who can reach a gateway route can attempt to authenticate to that
gateway. Keep all tokens and passwords secret and use HTTPS when your hosting
platform provides it. Shell commands run with the same permissions as the Node
process; this app does not grant `sudo` or root privileges.
