# AGENTS.md — read this before you install, build, or run anything

## 1. What this environment is

You are in a **container, not a VPS**. Specifically, it is typically a
Pterodactyl/Wings-managed Docker container with a minimal Debian or Alpine userland.
The host kernel is 5.x or 6.x, and the container runs under cgroup v2.

Consequences that change how you work:

- **No init, no systemd.** PID 1 is the panel's start command (or a thin wrapper).
  There is no `systemctl`, no service manager, and no reboot command. If the Node
  process exits, the panel supervisor restarts the container.
- **No root and no sudo.** You run as an unprivileged numeric uid. `sudo` is absent
  (exit code 127), and package managers (`apt`, `apk`) cannot run without root.
  In many container images, your numeric uid has **no `/etc/passwd` entry**;
  prompts may say `I have no name!`, `whoami` fails, and `ps` shows only numbers.
  This is cosmetic; do not attempt to edit `/etc/passwd`.
- **One network port.** The panel forwards exactly one port allocation, exposed as
  `$SERVER_PORT`. Ports 80, 443, 22, and 8080 are not forwarded. Binding anything
  other than `$SERVER_PORT` means the app is unreachable from outside the host.
- **Only `$HOME` is persistent and writable.** `$HOME` (typically `/home/container`)
  is owned by your numeric uid and holds the application. `/tmp` is a tiny tmpfs
  wiped on restart. Files written outside `$HOME` are lost when the container is recreated.
- **Resources are constrained.** Containers are typically restricted to 0.5–1.0 CPU cores
  and ~512–600 MB of RAM with **zero swap**. `nproc` reports host threads (misleading).
  Memory spikes trigger immediate OOM kills (`Killed`, exit code 137).
- **Nothing survives a restart.** Detached processes (`nohup`, `&`, `screen`, `tmux`,
  background dev servers) die on restart. The panel start command is the supervisor.

---

## 2. Detect, never assume

The first action on any new container instance:

```sh
sh scripts/env-report.sh        # aliases: npm run env:report
```

Read the `== verdict ==` block at the end of the report:
- `VERDICT_WRITABLE_DIRS` — where files and caches may be written.
- `VERDICT_NPM_GLOBAL_SAFE` — whether the default global npm directory is writable (usually NO).
- `VERDICT_USE_PORT` — the allocated network port to bind.
- `VERDICT_HOW_TO_INSTALL` — actionable summary for this instance.

Key environment checks:
```sh
sh scripts/env-report.sh | grep -E '^(UID|HOME_WRITABLE|NODE_|VERDICT_)'
```

Rules of detection:
- **Never hard-code ports.** Always bind `$PORT` or `$SERVER_PORT` (`VERDICT_USE_PORT`).
- **Never assume `$HOME` is set properly.** If `HOME` is empty or `/`, tools write to
  root and fail with `EACCES`. Verify `HOME_WRITABLE=yes`.
- **Re-verify after container restarts.** The panel may pull or reset container images.

---

## 3. Hard rules for Node.js agents

| Rule | Failure it prevents |
|---|---|
| **No `sudo`, `apt`, `apt-get`, `apk`, `dnf`.** | Missing binary or permissions error. You cannot install OS-level packages. |
| **No writes outside `$HOME`** (except short-lived scratch files in `$HOME/tmp`). | Root-owned paths fail with `EACCES`. `/tmp` is a tiny tmpfs (~100 MB) prone to `ENOSPC`. |
| **No `npm install -g` without custom user prefix.** | Default prefix is `/usr/local` (root-owned). Global npm installs fail with `EACCES`. |
| **No assumptions about ports 80, 443, 3000, 8080.** | Only `$SERVER_PORT` is forwarded by the panel. |
| **No detached background processes.** | Background processes (`&`, `nohup`) die on container restart. |
| **No secrets committed to the repo.** | Tokens and credentials must come from environment variables. |
| **No editing `/etc/passwd`.** | System files are read-only for unprivileged containers. |

