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

## Optional DeepSeek Harness preview

An opt-in module can supervise an independently checked-out DeepSeek Harness
process and proxy it under `/ai/` on ptygate's existing listener. Harness is
experimental software, separate from ptygate, and can execute model-generated
commands and plugins and access files, credentials, and the network. This
integration does not make it safe or sandboxed. Prefer a separate, isolated
service/container with restricted credentials and filesystem/network access.
Do not enable it on a shared or untrusted deployment. The combined workload has
no documented resource minimum and may exceed this container's CPU/RAM limits.

When explicitly enabled, deployment automation must clone and build the upstream
checkout; ptygate will not clone or install Harness itself:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness "$HOME/deepseek-harness"
cd "$HOME/deepseek-harness"
# Requires Node >=24.9 and pnpm 11.28.5
pnpm install && pnpm run build
```

Set `DEEPSEEK_HARNESS_ENABLED=1`, `DEEPSEEK_HARNESS_DIR` to that checkout, and
`DEEPSEEK_HARNESS_PUBLIC_HOST` to the public hostname (optionally with port,
without scheme or path). `DEEPSEEK_HARNESS_HTTPS` defaults to `1`; set it to `0`
only when the public route uses plain HTTP. An ephemeral loopback port is chosen
by default; optionally set `DEEPSEEK_HARNESS_PORT` to an unprivileged local port.
The child is launched with pnpm and stopped with ptygate. `DEEPSEEK_HARNESS_COMMAND`
can select a pnpm executable. Startup fails if the child does not become ready.
The proxy strips `/ai`, preserves the public Host for trusted-host validation,
rewrites cookie paths and redirects, and forwards the Harness mux WebSocket.
Harness's launch URL token/session and APIs remain Harness-managed; static files
are public. ptygate login is not a substitute for Harness authentication.

If the image lacks supported Node/pnpm/build prerequisites or adequate
resources, use a separate isolated service rather than attempting this in the
ptygate container.
