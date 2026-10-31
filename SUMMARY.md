# Web Terminal Gateway — build summary

A short record of what this project is, how it works, and how we made it reachable
from outside — including the mistakes we hit along the way.

---

## 1. What it is

A web page that gives you a **real shell on the machine running the server**.
You type in the browser, commands run on the server, output streams back live.

It is not a "run this one command" API. It is an actual terminal:

- `sudo apt install ...` works — it prompts for a password in the browser
- `nano`, `htop`, `top` render properly
- `cd`, `export`, shell history persist inside the session
- long-running processes keep running, `Ctrl+C` sends a real SIGINT

That is possible because everything goes through a **PTY** (a pseudo-terminal,
`/dev/pts/N`), the same mechanism SSH uses.

---

## 2. Architecture

```
   Browser                          Node server                    OS
┌──────────────┐   WebSocket   ┌──────────────────┐   PTY   ┌──────────────┐
│ xterm.js     │◄─────────────►│ ws + express     │◄───────►│ /bin/bash -l │
│ terminal UI  │   JSON msgs   │ auth, IP guard   │  bytes  │ /dev/pts/N   │
└──────────────┘               └──────────────────┘         └──────────────┘
        ▲                               ▲
        │ HTTP (login, HTML, CSS)       │ node-pty spawns the shell
        └───────────────────────────────┘
```

Components:

| Part | Package | Job |
|---|---|---|
| Terminal UI | `@xterm/xterm` + `@xterm/addon-fit` | draws the terminal, captures keys |
| HTTP server | `express` | login, session cookie, static files |
| WebSocket | `ws` | carries input/output between browser and server |
| PTY | `node-pty` | spawns a real shell attached to a pseudo-terminal |

---

## 3. How one keystroke travels

1. You press `l` in the browser.
2. xterm.js calls `onData("l")`.
3. The page sends `{"type":"input","data":"l"}` over the WebSocket.
4. The server writes those bytes into the PTY: `term.write("l")`.
5. Bash reads `l` from `/dev/pts/N`, echoes it, repaints the line.
6. Output comes back: `term.onData(...)` → `{"type":"output","data":"..."}`.
7. xterm.js renders it, including colors and cursor movement.

Resizing the browser sends `{"type":"resize",cols,rows}`, which calls
`term.resize()` so `vim`/`htop` know the real window size.

---

## 4. Why a PTY and not `POST /run {cmd}`

| Approach | One-shot commands | sudo prompt | nano/htop | shell state | long jobs |
|---|---|---|---|---|---|
| `POST` + `exec` | yes | no | no | no | no |
| PTY + WebSocket | yes | yes | yes | yes | yes |

A plain `exec` has no terminal, so programs that ask questions, draw screens, or
expect a `tty` break immediately. The PTY is what makes it a *terminal* instead
of a command runner.

---

## 5. Files

```
server.js           HTTP + WebSocket + PTY, auth, IP guard, local console
public/login.html   token login page
public/index.html   xterm.js terminal UI, auto-reconnect
package.json        scripts: start, lan, console, lan:console
README.md           setup and security notes
SUMMARY.md          this file
```

---

## 6. Running it

| Command | What you get | Binds to |
|---|---|---|
| `npm start` | web UI on this machine | `127.0.0.1:8080` |
| `npm run lan` | web UI reachable from the local network | `0.0.0.0:8080` |
| `npm run console` | web UI + a shell in the server's own terminal | `127.0.0.1:8080` |
| `npm run lan:console` | both | `0.0.0.0:8080` |
| `node server.js --console` | same as above via flag | depends on `HOST` |

The token is printed on startup:

```
  access token: SI4BTA8FL58m0uGvS1eNtF-axVqZAYUQ   (generated for this run)
```

Set `TERMINAL_TOKEN=...` to keep it stable across restarts.

---

## 7. How we made it reachable from outside

This was the hard part, and the lesson is: **"reachable" is not a code feature,
it is a network-path question.** The app can only listen; something else has to
route traffic to it.

