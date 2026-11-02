# AGENTS.md — read this before you install or build anything

This file is for AI coding agents working inside a panel-managed container.
It is intentionally portable: the exact numbers vary per panel server, so the
rules tell you how to detect the box instead of hard-coding one box's values.
Observed values are quarantined in [Observed examples](#8-observed-examples-do-not-hard-code).

---

## 1. What this environment is

You are in a **container, not a VPS**. Specifically it is usually a
Pterodactyl/Wings-managed Docker container with a Debian 12 userland. The host
kernel is 5.x or 6.8, and the container runs on cgroup v2.

Consequences that change how you work:

- **No init, no systemd.** PID 1 is the panel's start command (or a thin
  wrapper). There is no `systemctl`, no service manager, and no reboot you can
  call. If the process exits, the panel restarts the container.
- **No root and no sudo.** You are an unprivileged numeric uid. `sudo` is
  usually absent (exit 127), and `apt`/`dnf`/`apk` cannot work. In many images
  your uid has **no `/etc/passwd` entry**, so your prompt says
  `I have no name!`, `whoami` fails, and `ps` shows a numeric uid. That is
  cosmetic; it is not a problem you can fix by editing `/etc/passwd`.
- **One network port.** The panel forwards exactly one allocation, exposed as
  `$SERVER_PORT`. There is no 22, no 80, no 443, and no second port. Binding
  anything else means the app is unreachable from outside, even if it works
  on `127.0.0.1` inside the container.
- **Only `$HOME` is persistent and writable.** `$HOME` (usually
  `/home/container`) is owned by your numeric uid and holds the project.
  `/tmp` is a small tmpfs that is wiped on restart. Everything else outside
  `$HOME` is root-owned and read-only for you. Anything you install outside
  `$HOME` is lost when the container is recreated.
- **Resources are small and shared.** The box is usually capped at half a CPU
  core and roughly 600 MB of RAM with **no swap**. `nproc` reports the host's
  thread count, which is misleading. Disk is a shared overlay; the project in
  `$HOME` persists, the rest of the filesystem does not.
- **Nothing survives a restart.** No detached process, no `nohup`, no
  `setsid`, no background dev server. The only durable way to run the app is
  to make it the panel's start command.

The project root normally lives directly in `$HOME`. Treat the repo as the
persistent thing; treat the image as disposable.

---

## 2. Detect, never assume

**The first action on any new box is:**

```sh
sh scripts/env-report.sh
```

Read the `== verdict ==` block at the end. It answers the questions that
matter before you type an install command:

- `VERDICT_WRITABLE_DIRS` — where you may actually write.
- `VERDICT_NPM_GLOBAL_SAFE` — whether `npm install -g` can work at all.
- `VERDICT_GO_TOOLCHAIN` / `VERDICT_RUST_TOOLCHAIN` — whether a compiler
  exists in **this** image.
- `VERDICT_USE_PORT` — the only port worth binding.
- `VERDICT_HOW_TO_INSTALL` — a one-line hint for this box.

Do the same for the rest of the report: identity, writability, container
detection, limits, toolchains, npm, network, disk. All lines are `KEY=value`
so you can grep them:

```sh
sh scripts/env-report.sh | grep -E '^(UID|HOME_WRITABLE|VERDICT_)'
```

Rules of detection:

- **Never assume a runtime exists.** Node in the last image does not imply Go
  in this one. The two containers observed for this project had different
  toolchains.
- **Never assume a port.** Use `$SERVER_PORT`; if it is unset, use
  `VERDICT_USE_PORT`. Do not invent `8080` for external access.
- **Never assume `HOME`.** If `HOME` is unset or `/`, tools fall back to
  writing in the root filesystem and fail with `EACCES`. Check
  `HOME_WRITABLE` and `HOME_OWNED_BY_ME` in the report.
- **Re-detect after a restart.** The panel may recreate the container from
  the image, so a toolchain or SDK from the previous run may be gone.

The report is safe to run repeatedly: it creates a temporary file only for
writability probes and deletes it immediately.

---

## 3. Hard rules

