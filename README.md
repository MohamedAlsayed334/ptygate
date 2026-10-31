# web terminal (test project)

A browser-based terminal that runs a **real shell on this machine** and streams it to
your browser. Type `sudo apt install ...`, answer prompts, run `htop`, `nano`, etc. —
it behaves exactly like an SSH session, because it *is* one: a PTY (`/dev/pts/N`)
with a login shell attached, forwarded over a WebSocket.

```
browser (xterm.js)  <--ws-->  node server  <--pty-->  /bin/bash -l
```

## Why a PTY and not "POST a command, return output"

A plain `POST /run {cmd}` endpoint only handles one-shot commands. It breaks the
moment you need a prompt (`sudo` password), a TUI (`nano`, `top`), a long-running
process (a dev server, `tail -f`), or shell state between commands (`cd`, `export`).
A PTY gives you all of that for free. It is also the standard approach — it is
what `ttyd`, `gotty`, `Wetty`, and code-server's terminal do.

## Run it

```bash
npm install
TERMINAL_TOKEN='pick-something-long-and-random' npm start
```

Then open <http://127.0.0.1:8080> and paste the token.

If `TERMINAL_TOKEN` is not set, the server generates one and prints it on startup.
`npm run dev` restarts on file changes.

Config (env vars):

| var              | default     | meaning                                                   |
| ---------------- | ----------- | --------------------------------------------------------- |
| `PORT`           | `8080`      | listen port                                               |
| `HOST`           | `127.0.0.1` | bind address — loopback only by default, deliberately      |
| `TERMINAL_TOKEN` | generated   | the only credential; min 16 chars                          |
| `SHELL_BIN`      | `$SHELL`    | shell to spawn (`/bin/bash`, `/usr/bin/zsh`, ...)          |
| `COOKIE_SECURE`  | unset       | set to `1` when served over HTTPS                          |

## Reaching it from your laptop

Do **not** open the port to the internet. Pick one of these:

**1. SSH tunnel (simplest, nothing to expose)**

```bash
ssh -L 8080:127.0.0.1:8080 you@your-vps
# then browse http://127.0.0.1:8080  (the token still applies)
```

**2. Tailscale / WireGuard** — bind to the tailnet IP (`HOST=100.x.y.z`) and only
devices on your tailnet can reach it.

**3. Reverse proxy with TLS + real auth** — Caddy/nginx terminating HTTPS in front
of `127.0.0.1:8080`, with HTTP Basic auth or an identity provider on top, then
`COOKIE_SECURE=1`. Only do this if you must have it on the public internet.

## Security — read this before pointing it at a VPS

This app is **remote code execution as a feature**. Anything that can reach the
login page and guess/steal the token owns the account the server runs as. Concrete
choices made here, and what to add for real use:

Already in place:

- Binds to `127.0.0.1` by default; warns if you bind elsewhere.
- Token login with constant-time comparison + per-IP lockout after 10 failures.
- Random 256-bit session cookie, `HttpOnly`, `SameSite=Strict`, 12h idle expiry.
- WebSocket upgrade requires the session cookie **and** a same-origin `Origin`
  header (blocks cross-site WebSocket hijacking).
- Keystrokes are never logged. Passwords you type into `sudo` stay in the PTY.
- Caps on concurrent PTYs; 64 KiB max frame per message.

Still missing for production, and you should add if you keep this:

- **TLS.** Without it the token and the whole session travel in cleartext.
- **Run as a dedicated non-root user.** The terminal gets that user's rights.
  If it can `sudo`, it effectively gets root — decide that on purpose.
- **Audit trail.** If you need to know what was run, log session transcripts —
  but that means recording secrets too, so think before enabling it.
- **Rate limiting at the edge** (fail2ban, Caddy/nginx limits), not just in-app.
- **Updates.** `npm audit` regularly; `node-pty` and `ws` are the sensitive bits.

A ready-to-adapt systemd unit:

```ini
[Unit]
Description=web terminal
After=network.target

[Service]
Type=simple
User=term
WorkingDirectory=/opt/web-terminal
Environment=TERMINAL_TOKEN=replace-me-with-a-long-random-value
Environment=HOST=127.0.0.1
ExecStart=/usr/bin/node server.js
Restart=always
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

## Should you actually use this for your VPS gate?

As a learning exercise, yes — this repo shows the whole mechanism in ~250 lines.
As your real door into a production VPS, prefer a tool that has already been
hardened and reviewed:

- **SSH** (`ssh`, or **Tailscale SSH** / **Teleport** / **Boundary** for audits)
- **ttyd** or **Wetty** — a web terminal with auth and TLS support
- **Apache Guacamole** — full remote-desktop gateway
- **code-server** — if you mostly want an IDE with a terminal

The rule of thumb: for shell access, adding a web door usually *reduces* security
versus SSH on a hardened, key-only, fail2ban-guarded port. Use the tunnel pattern
above and you get the convenience without the exposure.

## Files

```
server.js          HTTP + WebSocket + PTY, auth, limits
public/login.html  token login page
public/index.html  xterm.js terminal UI
```
