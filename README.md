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

Anyone who can reach the login page can attempt to authenticate. Keep the token
secret and use HTTPS when your hosting platform provides it. Shell commands run
with the same permissions as the Node process; this app does not grant `sudo`
or root privileges.

## DeepSeek Harness

On the `feature/deepseek-harness` branch, DeepSeek Harness starts automatically
with ptygate. On first startup it installs the published `@deepseek-ai/dsh`
npm release into `$HOME/.ptygate/deepseek-harness`; later starts reuse that
install. It does not clone or build the source monorepo. This requires outbound
npm access, Node.js >=24.9 and enough disk and runtime memory. The package is
launched directly with the current Node executable.
The first startup can take several minutes. The Harness service is a separate
loopback-only process; ptygate proxies it at `/ai/` on the panel's existing
public port and stops it when ptygate shuts down.
Harness validates the browser-facing hostname. Set
`DEEPSEEK_HARNESS_TRUSTED_HOSTS` in the hosting panel to the assigned public
hostname (comma-separated for multiple hostnames); ptygate does not assume a
fixed deployment domain. The Harness listener remains bound to loopback.

The entire `/ai/` route, including assets, APIs and WebSockets, requires a valid
ptygate login session. Visitors are sent to `/login` first. Harness is also
experimental and can execute model-generated commands/plugins and access files,
credentials and the network available to its process. The ptygate login gate
does not sandbox those capabilities. Use a private deployment and avoid placing
untrusted workloads or sensitive credentials in the same container.