Each rule exists because of a concrete failure mode.

| Rule | Failure it prevents |
|---|---|
| **No `sudo`, `apt`, `apt-get`, `dnf`, `yum`, `apk`, `pacman`.** | `sudo` is a missing binary (exit 127) and package managers need root. You will waste time on a lock file you cannot own. |
| **No writes outside `$HOME`** (except short-lived scratch in `/tmp`). | The path is root-owned: `EACCES`/`permission denied`. Even if it works, it disappears on container restart. |
| **No `npm install -g` unless the prefix is user-writable.** | `npm config get prefix` is usually `/usr/local`, owned by root. Every global install fails with `EACCES` in `/usr/local/lib/node_modules`. This is the #1 permission error for agents. |
| **No assumptions about ports 22, 80, 443, or any port other than `$SERVER_PORT`.** | The app listens successfully but nothing outside can reach it. The panel only forwards its allocation. |
| **No assumptions about systemd/init.** | `systemctl`/`service` do not exist or cannot manage anything; the panel is the supervisor. |
| **No builds in `/tmp`.** | `/tmp` is a ~100 MB tmpfs; compiler temp files, tarballs, and npm caches fill it and the build dies with `ENOSPC`. |
| **No `chmod -R` or `chown -R` on system paths.** | You do not own them; at best you get `Operation not permitted`, at worst you break a shared path with no root to repair it. Chmod only files you created. |
| **No secrets in the repo.** | Tokens, `.env` files, private keys, and panel credentials get committed or leaked in logs. Use panel environment variables. `.gitignore` is not a security boundary. |
| **No detached/background processes.** | `nohup`, `&`, `setsid`, `tmux`, and dev servers die on restart. The panel start command is the only supported supervisor. |
| **No editing `/etc/passwd` or other system files.** | They are root-owned/read-only. The missing passwd entry is cosmetic; fix your prompt instead. |

---

## 4. Install recipes that work as a non-root user

First establish the userland prefix. Check `HOME_WRITABLE` from
`scripts/env-report.sh`; if `HOME` is empty or `/`, point it at the writable
directory the report found (usually `/home/container`):

```sh
# Only if HOME is unset or "/" — verify the path exists and is writable first.
[ -n "${HOME:-}" ] && [ "$HOME" != "/" ] || export HOME=/home/container

export PATH="$HOME/.local/bin:$HOME/.local/go/bin:$HOME/.cargo/bin:$PATH"
mkdir -p "$HOME/.local/bin" "$HOME/tmp" "$HOME/.cache" "$HOME/go/pkg/mod"
```

Persist the PATH for future shells by appending to **your own** profile, not a
system file:

```sh
# Append once; check before adding a duplicate.
grep -q 'HOME/.local/bin' "$HOME/.profile" 2>/dev/null || cat >> "$HOME/.profile" <<'EOF'
export PATH="$HOME/.local/bin:$HOME/.local/go/bin:$HOME/.cargo/bin:$PATH"
export TMPDIR="$HOME/tmp"
export GOCACHE="$HOME/.cache/go-build"
export GOMODCACHE="$HOME/go/pkg/mod"
EOF
```

### npm — userland prefix

Never install globally into root's `/usr/local`. Either set the prefix once,
or pass it per command:

```sh
export NPM_CONFIG_PREFIX="$HOME/.local"
npm config set prefix "$HOME/.local"
export PATH="$HOME/.local/bin:$PATH"

npm install -g some-cli
# equivalent without changing config:
npm install -g --prefix "$HOME/.local" some-cli
```

Project-local dependencies are normal: `npm ci` inside the repo writes
`./node_modules` under `$HOME` and needs no global prefix.

### Go — official tarball into `$HOME/.local/go`

Pick a current Go release; do not assume one is installed. For `amd64`:

