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

Four ways to start it:

| command            | what you get                                                        |
| ------------------ | ------------------------------------------------------------------- |
| `npm start`        | web UI on this machine only (`127.0.0.1`)                            |
| `npm run lan`      | web UI reachable from other devices in **your house**                |
| `npm run console`  | web UI on localhost **plus a shell in the terminal you started it in** |
| `npm run lan:console` | both of the above at once                                        |

### From your phone / another laptop in the house

```bash
TERMINAL_TOKEN='pick-something-long-and-random' npm run lan
```

The server prints the address to type into your phone, e.g.:

```
  web terminal listening on http://0.0.0.0:8080
  reachable from your house at:
    http://192.168.0.108:8080
```

Open that on any device on the same wifi and paste the token.

LAN mode still only accepts **private network** addresses by default
(`10.x`, `172.16-31.x`, `192.168.x`, `127.x`, `100.64/10`, IPv6 local), so
even if your router forwards the port, connections from the internet get
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

Inside the local shell, `Ctrl+C` goes to the shell (not the server), so to leave
it type `exit`. The server keeps running; press Enter for a new shell, or
`Ctrl+C` at the prompt to stop the server. Server logs printed while you were
in the shell are buffered and shown after you exit, so they don't wreck the
terminal.

Config (env vars):

| var                  | default     | meaning                                                        |
| -------------------- | ----------- | -------------------------------------------------------------- |
| `PORT`               | `8080`      | listen port                                                    |
| `HOST`               | `127.0.0.1` | bind address (`LAN=1` makes it `0.0.0.0`)                       |
| `LAN`                | unset       | `1` = listen on all interfaces and print LAN URLs               |
| `TERMINAL_TOKEN`     | generated   | the only credential; min 16 chars                               |
| `LOCAL_CONSOLE`      | unset       | `1` = same as `--console`                                       |
| `ALLOW_PRIVATE_ONLY` | `1`         | reject connections from non-private IPs                         |
| `ALLOWED_IPS`        | unset       | comma list of IPs/CIDRs; overrides `ALLOW_PRIVATE_ONLY`         |
| `SHELL_BIN`          | `$SHELL`    | shell to spawn (`/bin/bash`, `/usr/bin/zsh`, ...)               |
| `COOKIE_SECURE`      | unset       | set to `1` when served over HTTPS                               |

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

**4. Same LAN** — `npm run lan` (above). Note that plain HTTP on wifi means the
token and session are readable by anyone who can sniff your network. That is
usually fine at home; on shared wifi, use the SSH tunnel or Tailscale instead.


## Security — read this before pointing it at a VPS

This app is **remote code execution as a feature**. Anything that can reach the
login page and guess/steal the token owns the account the server runs as. Concrete
choices made here, and what to add for real use:

Already in place:

- Binds to `127.0.0.1` by default; LAN mode only accepts private-network clients
  and says so loudly in the log.
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
