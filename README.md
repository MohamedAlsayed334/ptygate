# ptygate

A browser terminal backed by a **real PTY**, with an IP allowlist, token login,
and session resume. Type `sudo apt install ...`, answer prompts, run `htop`,
`nano`, etc. — it behaves exactly like an SSH session, because it *is* one: a
PTY (`/dev/pts/N`) with a login shell attached, forwarded over a WebSocket.

```
browser (xterm.js)  <--ws / ptygate.v1-->  node gateway  <--pty-->  /bin/bash -l
```

## Why a PTY and not "POST a command, return output"

A plain `POST /run {cmd}` endpoint only handles one-shot commands. It breaks the
moment you need a prompt (`sudo` password), a TUI (`nano`, `top`), a
long-running process (a dev server, `tail -f`), or shell state between commands
(`cd`, `export`). A PTY gives you all of that for free. It is also the standard
approach — it is what `ttyd`, `gotty`, `Wetty` and code-server's terminal do.

## What sets this apart from a plain demo

- **Detached sessions / resume.** Disconnect the WebSocket and the shell keeps
  running; reconnect and the last ~256 KiB of output is replayed so your screen
  is intact. A second connection on the same session takes the PTY over
  (first client is kicked, 4000 "detached").
- **Named wire protocol.** WebSocket handshakes must offer the
  `ptygate.v1` subprotocol; frames are typed JSON (`hello`, `output`, `input`,
  `resize`, `detach`, `exit`). Spec in [`contract/PROTOCOL.md`](contract/PROTOCOL.md).
- **Honest ops metadata.** `/healthz` says `ok`; `/version` reports the
  implementation, protocol version, supported transports and effective IP mode.
- **Layered guard.** Every request and every WS upgrade passes: IP policy →
  Origin check (blocks cross-site WebSocket hijacking) → session cookie →
  subprotocol → PTY capacity. Malformed handshakes get a real HTTP status
  (400/401/403/404/426/429), never a crash.
- **Conformance-tested.** A language-agnostic suite in `contract/tests/` runs
  ~50 cases (auth, hostile cookies, resume replay, 4-PTY cap, oversized
  frames...) against a live server: `npm test`.

## Run it

```bash
npm install
TERMINAL_TOKEN='pick-something-long-and-random' npm start
```

Then open <http://127.0.0.1:8080> and paste the token.

If `TERMINAL_TOKEN` is not set, the server generates one and prints it on
startup.

All the ways to start it (`npm run <script>`):

| script         | what you get                                                            |
| -------------- | ----------------------------------------------------------------------- |
| `start`        | web UI on this machine only (`127.0.0.1`)                                |
| `lan`          | web UI reachable from other devices in **your house** (`0.0.0.0`)        |
| `console`      | web UI on localhost **plus a shell in the terminal you started it in**   |
| `lan:console`  | both at once, on `$SERVER_PORT` if set — the Pterodactyl/container case  |
| `dev`          | like `start` but auto-restarts when you edit `server.js` or `src/**`     |
| `dev:lan`      | like `lan` but auto-restarts                                            |
| `check`        | `node --check` every module (`server.js` + `src/*.js`)                   |
| `test`         | boot the gateway on a free port and run the full contract suite          |
| `contract:sync`   | refresh `contract/` from the published contract release               |
| `contract:check`  | compare `contract/` against the release (exit 1 on drift)             |
| `env:report`   | container environment report (same as `scripts/env-report.sh`)           |

Flags pass through where it makes sense, e.g. `npm test -- --module test_ws`.

### From your phone / another laptop in the house

```bash
TERMINAL_TOKEN='pick-something-long-and-random' npm run lan
```

The server prints the address to type into your phone, e.g.:

```
  web terminal listening on http://0.0.0.0:8080
  addresses on this machine:
    http://192.168.0.108:8080
```

Open that on any device on the same wifi and paste the token.

LAN mode still only accepts **private network** addresses by default
(`10.x`, `172.16-31.x`, `192.168.x`, `127.x`, `100.64/10`, IPv6 local), so even
if your router forwards the port, connections from the internet get
`403 Forbidden`. Override with:

```bash
ALLOWED_IPS='192.168.0.0/24' npm run lan   # even stricter: just your subnet
ALLOW_PRIVATE_ONLY=0 npm run lan           # allow anything (don't, unless proxied)
```

If you run a firewall, open the port only to your subnet:

```bash
sudo ufw allow from 192.168.0.0/24 to any port 8080 proto tcp
```

### Use the server's own terminal as input

```bash
TERMINAL_TOKEN='...' npm run console
```