```sh
GO_VERSION=1.22.5          # replace with a current release
ARCH=amd64                 # use arm64 if `uname -m` is aarch64/arm64

mkdir -p "$HOME/tmp" "$HOME/.local"
curl -fL "https://go.dev/dl/go${GO_VERSION}.linux-${ARCH}.tar.gz" \
  -o "$HOME/tmp/go.tgz"
# wget fallback: wget -O "$HOME/tmp/go.tgz" "https://go.dev/dl/go${GO_VERSION}.linux-${ARCH}.tar.gz"

rm -rf "$HOME/.local/go"
tar -C "$HOME/.local" -xzf "$HOME/tmp/go.tgz"

export PATH="$HOME/.local/go/bin:$HOME/.local/bin:$PATH"
export GOPATH="$HOME/go"
export GOCACHE="$HOME/.cache/go-build"
export GOMODCACHE="$HOME/go/pkg/mod"
go version
```

Downloading into `$HOME/tmp` instead of `/tmp` matters: the tarball is big
enough to exhaust the tmpfs.

### Rust — rustup into `$HOME/.cargo`

```sh
export CARGO_HOME="$HOME/.cargo"
export RUSTUP_HOME="$HOME/.rustup"

curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
  | sh -s -- -y --profile minimal --no-modify-path

export PATH="$HOME/.cargo/bin:$PATH"
. "$HOME/.cargo/env" 2>/dev/null || true
rustc --version
```

If the box has no network access to `sh.rustup.rs`, use a prebuilt binary or
skip Rust entirely; do not try to `apt install rustc`.

### Prebuilt static binaries — `$HOME/.local/bin`

The best option for tools that have a static release build:

```sh
mkdir -p "$HOME/.local/bin"
curl -fL "https://example.com/tool-linux-amd64" -o "$HOME/.local/bin/tool"
# wget fallback: wget -O "$HOME/.local/bin/tool" "https://example.com/tool-linux-amd64"
chmod +x "$HOME/.local/bin/tool"
"$HOME/.local/bin/tool" --version
```

`chmod +x` only on the file you downloaded. Never `chmod -R` a directory.

### pip — user site only, if pip exists

```sh
python3 -m pip --version || echo "pip not installed; do not apt install it"
python3 -m pip install --user somepkg

export PIP_USER=1
export PYTHONUSERBASE="$HOME/.local"
export PATH="$HOME/.local/bin:$PATH"
```

Debian 12 may mark the system Python as **externally managed** (PEP 668), so
`pip install --user` can be refused. In that case use a venv under `$HOME`
(`python3 -m venv "$HOME/.venv"`) or pass `--break-system-packages` only if you
accept the risk. If `pip` is missing and `python3 -m ensurepip --user` fails,
use a prebuilt binary instead. There is no root to install the distro package.

---

## 5. Build rules for a 0.5-core / ~600 MB box

The numbers here are the observed worst case, not a guarantee. Always read
`CPU_CORES`, `MEMORY_LIMIT_MB`, and `SWAP_MB` from `scripts/env-report.sh` and
size accordingly: a 256 MB box may need an even more minimal build, and a
2 GB box does not need to be this conservative.

Set these before any build. They are not optional niceties; without them a
normal build can exhaust `/tmp` or get OOM-killed.

```sh
export TMPDIR="$HOME/tmp"
export GOCACHE="$HOME/.cache/go-build"
export GOMODCACHE="$HOME/go/pkg/mod"
export GOPATH="$HOME/go"
export CARGO_BUILD_JOBS=1
export CARGO_TARGET_DIR="$HOME/.cache/cargo-target"
export CGO_ENABLED=0
mkdir -p "$TMPDIR" "$GOCACHE" "$GOMODCACHE" "$CARGO_TARGET_DIR"
```

Go:

```sh
go build -p 1 -trimpath -ldflags="-s -w" -o "$HOME/.local/bin/app" ./...
```

Rust:

```sh
cargo build --release -j 1
```

Why each setting exists:

- **`TMPDIR=$HOME/tmp`** — `/tmp` is a ~100 MB tmpfs. Compilers, linkers,
  npm, and tar all use `TMPDIR`; a normal Go/Rust link can exceed the tmpfs
  and fail with `ENOSPC` even though the project disk has tens of GB free.
