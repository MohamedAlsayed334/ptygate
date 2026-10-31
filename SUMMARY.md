# Web Terminal Gateway — how we built it and how we connected

What this project is, and the exact route we used to reach it — no SSH, no
server of our own. Just a Pterodactyl panel, a container, and one forwarded port.

---

## 1. The goal

Get a **real terminal in a browser**: type a command, it runs on the machine
running the server, output comes back live. Like SSH, but in a web page.

---

## 2. What we built

```
Browser (xterm.js)  ──WebSocket──►  Node server  ──PTY──►  /bin/bash
```

- `xterm.js` in the page draws the terminal and captures keys.
- A Node server (`express` + `ws`) relays bytes over a WebSocket.
- `node-pty` spawns a real shell attached to `/dev/pts/N`.

Because it is a real PTY, interactive things work: `sudo` prompts, `nano`,
`htop`, `Ctrl+C`, long-running jobs.

---

## 3. How it works, keystroke by keystroke

1. You press `l`.
2. xterm.js sends `{"type":"input","data":"l"}` over the WebSocket.
3. The server writes `l` into the PTY.
4. Bash reads it from `/dev/pts/N` and echoes it.
5. Output comes back as `{"type":"output","data":"..."}`.
6. xterm.js paints it, colors and all.

Resizing the window sends `{"type":"resize",cols,rows}` so full-screen programs
redraw correctly.

---

## 4. Files and scripts

```
server.js           HTTP + WebSocket + PTY + auth + IP guard
public/login.html   token login page
public/index.html   terminal UI with auto-reconnect
package.json        start / lan / console / lan:console
```

---

## 5. The actual access path (this is what we did)

### 5.1 What the panel gives you

Pterodactyl does **not** expose your container. It exposes one allocated port
per server, passed into the container as `SERVER_PORT`.

Ours was:

```
public IP : 54.36.179.2      (the host node, not the container)
port      : 57505            ($SERVER_PORT)
container : 172.18.0.162     (internal, useless from outside)
```

The container IP is a Docker bridge address. It only exists inside that host.
That is why `http://172.18.0.162:8080` never worked from a phone or laptop.

### 5.2 Find the port

The app runs with `--console`, so the panel console is a shell. In it:

```sh
echo $SERVER_PORT
```

Result: `57505`.

### 5.3 Start the server on that port

```sh
LAN=1 ALLOW_PRIVATE_ONLY=0 PORT=$SERVER_PORT node server.js --console
```

Each flag is there for a reason:

| Flag | Why |
|---|---|
| `PORT=$SERVER_PORT` | 57505 is the only port the panel forwards. 8080 is invisible. |
| `LAN=1` / `HOST=0.0.0.0` | inside the container the app must listen on all interfaces, or Docker can't forward to it |
| `ALLOW_PRIVATE_ONLY=0` | from outside, your connection arrives with a **public** source IP, and the default guard rejects those with 403 |
| `--console` | keeps the panel console usable as a shell at the same time |

Startup output:

```
  web terminal listening on http://0.0.0.0:57505
  addresses on this machine:
    http://172.18.0.162:57505   (eth0: container network, not your LAN)
  access token: SI4BTA8FL58m0uGvS1eNtF-axVqZAYUQ   (generated for this run)
```

### 5.4 Open the URL in a browser

```
http://54.36.179.2:57505
```

That is the host's public IP plus the allocated port — the only combination
that reaches the app. Not the container IP, not 8080.

### 5.5 Log in

Paste the `access token:` value from the log. You land in the terminal.

### 5.6 Make it permanent

The panel runs `npm run lan:console`. Put the port and flags there so every
restart works without typing anything:

```json
"lan:console": "LAN=1 ALLOW_PRIVATE_ONLY=0 PORT=${SERVER_PORT:-8080} node server.js --console"
```

---

## 6. Why each address did what it did

| Address | What it is | Reachable from your house? |
|---|---|---|
| `127.0.0.1` | loopback inside the container | no |
| `172.18.0.162` | Docker bridge IP | no |
| `54.36.179.2:8080` | host IP, but 8080 is not allocated | no |
| `54.36.179.2:57505` | host IP + allocated port | **yes** |

