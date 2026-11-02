#!/bin/sh
# env-report.sh -- read-only-ish survey of the container an agent just landed in.
#
# Usage:  sh scripts/env-report.sh
#
# Prints labelled sections of KEY=value lines so an agent can grep them.
# It never installs anything and never edits the system. The only side effect
# is a short-lived probe file created and deleted inside each candidate
# writable directory.
#
# This script is intentionally dependency-free: POSIX sh + coreutils/awk.
# It always exits 0, even when probes fail, so it is safe as the first command
# on an unknown box.

# Never let an unexpected failure produce a non-zero exit.
trap 'exit 0' EXIT

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

section() {
    printf '\n== %s ==\n' "$1"
}

kv() {
    # kv KEY VALUE -- one greppable line, value may contain spaces.
    printf '%s=%s\n' "$1" "$2"
}

to_mb() {
    # Blocks (1024-byte units from df -Pk) -> whole MB.
    case "${1:-}" in
        ''|*[!0-9]*) printf 'unknown' ;;
        *) printf '%s' "$(( $1 / 1024 ))" ;;
    esac
}

df_field() {
    # df_field PATH FIELD -- FIELD is the awk column number.
    df -Pk "$1" 2>/dev/null | awk -v n="$2" 'NR == 2 { print $n }'
}

probe_write() {
    # probe_write DIR -- prints yes/no. Creates a temp file, then removes it.
    d=${1:-}
    if [ -z "$d" ] || [ ! -d "$d" ] || [ ! -w "$d" ]; then
        printf 'no'
        return 0
    fi
    f=$(mktemp "$d/.env-report.XXXXXX" 2>/dev/null) || {
        printf 'no'
        return 0
    }
    if printf 'probe\n' >"$f" 2>/dev/null; then
        rm -f "$f" 2>/dev/null
        printf 'yes'
    else
        rm -f "$f" 2>/dev/null
        printf 'no'
    fi
}

report_tool() {
    name=$1
    p=$(command -v "$name" 2>/dev/null || true)
    if [ -n "$p" ]; then
        case "$name" in
            go)  v=$("$name" version 2>&1 | head -n 1 | tr -d '\r') ;;
            ssh) v=$("$name" -V 2>&1 | head -n 1 | tr -d '\r') ;;
            *)   v=$("$name" --version 2>&1 | head -n 1 | tr -d '\r') ;;
        esac
        [ -n "$v" ] || v=unknown
        printf 'TOOL_%s=present PATH=%s VERSION=%s\n' "$name" "$p" "$v"
    else
        printf 'TOOL_%s=absent\n' "$name"
    fi
}

# ---------------------------------------------------------------------------
# where are we
# ---------------------------------------------------------------------------

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd) || SCRIPT_DIR=.
PROJECT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." 2>/dev/null && pwd) || PROJECT_ROOT=$PWD

section "report"
kv REPORT_TIME "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date 2>/dev/null || printf unknown)"
kv PROJECT_ROOT "$PROJECT_ROOT"
kv PWD "$(pwd 2>/dev/null || printf unknown)"
kv SCRIPT_DIR "$SCRIPT_DIR"

# ---------------------------------------------------------------------------
# identity
# ---------------------------------------------------------------------------

section "identity"
UID_NUM=$(id -u 2>/dev/null || printf unknown)
GID_NUM=$(id -g 2>/dev/null || printf unknown)
ID_NAME=$(id -un 2>/dev/null || true)
ID_GROUPS=$(id -Gn 2>/dev/null || true)
[ -n "$ID_GROUPS" ] || ID_GROUPS=unknown

kv ID_RAW "$(id 2>/dev/null | tr '\n' ' ' || printf unknown)"
kv UID "$UID_NUM"
kv GID "$GID_NUM"
kv ID_NAME "${ID_NAME:-<unresolved>}"
# A prompt that reads "I have no name!" means exactly this: no passwd entry.
kv PROMPT_NAME "${ID_NAME:-I have no name!}"
kv GROUPS "$ID_GROUPS"