You are dropped straight into a shell in that terminal window, and the web UI
serves at the same time. Both are independent shells; if you want commands in
one to appear in the other, that's a shared-session feature this doesn't have.

Inside the local shell, `Ctrl+C` goes to the shell (not the server), so to
leave it type `exit`. The server keeps running; press Enter for a new shell, or
`Ctrl+C` at the prompt to stop the server. Server logs printed while you were
in the shell are buffered and shown after you exit, so they don't wreck the
terminal.

Config (env vars — canonical new names take precedence over the legacy ones):

| var                  | legacy alias     | default     | meaning                                       |
| -------------------- | ---------------- | ----------- | --------------------------------------------- |
| `PORT`               | `PTYGATE_PORT`   | `8080`      | listen port (`$SERVER_PORT` respected)        |
| `HOST`               | `PTYGATE_HOST`   | `127.0.0.1` | bind address (`LAN=1` or a container → `0.0.0.0`) |
| `LAN`                | —                | unset       | `1` = listen on all interfaces, print LAN URLs |
| `PTYGATE_TOKEN`      | `TERMINAL_TOKEN` | generated   | the only credential; min 16 chars             |
| `PTYGATE_IP_MODE`    | –                | `allowlist` | `allowlist` (private ranges) or `any`         |
| `ALLOW_PRIVATE_ONLY` | fallback         | `1`         | `0` = same as `--ip-mode any`                 |
| `ALLOWED_IPS`        | `PTYGATE_ALLOWED_IPS` | unset  | comma list of IPs/CIDRs; overrides the ranges |
| `SHELL_BIN`          | `SHELL`          | `/bin/bash` | shell to spawn (`/usr/bin/zsh`, ...)          |
| `COOKIE_SECURE`      | —                | unset       | set to `1` when served over HTTPS             |
| `RESUME_GRACE_MS`    | —                | `300000`    | how long a detached PTY is kept before it is killed |

CLI flags exist too: `--port`, `--host`, `--token`, `--ip-mode`,
`--allowed-ips`, `--console`, `--log-level`, `--help`, `--version` (see
`node server.js --help`).

### Signals a connection can change without a new shell

The gateway understands three client messages beyond keystrokes:

- `{"type":"resize","cols":N,"rows":M}` — full-screen programs redraw.
- `{"type":"detach"}` — keep the shell running in the background and close.
- just reconnecting the plain way resumes: same session → same PTY → replay.

## Reaching it from your laptop

Do **not** open the port to the internet. Pick one of these:

**1. SSH tunnel (simplest, nothing to expose)**

```bash
ssh -L 8080:127.0.0.1:8080 you@your-vps
# then browse http://127.0.0.1:8080  (the token still applies)
```

**2. Tailscale / WireGuard** — bind to the tailnet IP (`HOST=100.x.y.z`) and
only devices on your tailnet can reach it.

**3. Reverse proxy with TLS + real auth** — Caddy/nginx terminating HTTPS in
front of `127.0.0.1:8080`, with HTTP Basic auth or an identity provider on
top, then `COOKIE_SECURE=1`. Only do this if you must have it on the public
internet.

**4. Same LAN** — `npm run lan` (above). Note that plain HTTP on wifi means
the token and session are readable by anyone who can sniff your network. That
is usually fine at home; on shared wifi, use the SSH tunnel or Tailscale
instead.

## Running in Docker

Inside a container, `172.17.x` / `172.18.x` / whatever `hostname -I` says are
**container-network** addresses. A phone in your house cannot reach them, no
matter what the app binds to. Publish the port on the host and use the
*host's* LAN address:

```bash
docker run --rm -it -p 8080:8080 \
  -e TERMINAL_TOKEN='some-long-random-string' \
  -e HOST=0.0.0.0 \
  -v "$PWD":/app -w /app node:24 bash -lc 'npm install && npm start'
```

```yaml
# compose.yaml
services:
  terminal:
    image: node:24
    working_dir: /app
    volumes: [".:/app"]
    command: bash -lc "npm install && npm start"
    ports: ["8080:8080"]
    environment:
      TERMINAL_TOKEN: "some-long-random-string"
      HOST: "0.0.0.0"
```

The gateway detects containers (Docker, Podman, LXC, Pterodactyl) and adapts:
it binds `0.0.0.0` by default there and explains container addresses in the
startup banner. Two things people still get wrong:

- `npm start` would mean `127.0.0.1` **inside** the container, so
  `-p 8080:8080` can't reach it — use `HOST=0.0.0.0` or `npm run lan`.
- Opening `http://172.18.0.162:8080` from your host may work on Linux, but it
  is not a LAN address. Use the host's real IP (`ip addr` on the host, usually
  `192.168.x.x`), not the container's.