The rule: the app can bind to anything, but only an address the panel forwards
gets traffic. Bind `0.0.0.0`, use `SERVER_PORT`, open the host IP.

---

## 7. What we changed in the code to get here

Starting from a localhost-only demo, we added:

1. **LAN mode** — `LAN=1` binds `0.0.0.0` and prints the machine's addresses.
2. **IP guard** — private ranges only by default (`ALLOW_PRIVATE_ONLY`), with
   `ALLOWED_IPS` for a stricter allowlist. This is why `ALLOW_PRIVATE_ONLY=0`
   was needed for a public client.
3. **Container awareness** — prints the token in the startup block, labels
   Docker addresses as "container network, not your LAN", and warns when the
   uid has no `/etc/passwd` entry.
4. **Local console** — `--console` turns the server's own stdin into a shell,
   with logs buffered so they don't corrupt the terminal.

---

## 8. The exact failures we hit

| What happened | Why | Fix |
|---|---|---|
| `http://172.18.0.162:8080` never loaded | container IP, not forwarded | use host IP + `SERVER_PORT` |
| Port forwarding did nothing | app bound `127.0.0.1` inside the container | `LAN=1` |
| Couldn't open it from outside | guard only allowed private IPs | `ALLOW_PRIVATE_ONLY=0` |
| `bash: Ctrl+C: command not found` | the words were typed as text | press Ctrl and C together |
| `I have no name!`, `whoami` fails | uid 999 has no `/etc/passwd` entry | cosmetic; fix with a passwd entry if you control the image |
| `free`, `ping`, `ssh-keygen` not found | minimal Debian image | not installed, and no root to add them |
| `Connection lost. Reconnecting in 1s...` | WebSocket dropped | auto-reconnects, but **starts a fresh shell** |

---

## 9. Security, in one screen

The web page is **remote code execution as a feature**. The token is the only
lock.

In place:

- token login with constant-time compare, lockout after 10 failed tries
- session cookie: `HttpOnly`, `SameSite=Strict`, 12h idle expiry
- WebSocket needs the cookie **and** a same-origin `Origin` header
- IP allowlist / private-only guard
- loopback bind by default
- keystrokes and passwords never logged

Missing for real use:

- **TLS** — with `ALLOW_PRIVATE_ONLY=0` on a public port, the token crosses the
  internet in cleartext. Anyone who can sniff it can take the shell.
- a dedicated unprivileged user
- fail2ban or edge rate limiting
- session recording if you need an audit trail

Practical advice for this setup: use a long random `TERMINAL_TOKEN`, and when
you're done experimenting set `ALLOW_PRIVATE_ONLY=1` again or stop the server.

---

## 10. The box we ran it on

| Resource | Value |
|---|---|
| OS | Debian 12 (bookworm) container, Ubuntu 6.8 kernel |
| CPU | Xeon E5-1620 v2, 8 host threads |
| CPU limit | `50000 100000` → **0.5 core** |
| RAM limit | 617398272 B → **~589 MB** |
| RAM used | 90914816 B → **~87 MB** |
| Disk | 145 GB host, 76 GB free; project 161 MB |
| User | uid 999, no passwd entry, no sudo |
| Public IP | 54.36.179.2 |
| Port | 57505 |

That is a small shared container. Fine for this app, not for real workloads.

---

## 11. Limits

- **Connection drop kills the shell.** State lives on the WebSocket; reconnect
  starts fresh.
- **One user, one token.** No accounts.
- **No file upload/download.** Text only.
- **No TLS built in.**
- **`--console` and the browser are separate shells.** They don't share state.

---

## 12. Cheatsheet

```sh
# in the panel console
echo $SERVER_PORT
LAN=1 ALLOW_PRIVATE_ONLY=0 PORT=$SERVER_PORT node server.js --console

# open in browser
http://54.36.179.2:57505

# health check from inside
curl -s localhost:57505/healthz      # -> ok

# stop a test copy started with &
kill %1
```

That's the whole gateway: **panel console → run on `SERVER_PORT` → host IP +
that port in the browser → token**. No SSH involved.
