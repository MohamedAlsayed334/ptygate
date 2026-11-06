# CONTAINER-FACTS.md — Verified container environment for AI agents

> Read this **before** installing, building, compiling, or running anything.
> Facts below were verified by direct probing on 2026-11-06. Platform limits can
> change on container recreation — re-verify anything critical with the probe
> snippet at the end of this file.

## 1. What this machine is (and is not)

| Fact | Value |
|---|---|
| Type | Unprivileged **Docker container** on an Azure VM (HidenCloud panel) |
| OS | Debian 13 "trixie" |
| **CPU arch** | **aarch64 / ARM64** — do NOT download or assume x86_64/amd64 binaries |
| Kernel | Linux 6.17 (ubuntu-azure), cgroup v2 |
| Identity | `uid=997` (user `systemd-timesync`), `gid=986` — **no** `/etc/passwd` entry for this uid; cosmetic, harmless |
| Login shell | `$SHELL=/usr/sbin/nologin`, but the terminal/PTY shell runs `/bin/bash -l` under `$HOME=/home/container` |
| Init | PID 1 is **`tini`**, not systemd — `systemctl`/`service` exist but there is no systemd running; do not use them |
| Working home | `/home/container` — the **only** persistent, writable directory that matters |

## 2. Hard limits (verified via cgroups — `nproc` and `free` LIE)

`nproc` reports 16 and `free -m` reports 128 GB because they read the **host**,
not this container. The real limits:

| Resource | Limit | How to check |
|---|---|---|
| CPU | **2.0 cores** (`cpu.max: 200000 100000`) | `cat /sys/fs/cgroup/cpu.max` |
| Memory | **~3.38 GB** (`memory.max: 3543347200`) | `cat /sys/fs/cgroup/memory.current` to see usage |
| Swap for this container | none — exceeding memory = instant OOM kill, **exit code 137** | UI panel or `memory.current` vs `memory.max` |
| `/tmp` | tmpfs, **512 MB, wiped on every restart** | `df -h /tmp` |
| Disk | `/` is a read-only overlay; `/home/container` sits on shared host storage (~991 GB shown — **not** a per-container quota; do not trust it as private space) | `df -h $HOME` |
| Open files | 524288 (generous) | `ulimit -n` |

Practical consequences:

- Keep Node.js services bounded: prefer `NODE_OPTIONS=--max-old-space-size=384` (or at most ~1024) for long-running services. A memory spike = `Killed` (137).
- Never write build temp files outside `$HOME` or short-lived `/tmp`; billing-safe default:
  ```sh
  mkdir -p "$HOME/tmp" && export TMPDIR="$HOME/tmp"
  ```
- Long single-CPU builds (gcc/rust native modules) will take roughly 2x longer than on a laptop core.

## 3. What survives a restart, and what dies

- The hosting panel runs the **start command in the foreground**; when it exits, the container is restarted/recreated.
- **Everything potest dies on restart except what is under `$HOME` (`/home/container`)**: `/tmp` is erased, all child processes are killed, `nohup`/`&`/`tmux`/`screen` sessions do NOT survive, and background services you detach will be killed. Put state only in `$HOME`.
- Run long jobs **in the foreground of the PTY** or as children of `npm start`, never as detached background daemons.

## 4. Runtime tools — current availability and versions