### 7.1 The decision table

| Where the app runs | What to do | Why |
|---|---|---|
| Your own PC | `npm start` + SSH tunnel, or `npm run lan` | loopback is safest; LAN for phones |
| Home LAN | `npm run lan`, open `http://<LAN-IP>:8080` | LAN IP is real and reachable |
| Docker | publish the port `-p 8080:8080`, use the **host's** LAN IP | container IPs die at the bridge |
| Pterodactyl / game panel | `PORT=$SERVER_PORT`, open `http://<node-IP>:<SERVER_PORT>` | only allocated ports are forwarded |
| Remote VPS | `npm start` + `ssh -L 8080:127.0.0.1:8080 user@vps` | nothing exposed, still reachable |
| Reverse proxy | nginx/Caddy → `127.0.0.1:8080`, add TLS + auth | public HTTPS, no raw port |

### 7.2 Home LAN

```bash
TERMINAL_TOKEN='long-random-value' npm run lan
```

Prints the address to use on a phone:

```
  web terminal listening on http://0.0.0.0:8080
  addresses on this machine:
    http://192.168.0.108:8080   (wlo1)
```

Open that on any device on the same wifi.

### 7.3 Remote VPS — the SSH tunnel (recommended)

```bash
# on the VPS
TERMINAL_TOKEN='long-random-value' npm start     # binds 127.0.0.1 only

# on your laptop (keep this running)
ssh -N -L 8080:127.0.0.1:8080 user@VPS_IP

# browser
http://127.0.0.1:8080
```

Why it passes the private-network guard: the tunnel delivers the connection to
the VPS **from 127.0.0.1**, so the server sees a private address. The port is
never open to the internet. Works from any country.

### 7.4 Docker

Inside a container, `172.17.x` / `172.18.x` are **container-network addresses**.
Nothing outside Docker can reach them. Publish the port on the host:

```bash
docker run --rm -it \
  -p 8080:8080 \
  -e TERMINAL_TOKEN='long-random-value' \
  -e HOST=0.0.0.0 \
  -v "$PWD":/app -w /app \
  node:24 bash -lc 'npm install && npm start'
```

Then open `http://<HOST-LAN-IP>:8080` — the **host's** IP, not the container's.

Critical: `npm start` binds `127.0.0.1` *inside* the container, so `-p` cannot
reach it. In containers use `HOST=0.0.0.0` (or `npm run lan`).

### 7.5 Pterodactyl / game panel (what we actually used)

Pterodactyl gives the container only **allocated** ports, passed in as
`SERVER_PORT`. Port `8080` is invisible. The working start command was:

```bash
LAN=1 ALLOW_PRIVATE_ONLY=0 PORT=$SERVER_PORT node server.js --console
```

And the URL to open:

```
http://<node-public-ip>:57505
```

with the token from the startup log.

Two flags matter there:

- `LAN=1` → bind `0.0.0.0` so Docker's port mapping can reach it.
- `ALLOW_PRIVATE_ONLY=0` → from outside, your connection arrives with a
  **public** source IP, which the default guard would reject with 403.

Made permanent in `package.json`:

```json
"lan:console": "LAN=1 ALLOW_PRIVATE_ONLY=0 PORT=${SERVER_PORT:-8080} node server.js --console"
```

### 7.6 What we got wrong at first

| Symptom | Real cause |
|---|---|
| `http://172.18.0.162:8080` unreachable from home | that's a Docker bridge IP, not a LAN/public IP |
| 403 Forbidden from a public IP | `ALLOW_PRIVATE_ONLY=1` blocks non-private sources |
| `-p 8080:8080` didn't work | the app was bound to `127.0.0.1` inside the container |
| Opened the wrong port | Pterodactyl only forwards `SERVER_PORT` (57505), not 8080 |
| `bash: Ctrl+C: command not found` | the words "Ctrl+C" were typed as text; it's a key combo |
| `I have no name!` | uid 999 has no `/etc/passwd` entry in the image |

