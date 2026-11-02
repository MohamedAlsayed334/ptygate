#!/bin/sh
# sync-contract.sh -- keep ./contract in sync with the contract release published
# by ptygate-node. No git submodules, no special tooling.
#
# Usage:
#   scripts/sync-contract.sh            replace ./contract with the published copy
#   scripts/sync-contract.sh --check    download and diff only; exit 1 on drift
#
# Version selector: contract/VERSION (created as 0.1.0 on first run).
# Source repo override: CONTRACT_REPO=owner/repo scripts/sync-contract.sh
#
# The script only modifies files inside ./contract. Downloads and extraction
# happen in a throwaway temp directory that is removed on exit.

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd) || {
    echo "sync-contract: cannot locate script directory" >&2
    exit 1
}
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." 2>/dev/null && pwd) || {
    echo "sync-contract: cannot locate project root" >&2
    exit 1
}
cd "$ROOT" || exit 1

CONTRACT_DIR="$ROOT/contract"
VERSION_FILE="$CONTRACT_DIR/VERSION"
REPO=${CONTRACT_REPO:-MohamedAlsayed334/ptygate-node}
CHECK=no

usage() {
    cat <<'EOF'
Usage: scripts/sync-contract.sh [--check]

  (no args)   Download the contract release named in contract/VERSION and
              replace ./contract with it. contract/VERSION is preserved.
  --check     Download the same release, diff it against ./contract, print the
              differing files and exit 1 if there is drift. Exits 0 when clean.

Environment:
  CONTRACT_REPO=owner/repo   Override the publishing repo
                             (default: MohamedAlsayed334/ptygate-node).
EOF
}

for arg in "$@"; do
    case "$arg" in
        --check) CHECK=yes ;;
        -h|--help) usage; exit 0 ;;
        *)
            echo "sync-contract: unknown argument: $arg" >&2
            usage >&2
            exit 2
            ;;
    esac
done

mkdir -p "$CONTRACT_DIR" || {
    echo "sync-contract: cannot create $CONTRACT_DIR" >&2
    exit 1
}
if [ ! -f "$VERSION_FILE" ]; then
    printf '0.1.0\n' > "$VERSION_FILE" || {
        echo "sync-contract: cannot write $VERSION_FILE" >&2
        exit 1
    }
fi

VERSION_RAW=$(cat "$VERSION_FILE" 2>/dev/null || true)
VERSION=""
# Accept a bare semver ("0.1.0") or a key/value file. The contract repo may
# publish a richer VERSION file with GATEWAY_VERSION=... alongside other keys.
for key in CONTRACT_VERSION VERSION GATEWAY_VERSION; do
    VERSION=$(printf '%s\n' "$VERSION_RAW" | sed -n "s/^[[:space:]]*$key[[:space:]]*=[[:space:]]*\([^[:space:]]*\).*/\1/p" | head -n 1)
    [ -n "$VERSION" ] && break
done
if [ -z "$VERSION" ]; then
    VERSION=$(printf '%s\n' "$VERSION_RAW" | sed -n 's/.*\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | head -n 1)
fi
if [ -z "$VERSION" ]; then
    echo "sync-contract: $VERSION_FILE does not contain a version like 0.1.0" >&2
    exit 1
fi

URL="https://github.com/$REPO/releases/download/contract-v$VERSION/contract-v$VERSION.tar.gz"

TMP=""
for base in "${TMPDIR:-}" /tmp "${HOME:-}"; do
    [ -n "$base" ] || continue
    [ -d "$base" ] || continue
    TMP=$(mktemp -d "$base/ptygate-contract.XXXXXX" 2>/dev/null) && break
    TMP=""
done
if [ -z "$TMP" ]; then
    echo "sync-contract: cannot create a temp directory (tried TMPDIR, /tmp, HOME)" >&2
    exit 1
fi
cleanup() {
    rm -rf "$TMP" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

ARCHIVE="$TMP/contract-v$VERSION.tar.gz"

download() {
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$URL" -o "$ARCHIVE"
    elif command -v wget >/dev/null 2>&1; then
        wget -q -O "$ARCHIVE" "$URL"
    else
        echo "sync-contract: neither curl nor wget is installed" >&2
        echo "sync-contract: install one, or copy contract/ in by hand" >&2
        return 127
    fi
}

if ! download; then
    echo "sync-contract: failed to download $URL" >&2
    echo "sync-contract: release contract-v$VERSION not published yet (or the box has no network)" >&2
    exit 1
fi

if [ ! -s "$ARCHIVE" ]; then
    echo "sync-contract: release contract-v$VERSION not published yet (downloaded an empty file)" >&2
    exit 1
fi

mkdir -p "$TMP/extract" || exit 1
if ! tar -xzf "$ARCHIVE" -C "$TMP/extract" 2>/dev/null; then
    echo "sync-contract: downloaded asset is not a valid .tar.gz" >&2
    exit 1
fi

# The release may keep files at the archive root or under a top-level
# directory. Find the real contract root by locating PROTOCOL.md.
PROTOCOL=$(find "$TMP/extract" -type f -name PROTOCOL.md 2>/dev/null | head -n 1 || true)
if [ -z "$PROTOCOL" ]; then
    echo "sync-contract: archive for contract-v$VERSION has no PROTOCOL.md" >&2
    exit 1
fi
SRC=$(dirname "$PROTOCOL")

# VERSION is the selector, not part of the synced payload; ignore it in diffs
# so an archive that omits VERSION does not look like drift.
filter_version() {
    grep -v -e '/VERSION' -e ': VERSION' || true
}

if [ "$CHECK" = yes ]; then
    DIFF_OUT="$TMP/diff.txt"
    : > "$DIFF_OUT"
    diff -rq "$CONTRACT_DIR" "$SRC" >> "$DIFF_OUT" 2>&1 || true
    filter_version < "$DIFF_OUT" > "$TMP/diff.filtered"

    if [ -s "$TMP/diff.filtered" ]; then
        echo "contract drift: local ./contract differs from contract-v$VERSION" >&2
        cat "$TMP/diff.filtered" >&2
        exit 1
    fi

    echo "contract clean: ./contract matches contract-v$VERSION"
    exit 0
fi

# Default mode: replace ./contract with the published copy. Preserve the local
# VERSION file, which is what selected this release in the first place.
LOCAL_VERSION=$(cat "$VERSION_FILE" 2>/dev/null || printf '%s' "$VERSION")

rm -rf "$CONTRACT_DIR" || {
    echo "sync-contract: cannot replace $CONTRACT_DIR" >&2
    exit 1
}
mkdir -p "$CONTRACT_DIR" || {
    echo "sync-contract: cannot recreate $CONTRACT_DIR" >&2
    exit 1
}
if ! cp -a "$SRC/." "$CONTRACT_DIR/" 2>/dev/null; then
    printf '%s\n' "$LOCAL_VERSION" > "$VERSION_FILE" 2>/dev/null || true
    echo "sync-contract: failed to copy the downloaded contract into $CONTRACT_DIR" >&2
    exit 1
fi

printf '%s\n' "$LOCAL_VERSION" > "$CONTRACT_DIR/VERSION" || {
    echo "sync-contract: warning: synced files but could not restore $CONTRACT_DIR/VERSION" >&2
    exit 1
}

echo "contract synced: contract-v$VERSION -> ./contract (from $REPO)"