- **`GOCACHE` / `GOMODCACHE` / `CARGO_TARGET_DIR` under `$HOME`** — caches
  persist across restarts and do not consume the tiny tmpfs. They also avoid
  re-downloading modules on every run.
- **`-p 1` and `CARGO_BUILD_JOBS=1`** — `nproc` shows host threads (often 8),
  but the cgroup quota is usually 0.5 core. Parallel jobs just thrash the
  quota, spike memory, and make the build slower.
- **No swap + ~600 MB** — the linker is the memory peak. Running the app while
  linking, or building several packages in parallel, gets `Killed` (exit 137)
  from the OOM killer, not a compiler error.
- **`CGO_ENABLED=0`** — produces a static binary that runs in a different
  panel image. A cgo binary linked against this image's glibc may fail in
  another image.
- **`-ldflags="-s -w"`** — strips symbols and debug info, shrinking the binary
  so it fits comfortably in `$HOME` and downloads faster.
- **`-trimpath`** — removes build-machine paths from the binary.

If a build still dies, clean caches with `go clean -cache` or delete
`$CARGO_TARGET_DIR`, stop the running app, and retry serially. Do not add swap
(you cannot) and do not raise memory limits (only the panel owner can).

---

## 6. Failure table

| Symptom | Real cause | Fix |
|---|---|---|
| `permission denied` / `EACCES` on `npm install -g` (or on `npm install` of a global package) | `npm config get prefix` is `/usr/local`, owned by root | Set `NPM_CONFIG_PREFIX=$HOME/.local` (or use `--prefix "$HOME/.local"`). Never use `sudo`. |
| Prompt says `I have no name!`; `whoami: cannot find name for user ID ...`; `ps` shows a number | Your uid has no `/etc/passwd` entry | Cosmetic. Set `PS1` manually, use numeric uid, and do not try to edit `/etc/passwd` (root-only). |
| `ENOSPC` / `No space left on device` during a build | `/tmp` is a ~100 MB tmpfs and compilers/tar/npm used it | `export TMPDIR="$HOME/tmp"`, download archives into `$HOME/tmp`, clear old temp files. |
| `Killed` / exit 137 during linking or compilation | `memory.max` is ~600 MB, no swap; parallel jobs or a running app pushed it over | Build with `-p 1` / `-j 1`, stop the app while linking, strip with `-ldflags="-s -w"`, retry. |
| `command not found` for a tool that existed on another box | Images differ; the toolchain is per-container | Run `scripts/env-report.sh`, then install into `$HOME/.local` or use a prebuilt static binary. |
| App is reachable on `127.0.0.1` but not from outside | Bound to loopback, or bound to the wrong port | Bind `0.0.0.0` and use `PORT=$SERVER_PORT`. Only the panel allocation is forwarded. |
| App process is gone (`Killed`, connection lost) after a restart | Nothing survives a container restart; no init keeps detached processes | Make the app the panel start command. Do not rely on `nohup`, `&`, `setsid`, or `tmux`. |
| `EACCES` writing `$HOME/.config` or `$HOME/.npmrc` | `HOME` was unset and tools fell back to `/` | `export HOME=<writable dir from env-report>`; verify `HOME_WRITABLE=yes` first. |
| `sudo: command not found` (exit 127) | `sudo` is not installed and you are not root | Install userland binaries into `$HOME/.local`; there is no privilege escalation. |
| `apt-get: not found`, `Could not open lock file`, `Permission denied` on package install | No package manager or no root | Use prebuilt static binaries, official tarballs, `npm` with a user prefix, or `pip --user`. |
| `System has not been booted with systemd` / `systemctl: command not found` | There is no init system | Run the binary directly as the panel start command. |
| `ssh: connect to host ... port 22: Connection refused`; no sshd | No sshd is installed, and port 22 is not forwarded anyway | Use the panel console (`--console`) or the web UI; no SSH path exists. |
| `git: command not found` | Some images omit git | Download a source tarball with `curl`/`wget` and extract it under `$HOME`; or use a prebuilt binary. |
| `Cannot find module ...` after a restart | Dependencies were installed outside `$HOME` or the container was recreated | Run `npm ci` inside the project under `$HOME` and make that part of the start/setup flow. |
| `free: command not found`, `ping: command not found` | Minimal Debian image; those tools are not installed | Read cgroup files via `scripts/env-report.sh`; use `/proc/meminfo` for a rough view. |
| `chmod: ... Operation not permitted` | You do not own the path | Chmod only files you created under `$HOME`. |