| Tool | Available | Version | Path |
|---|---|---|---|
| bash | YES | (Debian default) | `/usr/bin/bash` |
| node | YES | **v26.13.0** | `/usr/local/bin/node` |
| npm | YES | 12.2.1 | `/usr/local/bin/npm` |
| npx | YES | — | `/usr/local/bin/npx` |
| python3 | YES | 3.13.5 | `/usr/bin/python3` |
| python 2 | NO | — | — |
| pip / pip3 | **NO** | install python deps via `python3 -m venv` + `venv/bin/pip` only if the project needs it | — |
| git | YES | 2.47.3 | `/usr/bin/git` |
| curl | YES | 8.14.1 | — |
| wget | NO | use `curl -O` instead | — |
| gcc / g++ / make | YES | 13 (aarch64) — native compiles work | `/usr/bin/gcc` etc. |
| cmake | NO | — | — |
| sudo | **NO — do not attempt** | — | — |
| apt / apt-get | binary exists | **rootless: installs WILL fail with EACCES** | — |
| systemctl / service | binary exists | **dead — no systemd running** | — |
| tmux / screen | NO | use foreground flows or `nohup` (knowing #3 kills them on restart) | — |
| docker / podman | NO | — | — |
| jq / rsync / zsh | NO | — | — |
| tar / gzip / unzip / zip | YES | — | — |
| ssh / scp | YES (client only) | — | — |

### npm globals — EACCES fix

`node` lives in root-owned `/usr/local`, so `npm install -g X` fails. Do this once:

```sh
mkdir -p "$HOME/.local/bin" "$HOME/.local/lib" "$HOME/.npm"
npm config set prefix "$HOME/.local"
npm config set cache "$HOME/.npm"
export PATH="$HOME/.local/bin:$PATH"
export TMPDIR="$HOME/tmp"   # after mkdir -p "$HOME/tmp"
```

Persist by appending the two export lines to `$HOME/.profile`.

### node-pty / native addons

`node-pty`, `canvas`, `sqlite3`, etc. compile native code. The build toolchain (gcc/g++/make) **is** present, so `npm install` in this container works — but must be run **inside this container** (`$HOME/...`), with `arch64` binaries; do not copy `node_modules` folders built on x86 PCs.

## 5. Network

| Fact | Value |
|---|---|
| Outbound HTTP/HTTPS | works, all ports; ~100 ms latency to major sites |
| Egress public IP | 98.66.136.199 (Azure) — **can change** on restart, do not hardcode |
| DNS | Docker-embedded resolver `127.0.0.11` (search domain `reddog.microsoft.com`); do not edit resolv.conf |
| macOS / Windows tools | irrelevant — pure Linux shell |
| Inbound | exactly **one** port allocated by the panel: `PORT=24723` `SERVER_PORT=24723`. Bind `0.0.0.0` and use **that** port only. Do not open 80/443/3000/8080 — they are not routed. The public URL is `https://mohamedalsayed.ccwu.cc` (also `zara.hidencloud.com`), handled by panel HTTPS |

## 6. Services already running — do not kill

These run inside this container; they are the product and the user's tools:

| Process | Purpose | Disruption if killed |
|---|---|---|
| `/usr/bin/tini -g -- /entrypoint.sh` | container init, PID 1 | kills the whole container |
| `/bin/bash /entrypoint.sh` | startup script | kills the whole container |
| `node /home/container/server.js` | **ptygate** — the web terminal server on the public port | kills the terminal + `/ai/` proxy |
| `node …@deepseek-ai/dsh/lib/bin.js web --no-open --host 127.0.0.1 --port 36597 …` | **DeepSeek Harness (dsh)** — loopback web UI, served through ptygate at `/ai/` on the public port | kills the AI harness; ptygate restarts it on next boot |

Do not run port scanners, resource-hungry stress tests, or `kill` sweeps. If you need a daemon, bind it to `127.0.0.1` + a **free high port** and tell the user.

## 7. Quick re-verification probe (safe, read-only, ~2 s)

Run this whenever you need fresh numbers (e.g. after a container recreation):

```sh
echo "uid=$(id -u) arch=$(uname -m)"
echo "cpu.max $(cat /sys/fs/cgroup/cpu.max)  mem.max $(cat /sys/fs/cgroup/memory.max)  mem.used $(cat /sys/fs/cgroup/memory.current)"
echo "PORT=$PORT HOME=$HOME"
df -h "$HOME" /tmp 2>/dev/null | tail -2
ps aux | grep -E "server.js|dsh" | grep -v grep
```

## 8. Golden rules for agents on this box

1. You are **rootless** — never attempt `sudo`, `apt install`, or systemd units.
2. Target **aarch64** for any downloaded binary, Docker image, or prebuilt artifact.
3. Only `$HOME` is real storage; treat `/tmp` as ephemeral (512 MB cap).
4. Respect the 2-core / 3.4 GB budget; avoid parallel heavy builds (`npm install -j1`, `make -j2`).
5. Never leave detached services — they die with the container, and loose orphans waste the CPU/RAM budget.
6. `systemctl`, `swapon`, `service`, `supervisord` — available as binaries, **all useless** here.
7. Use the panel-provided `PORT` (currently 24723) with `HOST=0.0.0.0` if you ever start a public web service channel — otherwise keep listeners on `127.0.0.1`.
8. If a command needs root, tell the user instead of retrying.