PASSWD_ENTRY=no
if [ -r /etc/passwd ] && [ "$UID_NUM" != unknown ]; then
    if awk -F: -v u="$UID_NUM" '$3 == u { found = 1 } END { exit(found ? 0 : 1) }' /etc/passwd 2>/dev/null; then
        PASSWD_ENTRY=yes
    fi
fi
kv PASSWD_ENTRY "$PASSWD_ENTRY"

PASSWD_HOME=$(awk -F: -v u="$UID_NUM" '$3 == u { print $6; exit }' /etc/passwd 2>/dev/null || true)
PASSWD_SHELL=$(awk -F: -v u="$UID_NUM" '$3 == u { print $7; exit }' /etc/passwd 2>/dev/null || true)

WHOAMI_OUT=$(whoami 2>&1 || true)
if [ -z "$WHOAMI_OUT" ]; then
    WHOAMI_STATUS=unavailable
elif printf '%s' "$WHOAMI_OUT" | grep -qi 'cannot find name'; then
    WHOAMI_STATUS=unavailable
else
    WHOAMI_STATUS=ok
fi
kv WHOAMI_STATUS "$WHOAMI_STATUS"
kv WHOAMI_OUTPUT "${WHOAMI_OUT:-<empty>}"

kv HOME "${HOME-}"
HOME_SET=no
[ -n "${HOME:-}" ] && HOME_SET=yes
kv HOME_SET "$HOME_SET"
kv HOME_FROM_PASSWD "${PASSWD_HOME:-<none>}"
kv HOME_EXISTS "$([ -n "${HOME:-}" ] && [ -d "${HOME:-}" ] && printf yes || printf no)"
HOME_OWNER_UID=$(stat -c '%u' "${HOME:-/nonexistent}" 2>/dev/null || printf unknown)
HOME_OWNER_GID=$(stat -c '%g' "${HOME:-/nonexistent}" 2>/dev/null || printf unknown)
kv HOME_OWNER_UID "$HOME_OWNER_UID"
kv HOME_OWNER_GID "$HOME_OWNER_GID"
if [ "$HOME_OWNER_UID" = "$UID_NUM" ]; then
    kv HOME_OWNED_BY_ME yes
else
    kv HOME_OWNED_BY_ME no
fi
kv USER "${USER-}"
kv LOGNAME "${LOGNAME-}"
kv SHELL_ENV "${SHELL-}"
kv SHELL_FROM_PASSWD "${PASSWD_SHELL:-<none>}"
kv SHELL_FALLBACK "$([ -x /bin/sh ] && printf /bin/sh || printf unknown)"
# If HOME is unset or "/", tools silently write to root-owned / and fail.
if [ -z "${HOME:-}" ] || [ "${HOME:-}" = "/" ]; then
    kv HOME_RISK high
else
    kv HOME_RISK low
fi

# ---------------------------------------------------------------------------
# writability
# ---------------------------------------------------------------------------

section "writability"
HOME_WRITABLE=$(probe_write "${HOME:-}")
TMP_WRITABLE=$(probe_write /tmp)
USR_LOCAL_BIN_WRITABLE=$(probe_write /usr/local/bin)
OPT_WRITABLE=$(probe_write /opt)
PROJECT_WRITABLE=$(probe_write "$PROJECT_ROOT")

kv HOME_WRITABLE "$HOME_WRITABLE"
kv TMP_WRITABLE "$TMP_WRITABLE"
kv USR_LOCAL_BIN_WRITABLE "$USR_LOCAL_BIN_WRITABLE"
kv OPT_WRITABLE "$OPT_WRITABLE"
kv PROJECT_WRITABLE "$PROJECT_WRITABLE"

# ---------------------------------------------------------------------------
# container / init detection
# ---------------------------------------------------------------------------