---

## 7. How to install ptygate here

Use a userland prefix and a serial build. The project lives under `$HOME`, so
it survives restarts; the toolchain may not.

### Option A — static Go binary (preferred when Go source is present)

```sh
cd "$PROJECT_ROOT"          # usually $HOME
export TMPDIR="$HOME/tmp"
export GOCACHE="$HOME/.cache/go-build"
export GOMODCACHE="$HOME/go/pkg/mod"
export CGO_ENABLED=0
mkdir -p "$TMPDIR" "$GOCACHE" "$GOMODCACHE" "$HOME/.local/bin"

# Match the image architecture; amd64 is the common panel case.
GOARCH=amd64
[ "$(uname -m)" = "aarch64" ] && GOARCH=arm64

GOOS=linux GOARCH="$GOARCH" \
  go build -p 1 -trimpath -ldflags="-s -w" \
  -o "$HOME/.local/bin/ptygate" ./cmd/ptygate

"$HOME/.local/bin/ptygate" --version
```

The static binary can be copied to another panel image and still run. A cgo
build cannot be trusted to do that.

### Option B — Node from a clone + `npm ci`

`git` is not guaranteed. If it is missing, use the tarball fallback.

```sh
cd "$HOME"

# Put the real clone URL in the panel environment or paste it here. Do not
# guess a repository name.
PTYGATE_REPO='<paste-the-clone-url>'
git clone "$PTYGATE_REPO" ptygate || true

# Fallback when git is absent (replace with the real project archive URL):
# curl -fL '<project-archive-url>' -o "$HOME/tmp/ptygate.tgz"
# tar -xzf "$HOME/tmp/ptygate.tgz" -C "$HOME"
# mv "$HOME/<extracted-directory>" "$HOME/ptygate"

cd "$HOME/ptygate"
npm ci --omit=dev --no-audit --no-fund
```

Do **not** use `npm install -g` for the project. `npm ci` installs into
`./node_modules`, which is under `$HOME` and survives a restart.

`node-pty` is a native addon. If this image has only `node`/`npm` and lacks
`gcc`, `g++`, `make`, and `python3`, `npm ci` will fail while compiling it.
Run `scripts/env-report.sh` first: on a node-only image use the prebuilt/static
gateway instead, or bring prebuilt `node_modules`. Do not assume the build
toolchain exists just because Node does.

### Start command — keep `--console`

The panel start command should be the only long-running process. For this
repository:

```sh
cd "$HOME/ptygate" && \
  PORT="$SERVER_PORT" HOST=0.0.0.0 LAN=1 ALLOW_PRIVATE_ONLY=0 \
  TERMINAL_TOKEN="$TERMINAL_TOKEN" \
  node server.js --console
```

Notes:

- **`--console` is required.** It keeps the panel console attached to a usable
  shell while the web server runs. If the app breaks, that shell is your only
  recovery path; without it you may be left with logs and no prompt.
- **`PORT=$SERVER_PORT`** is the panel allocation. `8080` or `80` is not
  forwarded.
- **`HOST=0.0.0.0` / `LAN=1`** makes the process listen on the container
  interface so Docker can forward to it. `127.0.0.1` is invisible from
  outside.
- **`ALLOW_PRIVATE_ONLY=0`** is needed only because traffic arriving from the
  panel can look like a public source address. Prefer `ALLOWED_IPS` when you
  can; never disable the guard just to make a local test pass.
- **`TERMINAL_TOKEN`** comes from the panel environment or a secret store,
  never from a committed file.
- Do not background this command, and do not start a second copy. The panel
  restarts the container on exit/crash and expects the start command to run in
  the foreground.

### Contract files

