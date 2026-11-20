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

Set `TERMINAL_TOKEN` in your hosting panel. The port is normally provided by
the panel; use `.env` only if your panel does not pass `PORT` or `SERVER_PORT`.

| Setting | Default | Purpose |
|---|---|---|
| `PORT` / `SERVER_PORT` | Required | Listening port; automatically supplied by most hosting panels. |
| `HOST` | `0.0.0.0` | Interface to listen on; this is required for typical hosting proxies. |
| `TERMINAL_TOKEN` | Generated at startup | Login secret; at least 16 characters. |
| `SHELL_BIN` | `SHELL` or `/bin/bash` | Shell executable to launch. |
| `ALLOW_PRIVATE_ONLY` | `0` | Set to `1` to restrict clients to private IP ranges. |
| `COOKIE_SECURE` | Unset | Set to `1` when HTTPS is provided by the host/proxy. |

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
`503` with the reason; the error is also logged. `GET /cpa/healthz` reports the
gateway's health.

Startup logs print the API base URL and both secrets. Point any OpenAI-compatible
client at:

```
https://<your-public-origin>/cpa/v1
```

and authenticate with `Authorization: Bearer <API token>`. The management panel
is at `/cpa/management.html` and the management API at `/cpa/v0/management` (key
required). WebSocket API routes under `/cpa/` are tunnelled as well.

The gateway uses CLIProxyAPI's own API-key authentication; a ptygate browser
login is **not** required for API calls, so CLI tools can use it from anywhere.
Keep the token secret — anyone holding it can use your configured AI accounts.
Logs redact both secrets. Set `CLIPROXYAPI_PUBLIC_URL` so the logged base URL is
exact; ptygate cannot discover the hosting panel's public hostname.

Use the terminal to complete CLIProxyAPI's one-time headless provider logins
(Gemini, Claude, Codex, etc.) and to add upstream keys through the management
panel. Credentials are stored under `$HOME` by CLIProxyAPI and survive restarts.

Anyone who can reach the login page can attempt to authenticate. Keep the token
secret and use HTTPS when your hosting platform provides it. Shell commands run
with the same permissions as the Node process; this app does not grant `sudo`
or root privileges.