section "container"
DOCKERENV=no
[ -f /.dockerenv ] && DOCKERENV=yes
kv DOCKERENV "$DOCKERENV"

CGROUP_SAMPLE=$(head -c 400 /proc/1/cgroup 2>/dev/null | tr '\n' ' ' || true)
kv PROC1_CGROUP "${CGROUP_SAMPLE:-<unreadable>}"
kv PROC1_COMM "$(cat /proc/1/comm 2>/dev/null || printf unknown)"

CONTAINER=no
case "$CGROUP_SAMPLE" in
    *docker*|*containerd*|*kubepods*|*lxc*|*podman*) CONTAINER=yes ;;
esac
[ "$DOCKERENV" = yes ] && CONTAINER=yes
kv CONTAINER "$CONTAINER"

# Pterodactyl wings sets a few of these inside the server container.
PANEL_HINTS=""
for v in P_SERVER_UUID SERVER_MEMORY SERVER_PORT STARTUP; do
    eval "val=\${$v-}"
    [ -n "$val" ] && PANEL_HINTS="$PANEL_HINTS $v"
done
kv PANEL_HINTS "${PANEL_HINTS:-none}"

# ---------------------------------------------------------------------------
# cgroup limits (v2 first, then v1)
# ---------------------------------------------------------------------------

section "limits"
CGROUP_VERSION=unknown
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
    CGROUP_VERSION=2
elif [ -r /sys/fs/cgroup/cpu/cpu.cfs_quota_us ]; then
    CGROUP_VERSION=1
fi
kv CGROUP_VERSION "$CGROUP_VERSION"
kv NPROC "$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || printf unknown)"

# In cgroup v2 the files for the current process may live in a subdirectory,
# not at the mount root. Prefer this process's own cgroup path.
CG_DIR=/sys/fs/cgroup
if [ "$CGROUP_VERSION" = 2 ]; then
    CG_REL=$(awk -F: '$1 == "0" { print $3; exit }' /proc/self/cgroup 2>/dev/null || true)
    if [ -n "$CG_REL" ] && [ -d "/sys/fs/cgroup$CG_REL" ]; then
        CG_DIR="/sys/fs/cgroup$CG_REL"
    fi
fi
kv CGROUP_DIR "$CG_DIR"

CPU_CORES=unknown
CPU_RAW=unknown
MEMORY_MB=unknown
MEMORY_RAW=unknown
SWAP_MB=unknown

if [ "$CGROUP_VERSION" = 2 ]; then
    if [ -r "$CG_DIR/cpu.max" ]; then
        CPU_RAW=$(tr '\n' ' ' < "$CG_DIR/cpu.max" 2>/dev/null | sed 's/[[:space:]]*$//')
        CPU_CORES=$(awk '{ if ($1 == "max") print "unlimited"; else if ($2 + 0 > 0) printf "%.2f", $1 / $2; else print "unknown" }' "$CG_DIR/cpu.max" 2>/dev/null || printf unknown)
    fi
    if [ -r "$CG_DIR/memory.max" ]; then
        MEMORY_RAW=$(tr -d '\n' < "$CG_DIR/memory.max" 2>/dev/null)
        MEMORY_MB=$(awk -v b="$MEMORY_RAW" 'BEGIN { if (b == "max") print "unlimited"; else if (b + 0 > 0) printf "%.0f", b / 1048576; else print "unknown" }' 2>/dev/null || printf unknown)
    fi
    if [ -r "$CG_DIR/memory.swap.max" ]; then
        SWAP_RAW=$(tr -d '\n' < "$CG_DIR/memory.swap.max" 2>/dev/null)
        SWAP_MB=$(awk -v b="$SWAP_RAW" 'BEGIN { if (b == "max") print "unlimited"; else if (b + 0 > 0) printf "%.0f", b / 1048576; else print "unknown" }' 2>/dev/null || printf unknown)
    else
        SWAP_MB=none
    fi