The contract (`PROTOCOL.md`, tests, and web assets) is vendored, not a
submodule. Refresh it with:

```sh
scripts/sync-contract.sh          # update ./contract
scripts/sync-contract.sh --check  # verify only; exit 1 on drift
```

`contract/VERSION` selects the release. Do not hand-edit `./contract` and do
not add submodules.

---

## 8. Observed examples (do not hard-code)

These are real values from **two specific boxes** used for this project. They
are here to show the shape of the environment and the amount of variation, not
to be copied into code or CI. Your container may differ on every row.

Other panel images may be Alpine/Ubuntu instead of Debian, run as uid 0,
provide a passwd entry, have a writable npm prefix, allocate extra ports, or
have larger CPU/memory/disk/tmpfs limits. `scripts/env-report.sh` is the
authority; this table is only a reference.

| Observation | Box A | Box B |
|---|---|---|
| UID / GID | `999` / numeric, no `/etc/passwd` entry | `997` / numeric, no `/etc/passwd` entry |
| Prompt | `I have no name!` | `I have no name!` |
| `$HOME` | `/home/container`, owned by the uid | `/home/container`, owned by the uid |
| Writable paths | `$HOME`, `/tmp` | `$HOME`, `/tmp` |
| `cpu.max` (cgroup v2) | `50000 100000` = **0.50 core** | `50000 100000` = **0.50 core** |
| `memory.max` | **≈ 617 MB** | **≈ 589 MB** |
| Swap | none | none |
| `nproc` | `8` (host threads, misleading) | `8` (host threads, misleading) |
| Disk | shared overlay, **≈ 76 GB free** | shared overlay, **≈ 76 GB free** |
| `npm config get prefix` | `/usr/local` (root-owned) | `/usr/local` (root-owned) |
| Toolchain present | `node`, `npm`, `python3`, `gcc`, `g++`, `make` | `node`, `npm` only |
| Toolchain absent | `go`, `rustc`, `cargo`, `sudo`, `apt`, `systemd`, `sshd`, `ssh`, `tmux`, `free`, `ping` | same, plus `gcc`/`g++`/`make`/`python3` |
| Kernel | host 5.x | host 6.8 |
| External network | only `$SERVER_PORT` | only `$SERVER_PORT` |

Build for the **smaller** memory number (~589–617 MB), not for the bigger box.
Detect the real values with `scripts/env-report.sh`; the cgroup files are the
source of truth.

---

## 9. Do not do this (AI-agent edition)

- **Do not invent a port.** Use `$SERVER_PORT`; if unset, use the number in
  `VERDICT_USE_PORT`. Never assume `8080`, `3000`, `22`, `80`, or `443`.
- **Do not disable the IP guard just to make a test pass.** Test over
  loopback, or use `ALLOWED_IPS` for the real client. If the deployed panel
  path needs `ALLOW_PRIVATE_ONLY=0`, keep the token strong and say so in the
  change description.
- **Do not edit `/etc/passwd`, `/etc/group`, or any system file.** You have
  no root and no persistent writable system path.
- **Do not assume `git` exists.** Check `command -v git`; otherwise download a
  tarball with `curl` or `wget`.
- **Do not leave background processes running.** No `nohup`, `&`, `setsid`,
  `tmux`, `screen`, or "temporary" dev servers. They die on restart and can
  hold ports or memory in the meantime.
- **Do not run `npm install -g` with the default prefix.** It writes to
  root-owned `/usr/local` and fails.
- **Do not try `sudo` or a package manager.** Both are unavailable by design.
- **Do not build in `/tmp`.** Point `TMPDIR` at `$HOME/tmp`.
- **Do not write secrets into the repo.** No tokens, keys, `.env` files, or
  credentials in commits, logs, or test fixtures.
- **Do not `chmod -R` or `chown -R` system paths.** Chmod only your own files.
- **Do not assume a runtime because another image had it.** Re-run
  `scripts/env-report.sh` first.
- **Do not replace the panel start command with a daemon.** The start command
  must stay in the foreground and include `--console` so the console remains a
  recovery shell.
