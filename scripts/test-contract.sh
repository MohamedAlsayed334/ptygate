#!/bin/sh
# test-contract.sh -- boot the gateway on a free port, run the v1 conformance
# suite against it, then clean up. No manual port/token juggling.
#
# Usage:
#   npm test                          full suite
#   npm test -- --module test_ws      single module
#   npm test -- --list                list tests (no server needed)
#   npm test -- --slow --grace-ms 5000
#
# Everything after `npm test --` is passed straight through to
# contract/tests/run_all.py, which owns the rules: PASS/FAIL/SKIP per test,
# exit code 1 when any test FAILs (SKIP is not a failure).
#
# Env overrides:
#   TEST_PORT     port to use (default: random free-ish port)
#   TEST_TOKEN    token to use (default: random, lives only for this run)

set -u

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd) || exit 1
cd "$ROOT" || exit 1

for tool in python3 node curl; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "test-contract: required tool '$tool' not on PATH" >&2
        exit 1
    fi
done

# --list needs no live server
for arg in "$@"; do
    if [ "$arg" = "--list" ]; then
        exec python3 contract/tests/run_all.py --list
    fi
done

for mod in test_http test_auth test_ws test_resume test_regression test_ip_policy test_ssh; do
    if [ ! -f "contract/tests/$mod.py" ]; then
        echo "test-contract: contract/tests/$mod.py missing -- run 'npm run contract:sync'" >&2
        exit 1
    fi
done

PORT=${TEST_PORT:-$(node -pe '1024 + Math.floor(Math.random() * 60000)')}
TOKEN=${TEST_TOKEN:-$(node -pe "require('crypto').randomBytes(24).toString('base64url')" 2>/dev/null)}

SERVER_LOG=$(mktemp /tmp/ptygate-suite-XXXXXX.log)
SERVER_PID=""

cleanup() {
    if [ -n "$SERVER_PID" ]; then
        kill "$SERVER_PID" 2>/dev/null
        wait "$SERVER_PID" 2>/dev/null
    fi
    rm -f "$SERVER_LOG"
}
trap cleanup EXIT INT TERM

PORT="$PORT" HOST=127.0.0.1 TERMINAL_TOKEN="$TOKEN" \
node server.js >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

echo "== starting the gateway on 127.0.0.1:$PORT (pid $SERVER_PID) =="
i=0
while [ "$i" -lt 40 ]; do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        echo "test-contract: server exited early; log follows:" >&2
        cat "$SERVER_LOG" >&2
        exit 1
    fi
    if curl -fs "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
        break
    fi
    i=$((i + 1))
    sleep 0.3
done

if [ "$i" -eq 40 ]; then
    echo "test-contract: /healthz never answered on port $PORT; log follows:" >&2
    cat "$SERVER_LOG" >&2
    exit 1
fi

echo "== running the conformance suite =="
python3 contract/tests/run_all.py \
    --base "http://127.0.0.1:$PORT" \
    --token "$TOKEN" \
    "$@"