---

## 4. Node.js & npm setup in non-root containers

### Userland npm prefix (Avoid EACCES)

The default global prefix (`/usr/local`) is read-only. Configure npm to use `$HOME/.local`:

```sh
[ -n "${HOME:-}" ] && [ "$HOME" != "/" ] || export HOME=/home/container

mkdir -p "$HOME/.local/bin" "$HOME/.local/lib" "$HOME/tmp" "$HOME/.npm"
npm config set prefix "$HOME/.local"
npm config set cache "$HOME/.npm"

export PATH="$HOME/.local/bin:$PATH"
export TMPDIR="$HOME/tmp"
```

To persist across interactive shells, add this once to `$HOME/.profile`:

```sh
grep -q 'HOME/.local/bin' "$HOME/.profile" 2>/dev/null || cat >> "$HOME/.profile" <<'EOF'
export PATH="$HOME/.local/bin:$PATH"
export TMPDIR="$HOME/tmp"
EOF
```

Now any global CLI utilities install cleanly without sudo:
```sh
npm install -g <package-name>
```

### Node requirements & native compilation caveats (`node-pty`)

- **Node Version:** Node.js `>=20.0.0` is required (uses native ES modules and crypto features).
- **Native Addon (`node-pty`):** `node-pty` relies on native C++ bindings compiled with `node-gyp`.
  - Minimal container images often lack build essentials (`gcc`, `g++`, `make`, `python3`).
  - Running `npm install` or `npm ci` on an image without build tools will fail while compiling `node-pty`.
  - Check with `command -v gcc g++ make python3`. If missing, pre-build or preserve `./node_modules` inside `$HOME`.
- **Project-local install:**
  ```sh
  npm ci --omit=dev --no-audit --no-fund
  ```
  Dependencies are stored in `./node_modules` under `$HOME`, which persists across restarts.

---

## 5. Memory & resource limits (~600 MB RAM)

Containers often run on 0.5 CPU core quota and ~500–600 MB RAM without swap.

Best practices:
- **Limit V8 heap usage:**
  Pass `--max-old-space-size=384` if Node is running memory-intensive operations:
  ```sh
  NODE_OPTIONS="--max-old-space-size=384" node server.js
  ```
- **Bounded Buffers:**
  The terminal server implements a bounded ring buffer (256 KiB) per PTY session.
  Do not hold unbounded output in memory.
- **Serial operations:** Avoid running concurrent heavy npm tasks.

---

## 6. Project layout & documentation

```
server.js                entry point (CLI parsing, wiring, startup banner)
src/                     gateway implementation, one concern per module
  config.js              config resolution (CLI flags > PTYGATE_* > legacy env > defaults)
  auth.js                sessions, cookie formatting, token compare, login lockout
  http.js                express routes (/login /logout /healthz /version /assets)
  ws.js                  WebSocket upgrade guard + message pipe + heartbeat
  pty.js                 PTY lifecycle, replay ring buffer, capacity limits
  ip_policy.js           IP normalization, CIDR matching, private-range allowlist
  console.js             --console local shell bridge
  logger.js              stderr logger with buffering while console owns the tty
public/                  login page + xterm.js terminal UI
contract/                protocol v1 spec + language-agnostic conformance suite
scripts/                 env-report.sh, sync-contract.sh, test-contract.sh
```

Available npm scripts (see README for details):
`start`, `lan`, `console`, `lan:console`, `dev`, `dev:lan`, `check`, `test`,
`contract:sync`, `contract:check`, `env:report`.

Documentation status:
- `README.md` — public, committed, keep up to date.
- `contract/PROTOCOL.md` — the wire protocol + conformance expectations; the
  implementation must conform to it, never the other way round.
- `SUMMARY.md`, `CODE_EXPLAINED.md`, `NPM_PUBLISH.md` — **personal notes, git-
  ignored on purpose.** They exist locally for the maintainer; do not commit,
  reference them publicly, or delete them. Re-generate content, not presence.