The private-network guard still works after publishing: traffic arrives from
`192.168.x.x` (or the docker gateway `172.17.0.1`), both private. Note that
Docker userland proxying can present the docker bridge IP for LAN clients —
`172.17.0.1` is in the allowed private ranges on purpose.

If the image runs as an unprivileged UID with no `/etc/passwd` entry, every
shell shows `I have no name!` and `whoami`/`ps` fail with
`cannot find name for user ID 999`. That is the container image, not this app.
The startup banner warns about it and prints the exact fix:

```dockerfile
RUN echo "user:x:999:999::/home/user:/bin/bash" >> /etc/passwd \
 && mkdir -p /home/user && chown 999:999 /home/user
```

## Testing / CI

```bash
npm test                        # boots the gateway and runs all ~50 contract cases
npm test -- --module test_ws    # a single module
npm test -- --list              # list the cases without booting anything
npm run contract:check          # drift check of contract/ vs the release
```

`contract/` holds the protocol spec (`PROTOCOL.md`), a `VERSION` stamp, and a
**pure-stdlib Python 3.8+ conformance suite** that treats the spec as the
target: a test is allowed to fail against today's server and must never be
weakened to make it pass. Tests are PASS/FAIL/SKIP per case; SKIP says why
(e.g. SSH door disabled, denial cases need `--assert-denied`).

There is no GitHub Actions workflow yet; `npm test` is designed to be the
entire CI job — one command, server included, exit code decides.

## Security — read this before pointing it at a VPS

This app is **remote code execution as a feature**. Anything that can reach
the login page and guess/steal the token owns the account the server runs as.
Concrete choices made here, and what to add for real use:

Already in place:

- Binds to `127.0.0.1` by default; LAN mode only accepts private-network
  clients. `ALLOWED_IPS` narrows it, `ALLOW_PRIVATE_ONLY=0` widens it.
- Token login with constant-time comparison + per-IP lockout: 10 failures →
  429 for 15 minutes. Tokens shorter than 16 chars refuse to start.
- Random 256-bit session cookie, `HttpOnly`, `SameSite=Strict`, 12h idle
  expiry, `Secure` when `COOKIE_SECURE=1`.
- WebSocket upgrade requires the session cookie **and** a same-origin `Origin`
  header (rejects `Origin: null`, blocks cross-site WebSocket hijacking).
- Keystrokes are never logged. Passwords you type into `sudo` stay in the PTY.
- Caps: 4 concurrent PTYs total, 1 per session, 64 KiB max frame, 8 KB post
  bodies, heartbeat with 2-missed-pong reaping. Malformed cookies during a
  WebSocket handshake are answered with 401 instead of killing the process.

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
Description=ptygate web terminal
After=network.target

[Service]
Type=simple
User=term
WorkingDirectory=/opt/ptygate
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

As a learning exercise, yes — this repo shows the whole mechanism, and the
modular layout keeps every concern in one file. As your real door into a
production VPS, prefer a tool that has already been hardened and reviewed:

- **SSH** (`ssh`, or **Tailscale SSH** / **Teleport** / **Boundary** for audits)
- **ttyd** or **Wetty** — a web terminal with auth and TLS support
- **Apache Guacamole** — full remote-desktop gateway
- **code-server** — if you mostly want an IDE with a terminal

The rule of thumb: for shell access, adding a web door usually *reduces*
security versus SSH on a hardened, key-only, fail2ban-guarded port. Use the
tunnel pattern above and you get the convenience without the exposure.

## Repository layout

```
server.js            entry point: CLI, config wiring, startup banner, signals
src/config.js        environment resolution (flags > PTYGATE_* > legacy env > defaults)
src/auth.js          sessions, cookie formatting, token compare, login lockout
src/http.js          express routes: /login /logout /healthz /version /assets
src/ws.js            WebSocket upgrade guard + typed message pipe + heartbeat
src/pty.js           PTY lifecycle, replay ring buffer, capacity limits
src/ip_policy.js     IP normalization, CIDR matching, private-range allowlist
src/console.js       --console local shell bridge
src/logger.js        stderr logger, buffered while console owns the tty
public/login.html    token login page
public/index.html    xterm.js terminal UI with auto-reconnect
contract/            protocol v1 spec + conformance suite (python, stdlib only)
scripts/             env-report.sh, sync-contract.sh, test-contract.sh
```

Note for the curious: `SUMMARY.md` (project history), `CODE_EXPLAINED.md`
(line-walkthrough) and `NPM_PUBLISH.md` (packaging guide) are maintainer notes
and are git-ignored on purpose.