elif [ "$CGROUP_VERSION" = 1 ]; then
    if [ -r /sys/fs/cgroup/cpu/cpu.cfs_quota_us ] && [ -r /sys/fs/cgroup/cpu/cpu.cfs_period_us ]; then
        Q=$(cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us 2>/dev/null || printf -1)
        P=$(cat /sys/fs/cgroup/cpu/cpu.cfs_period_us 2>/dev/null || printf 0)
        CPU_RAW="quota=$Q period=$P"
        CPU_CORES=$(awk -v q="$Q" -v p="$P" 'BEGIN { if (q < 0) print "unlimited"; else if (p + 0 > 0) printf "%.2f", q / p; else print "unknown" }' 2>/dev/null || printf unknown)
    fi
    if [ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
        MEMORY_RAW=$(tr -d '\n' < /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null)
        MEMORY_MB=$(awk -v b="$MEMORY_RAW" 'BEGIN { if (b + 0 >= 9223372036854771712) print "unlimited"; else if (b + 0 > 0) printf "%.0f", b / 1048576; else print "unknown" }' 2>/dev/null || printf unknown)
    fi
fi

kv CPU_MAX_RAW "$CPU_RAW"
kv CPU_CORES "$CPU_CORES"
kv MEMORY_MAX_RAW "$MEMORY_RAW"
kv MEMORY_LIMIT_MB "$MEMORY_MB"
kv SWAP_MB "$SWAP_MB"

# ---------------------------------------------------------------------------
# toolchains
# ---------------------------------------------------------------------------

section "toolchains"
for t in node npm go rustc cargo gcc g++ python3 pip3 git tmux ssh sshd make curl wget tar; do
    report_tool "$t"
done

section "npm"
NPM_PREFIX=unknown
if command -v npm >/dev/null 2>&1; then
    NPM_PREFIX=$(npm config get prefix 2>/dev/null | head -n 1)
    [ -n "$NPM_PREFIX" ] || NPM_PREFIX=unknown
fi
kv NPM_PREFIX "$NPM_PREFIX"
kv NPM_GLOBAL_DIR "$([ "$NPM_PREFIX" = unknown ] && printf unknown || printf '%s/lib/node_modules' "$NPM_PREFIX")"

if [ "$NPM_PREFIX" != unknown ] && [ -d "$NPM_PREFIX" ]; then
    NPM_PREFIX_WRITABLE=$(probe_write "$NPM_PREFIX")
else
    NPM_PREFIX_WRITABLE=no
fi
kv NPM_PREFIX_WRITABLE "$NPM_PREFIX_WRITABLE"

if command -v npm >/dev/null 2>&1 && [ "$NPM_PREFIX_WRITABLE" = yes ]; then
    NPM_GLOBAL_SAFE=yes
    NPM_GLOBAL_REASON="prefix is writable by this uid"
else
    NPM_GLOBAL_SAFE=no
    if ! command -v npm >/dev/null 2>&1; then
        NPM_GLOBAL_REASON="npm is not installed"
    else
        NPM_GLOBAL_REASON="prefix $NPM_PREFIX is root-owned; npm i -g will fail with EACCES"
    fi
fi
kv NPM_GLOBAL_SAFE "$NPM_GLOBAL_SAFE"
kv NPM_GLOBAL_REASON "$NPM_GLOBAL_REASON"
kv NPM_CONFIG_PREFIX "${NPM_CONFIG_PREFIX-<unset>}"
NPM_CACHE=$(npm config get cache 2>/dev/null | head -n 1)
kv NPM_CACHE "${NPM_CACHE:-unknown}"

# ---------------------------------------------------------------------------
# network
# ---------------------------------------------------------------------------

section "network"
SERVER_PORT_VALUE=${SERVER_PORT-}
PTYGATE_PORT_VALUE=${PTYGATE_PORT-}
PORT_VALUE=${PORT-}

kv SERVER_PORT "$SERVER_PORT_VALUE"
kv SERVER_PORT_SET "$([ -n "$SERVER_PORT_VALUE" ] && printf yes || printf no)"
kv PTYGATE_PORT "$PTYGATE_PORT_VALUE"
kv PTYGATE_PORT_SET "$([ -n "$PTYGATE_PORT_VALUE" ] && printf yes || printf no)"
kv PORT "$PORT_VALUE"
kv PORT_SET "$([ -n "$PORT_VALUE" ] && printf yes || printf no)"

if [ -n "$SERVER_PORT_VALUE" ]; then
    RECOMMENDED_PORT=$SERVER_PORT_VALUE
elif [ -n "$PTYGATE_PORT_VALUE" ]; then
    RECOMMENDED_PORT=$PTYGATE_PORT_VALUE
elif [ -n "$PORT_VALUE" ]; then
    RECOMMENDED_PORT=$PORT_VALUE
else
    RECOMMENDED_PORT=8080
fi
kv RECOMMENDED_PORT "$RECOMMENDED_PORT"
# The panel forwards exactly one allocation. There is no 22, 80 or 443.
kv EXTERNAL_PORT_NOTE "only the panel allocation is reachable from outside"

kv HOSTNAME "$(hostname 2>/dev/null || printf unknown)"
kv HOSTNAME_I "$(hostname -I 2>/dev/null | tr -s ' ' | sed 's/^ *//; s/ *$//' || printf unknown)"

IPV4=""
if command -v ip >/dev/null 2>&1; then
    IPV4=$(ip -4 -o addr show 2>/dev/null | awk '{ print $2 "=" $4 }' | tr '\n' ' ' | sed 's/ *$//')
fi
if [ -z "$IPV4" ] && command -v ifconfig >/dev/null 2>&1; then
    IPV4=$(ifconfig 2>/dev/null | awk '/inet / && $2 != "127.0.0.1" { print $2 }' | tr '\n' ' ' | sed 's/ *$//')
fi
kv IPV4_ADDRESSES "${IPV4:-unknown}"

if command -v ss >/dev/null 2>&1; then
    kv LISTEN_TCP "$(ss -ltn 2>/dev/null | awk 'NR > 1 { print $4 }' | tr '\n' ' ' | sed 's/ *$//')"
else
    kv LISTEN_TCP "ss-not-installed"
fi

# ---------------------------------------------------------------------------
# disk
# ---------------------------------------------------------------------------

section "disk"
ROOT_TOTAL=$(df_field / 2)
ROOT_USED=$(df_field / 3)
ROOT_FREE=$(df_field / 4)
kv DISK_ROOT_TOTAL_MB "$(to_mb "$ROOT_TOTAL")"
kv DISK_ROOT_USED_MB "$(to_mb "$ROOT_USED")"
kv DISK_ROOT_FREE_MB "$(to_mb "$ROOT_FREE")"

if [ -n "${HOME:-}" ] && [ -d "${HOME:-}" ]; then
    HOME_TOTAL=$(df_field "${HOME:-}" 2)
    HOME_FREE=$(df_field "${HOME:-}" 4)
    kv DISK_HOME_TOTAL_MB "$(to_mb "$HOME_TOTAL")"
    kv DISK_HOME_FREE_MB "$(to_mb "$HOME_FREE")"
else
    kv DISK_HOME_TOTAL_MB unknown
    kv DISK_HOME_FREE_MB unknown
fi

TMP_TOTAL=$(df_field /tmp 2)
TMP_FREE=$(df_field /tmp 4)
kv DISK_TMP_TOTAL_MB "$(to_mb "$TMP_TOTAL")"
kv DISK_TMP_FREE_MB "$(to_mb "$TMP_FREE")"
kv TMP_IS_TMPFS "$(grep -q ' /tmp tmpfs ' /proc/mounts 2>/dev/null && printf yes || printf no)"

PROJECT_DU_KB=$(du -sk "$PROJECT_ROOT" 2>/dev/null | awk '{ print $1 }')
kv PROJECT_DU_KB "${PROJECT_DU_KB:-unknown}"
kv PROJECT_DU_HUMAN "$(du -sh "$PROJECT_ROOT" 2>/dev/null | awk '{ print $1 }' || printf unknown)"

# ---------------------------------------------------------------------------
# verdict
# ---------------------------------------------------------------------------

section "verdict"
WRITABLE_LIST=""
[ "$HOME_WRITABLE" = yes ] && WRITABLE_LIST="$WRITABLE_LIST $HOME"
[ "$TMP_WRITABLE" = yes ] && WRITABLE_LIST="$WRITABLE_LIST /tmp"
[ "$PROJECT_WRITABLE" = yes ] && WRITABLE_LIST="$WRITABLE_LIST $PROJECT_ROOT"
[ "$USR_LOCAL_BIN_WRITABLE" = yes ] && WRITABLE_LIST="$WRITABLE_LIST /usr/local/bin"
[ "$OPT_WRITABLE" = yes ] && WRITABLE_LIST="$WRITABLE_LIST /opt"
WRITABLE_LIST=$(printf '%s' "$WRITABLE_LIST" | sed 's/^ *//')
[ -n "$WRITABLE_LIST" ] || WRITABLE_LIST=none

kv VERDICT_WRITABLE_DIRS "$WRITABLE_LIST"
kv VERDICT_NPM_GLOBAL_SAFE "$NPM_GLOBAL_SAFE"
kv VERDICT_NPM_GLOBAL_REASON "$NPM_GLOBAL_REASON"

if [ "$HOME_SET" = no ] || [ "$HOME_RISK" = high ]; then
    kv VERDICT_HOME_WARNING "HOME is unset or /; export HOME to a writable dir before installing"
else
    kv VERDICT_HOME_WARNING none
fi

if [ -n "$(command -v go 2>/dev/null || true)" ]; then
    kv VERDICT_GO_TOOLCHAIN present
else
    kv VERDICT_GO_TOOLCHAIN absent
fi
if [ -n "$(command -v rustc 2>/dev/null || true)" ]; then
    kv VERDICT_RUST_TOOLCHAIN present
else
    kv VERDICT_RUST_TOOLCHAIN absent
fi

kv VERDICT_USE_PORT "$RECOMMENDED_PORT"
kv VERDICT_USE_HOST "0.0.0.0 (bind all interfaces; 127.0.0.1 is not reachable through the panel)"

if [ "$NPM_GLOBAL_SAFE" = no ]; then
    NPM_HINT='do not npm i -g; use NPM_CONFIG_PREFIX=$HOME/.local'
else
    NPM_HINT='npm i -g is writable, but a userland prefix is still safer'
fi

if [ -n "$(command -v go 2>/dev/null || true)" ]; then
    kv VERDICT_HOW_TO_INSTALL "go build with CGO_ENABLED=0 GOCACHE=\$HOME/.cache/go-build TMPDIR=\$HOME/tmp, output to \$HOME/.local/bin; $NPM_HINT"
elif [ -n "$(command -v node 2>/dev/null || true)" ]; then
    kv VERDICT_HOW_TO_INSTALL "node present: npm ci in the project, run node server.js --console on port $RECOMMENDED_PORT; $NPM_HINT"
else
    kv VERDICT_HOW_TO_INSTALL "no go/node: install a static binary into \$HOME/.local/bin with curl/wget; $NPM_HINT"
fi

kv VERDICT_HOME "${HOME:-<unset>}"
kv VERDICT_PROJECT_ROOT "$PROJECT_ROOT"

# Always succeed.
exit 0