---

## 7. How to run ptygate in the container

### Start Command (Pterodactyl Panel)

The panel start command must run in the foreground with `--console`:

```sh
cd "$HOME" && \
  PORT="$SERVER_PORT" HOST=0.0.0.0 LAN=1 ALLOW_PRIVATE_ONLY=0 \
  TERMINAL_TOKEN="$TERMINAL_TOKEN" \
  node server.js --console
```

Why each argument matters:
- **`--console`:** Keeps the panel console attached to an interactive recovery shell while the HTTP/WebSocket server runs. If web connectivity fails, this shell remains accessible.
- **`PORT=$SERVER_PORT`:** Binds to the single TCP allocation assigned to the container.
- **`HOST=0.0.0.0` / `LAN=1`:** Binds all network interfaces so traffic forwarded through Docker reaches the process.
- **`ALLOW_PRIVATE_ONLY=0`:** Panel routing frequently translates remote client connections into public-facing IPs. Setting this to `0` allows external browser access while enforcing strong token authentication.
- **`TERMINAL_TOKEN`:** Minimum 16-character secret configured via the panel environment.

---

## 8. Failure & troubleshooting table

| Symptom | Cause | Solution |
|---|---|---|
| `EACCES: permission denied, mkdir '/usr/local/lib/node_modules'` | `npm install -g` attempting to write to root path | Run `npm config set prefix "$HOME/.local"` and add `$HOME/.local/bin` to `PATH`. |
| `gyp ERR! find Python` or `make: not found` during `npm ci` | Image lacks build toolchain for `node-pty` | Check `gcc`/`make`/`python3`. Use pre-installed `node_modules` in `$HOME`. |
| Prompt says `I have no name!`, `whoami` fails | Numeric UID has no `/etc/passwd` record | Harmless cosmetic artifact of rootless containers. Do not attempt to fix `/etc/passwd`. |
| `ENOSPC` during install or package extraction | `/tmp` is a tiny tmpfs that filled up | Export `TMPDIR="$HOME/tmp"` and clear temporary files. |
| Process exits with code 137 (`Killed`) | Container exceeded memory limits (OOM) | Ensure bounded ring buffers and run Node with `--max-old-space-size=384`. |
| App reachable on `127.0.0.1` but not from outside | Bound to loopback or wrong port | Bind `0.0.0.0` and use `PORT=$SERVER_PORT`. |
| Connection dropped immediately with HTTP 403 | IP policy rejection | Set `ALLOW_PRIVATE_ONLY=0` or set `ALLOWED_IPS` to include your IP. |
| Server restarts repeatedly | Foreground process exited or crashed | Run `npm run check` to inspect syntax and review startup logs. |


## Git Commits

- Format: `<type>(<optional scope>): <summary>` — e.g. `feat(auth): add password reset flow`
- Allowed types:
  - `feat` — new feature
  - `fix` — bug fix
  - `refactor` — code change that is neither feat nor fix
  - `docs` — documentation only
  - `test` — adding or fixing tests
  - `chore` — tooling, config, dependencies, housekeeping
  - `perf` — performance improvement
  - `style` — formatting, whitespace, no logic change
  - `build` — build system or dependency changes
  - `ci` — CI/CD configuration changes
  - `revert` — revert of a previous commit
- Scope: short lowercase noun for the affected area (`api`, `ui`, `db`, `auth`...). Omit if hard to name.
- Summary line: imperative mood ("add", not "added"), lowercase start, no trailing period, max ~72 chars.
- Body (optional, separated by a blank line): what and why, not how. Wrap at ~72 chars.
- Breaking changes: add `!` after type (e.g. `feat!:` change public API response shape) and a `BREAKING CHANGE:` footer describing the migration.
- Reference issues in the footer/trailer when applicable: `Closes #42`, `Refs #17`.
- Never commit secrets, generated files, or unrelated changes in the same commit. One logical change per commit.