---

## 8. Security model

This app is **remote code execution as a feature**. Losing the token = losing
the account the server runs as.

In place:

- Token login, constant-time comparison, lockout after 10 failures per IP.
- 256-bit session cookie, `HttpOnly`, `SameSite=Strict`, 12h idle expiry.
- WebSocket requires the session cookie **and** a same-origin `Origin` header.
- IP guard: private ranges only by default (`ALLOW_PRIVATE_ONLY`), optional
  `ALLOWED_IPS=<cidr,...>` allowlist.
- Loopback bind by default; LAN/public binding must be asked for explicitly.
- Keystrokes and passwords are never logged.
- Concurrent PTY caps, 64 KiB frame limit, WebSocket heartbeat.

Not included, and needed for real use:

- TLS (the token travels in cleartext over plain HTTP)
- A dedicated unprivileged user
- Edge rate limiting / fail2ban
- Session recording if you need an audit trail

Rule of thumb: for shell access, a web door is usually *less* safe than SSH with
keys and fail2ban. Use the tunnel and you get convenience without exposure.

---

## 9. The environment we tested on

Pterodactyl-managed Docker container:

| Resource | Value |
|---|---|
| OS | Debian 12 (bookworm), container on an Ubuntu 6.8 kernel |
| CPU | Intel Xeon E5-1620 v2, 8 host threads |
| CPU limit | `50000 100000` → **0.5 core** |
| RAM limit | `617398272` bytes → **~589 MB** |
| RAM used | `90914816` bytes → **~87 MB** |
| Disk | host overlay 145 GB, 76 GB free |
| Project size | 161 MB (`/home/container`) |
| Internal IP | `172.18.0.162` |
| Public IP | `54.36.179.2` (host node) |
| Allocated port | `SERVER_PORT=57505` |
| User | uid 999, no passwd entry, no sudo, no ssh-keygen |

Useful one-liners in such a container:

```sh
cat /etc/os-release
nproc
cat /sys/fs/cgroup/cpu.max        # quota period -> cores = quota/period
cat /sys/fs/cgroup/memory.max     # bytes
cat /sys/fs/cgroup/memory.current
df -h /
du -sh /home/container
node -e "console.log(require('os').networkInterfaces())"
node -e "fetch('https://api.ipify.org').then(r=>r.text()).then(console.log)"
```

---

## 10. Known limits

- **Dropped connection = dead shell.** The session lives on the WebSocket; a
  reconnect starts a fresh shell with no history or state.
- **Single user.** One token, one identity; no per-user accounts.
- **No persistence layer.** No session replay, no shared sessions between the
  panel console and the browser.
- **No file upload/download.** Text only, through the terminal.
- **No TLS built in.** Put it behind a proxy or a tunnel.

---

## 11. Command cheat sheet

```bash
npm install                              # dependencies

TERMINAL_TOKEN='x' npm start             # localhost only
TERMINAL_TOKEN='x' npm run lan           # home network
TERMINAL_TOKEN='x' npm run console       # + shell in this terminal
TERMINAL_TOKEN='x' npm run lan:console   # both

PORT=57505 LAN=1 ALLOW_PRIVATE_ONLY=0 \
  node server.js                         # panel/exposed test

ssh -N -L 8080:127.0.0.1:8080 u@host     # tunnel from a laptop

curl -s localhost:8080/healthz           # -> ok
```

---

## 12. If you build this again

1. Start with the PTY. It is the only piece that makes it a real terminal.
2. Keep it on `127.0.0.1` and reach it through an SSH tunnel. That solves 90% of
   the exposure problem with zero code.
3. Add LAN mode only when you actually need phones on the same wifi.
4. Treat the token as a root password.
5. When "it's not reachable", check in this order: *which IP am I opening? which
   interface is it bound to? is the port published? does the source IP pass the
   guard?* — in our case it was all four.
