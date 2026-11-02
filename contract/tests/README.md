# ptygate v1 conformance suite

Language-agnostic tests for [`../PROTOCOL.md`](../PROTOCOL.md). They are the
target contract, not a snapshot of any one implementation: a test is allowed to
fail against today's server and must **not** be weakened to make it pass.

Pure Python 3 standard library. No `pip install`, no root, no third-party
packages. The suite talks raw TCP/HTTP/WebSocket and shells out to the system
`ssh` client only for the SSH module.

---

## Run it

```sh
python3 contract/tests/run_all.py \
  --base http://127.0.0.1:8080 \
  --token "$TERMINAL_TOKEN"
```

Optional:

```sh
# explicit SSH port (defaults to the --base port, because one port serves all)
--ssh-port 8080

# assert the implementation identity reported by /version and hello.impl
--expect-impl node        # or: go

# assert the effective IP mode reported by /version
--expect-ip-mode allowlist   # or: any

# TLS door (self-signed certs are accepted automatically)
--base https://127.0.0.1:8443

# only some modules
--module test_ws --module test_resume

# list tests without touching the network
--list

# enable timing-dependent tests (grace expiry)
--slow --grace-ms 5000

# assert that this source IP is denied (see "IP policy" below)
--assert-denied
```

Exit status is `1` if any test **FAIL**s. `SKIP` is not a failure and prints a
reason. Every line is one of:

```
PASS  http::healthz_ok
FAIL  ws::subprotocol_is_required  (handshake with ... must be 426, got 101)
SKIP  ip_policy::deny_all_http_paths  (set --assert-denied ...)
```

The suite prints a preflight line with the target's `impl`, `protocol`,
`ip_mode` and transport booleans, then a summary.

### Environment

* Python **3.8+**. `signal.setitimer` is used for a per-test wall-clock guard
  on POSIX. There is no Windows support.
* No root, no listening sockets opened by the tests, no writes outside the
  process temp dir (SSH askpass script only).
* The server must be running and reachable from the machine running the suite.
  Loopback is the expected setup.
* The token passed on the command line must be the real gateway token and must
  be at least 16 characters (the protocol minimum).
* Tests clean up after themselves: every PTY they create is exited before the
  test returns, so the 4-PTY cap does not leak between tests. If a test crashes
  mid-way, restart the server before re-running.

### IP policy (`test_ip_policy.py`, SSH denial)

The useful denial cases need a source IP that the server denies. From a normal
localhost setup the suite's own IP is `127.0.0.1`, which the default allowlist
permits, so those tests **SKIP** with a message rather than pretend to pass.

To actually exercise denial, start a second instance restricted to a range that
does not include the test host, then point the suite at it:

```sh
ALLOWED_IPS=10.0.0.0/8 ./ptygate --port 8090 --token "$TOKEN"
python3 contract/tests/run_all.py --base http://127.0.0.1:8090 \
  --token "$TOKEN" --assert-denied --module test_ip_policy --module test_ssh
```

With `--assert-denied`:

* every HTTP path, including `/healthz`, must be `403`;
* `/ws` must be `403` pre-upgrade;
* SSH must close before the banner.

### Lockout test

`test_auth.py::lockout_after_ten_failures` needs a second source IP so it does
not lock out the IP used by the rest of the suite. It binds a random
`127.0.0.100`–`127.0.0.250` loopback address (`--source-ip` overrides). On
systems where that bind fails (some macOS/container setups), the test **SKIPs**
with the OS error.

After the test, the server holds a 15-minute lockout for that throwaway
address only. Loopback `127.0.0.1` is unaffected and remains usable.

### SSH module

`test_ssh.py` needs an OpenSSH client (`ssh`). If it is absent, every SSH test
SKIPs. Password authentication is fed non-interactively through
`SSH_ASKPASS` + `SSH_ASKPASS_REQUIRE=force` (OpenSSH 8.4+). Before asserting
anything, the module proves the mechanism works by checking that a **wrong**
password is rejected; if it cannot drive password auth at all, it SKIPs with
the ssh output instead of producing a false failure.

Public-key authentication is not exercised end-to-end: that would require
writing to the server's `authorized_keys` in its data dir, which a black-box
suite does not have. The contract requirement is documented in `PROTOCOL.md`
§8.2.

---

## What each module proves

### `test_http.py`

* `/healthz` is `200 text/plain` exactly `ok`, unauthenticated.
* `/version` has the exact name/impl/version/protocol/transports/ip_mode shape,
  does not leak secrets, and reports TLS truthfully.
* `GET /` without a session is `302 /login`; with a session it is `200` HTML
  with `Cache-Control: no-store`.
* `/login` is public HTML, not cached.
* `POST /login` with the right token is `303 /` and sets the full cookie
  contract (`wt_session`, ≥32-byte id, `HttpOnly`, `SameSite=Strict`,
  `Path=/`, `Max-Age=43200`, `Secure` iff the request was TLS).
* Cookie reuse, unique session ids, `/assets/*` not auth-gated, unknown paths
  `404`, raw plain-HTTP routing on the multiplexed port.
* With `--base https://...`: the peer certificate is self-signed, not expired,
  and its SANs include `localhost`, `127.0.0.1` and `::1`.

### `test_auth.py`

* Correct token → `303` + cookie; wrong/short/missing token → `401`; no token
  echo; failed logins never set a live cookie.
* No trimming/case folding of the token.
* Cookie reuse, `GET /logout` → `303 /login` + `Max-Age=0`, old cookie is dead
  afterwards, logout is idempotent.
* Logout kills a detached PTY's grace.
* 10 failures from one IP → `429` for that IP (even with the right token), while
  another IP is unaffected.

### `test_ws.py`

* `101` with a valid `Sec-WebSocket-Accept`, exact `ptygate.v1` echo, and a
  contract-shaped `hello` whose `session` equals the cookie and `resumed` is
  `false` on first attach.
* Missing/wrong subprotocol → `426` (never `101`).
* Origin ≠ Host → `403`; missing/invalid cookie → `401`; wrong path → `404`.
* `input` reaches the PTY and comes back as `output`; `resize` changes
  `stty size`; `exit 0` sends `exit` with code 0 then close `1000`; `exit 7`
  carries 7.
* Client ping gets a pong.
* A client frame > 65536 bytes closes with `1009`.
* Exactly 4 concurrent PTYs; the 5th is `429`.

### `test_resume.py`

* Client `detach` closes `1000` / `"detached"` and the PTY survives.
* Reattach with the same cookie: `hello.resumed=true` and the previous output
  is replayed **before** any input is sent; live I/O still works.
* Output produced while detached is buffered and appears in the replay.
* A second socket for the same cookie replaces the first: old socket gets
  `4000` / `"detached"`, new socket has `resumed=true`, PTY keeps working.
* Replay is bounded: 300 KB of scrollback is truncated so the recent tail is
  present and the oldest marker is absent, ≤262144 bytes (+4 KiB slack for a
  prompt).
* After shell exit, the PTY is gone; the cookie still spawns a fresh PTY with
  `resumed=false`.
* Optional (`--slow --grace-ms`): after grace expiry, reattach is a fresh PTY.

### `test_regression.py`

Hostile-input and "never a hang" guarantees:

* `Cookie: wt_session=` values `%E0%A4%A`, `%E0%A4`, `%`, `%zz`, `%00`,
  `%0d%0a`, a 4000-char value, and more → `401`, bounded time, then
  `GET /healthz` still `200 ok`.
* A hostile cookie without a subprotocol is still `401` (auth is checked before
  `426`).
* A WS handshake without `Sec-WebSocket-Key` → `400`, no upgrade.
* HTTP/1.1 without `Host` → `400`.
* Binary garbage → error/close, server keeps serving.
* A client that disconnects mid-request is harmless.
* Hostile traffic does not consume PTY slots: four normal sessions still fit
  afterwards (and the 5th is `429`).

### `test_ip_policy.py`

* `/version.ip_mode` is well formed and matches `--expect-ip-mode`.
* With `--assert-denied`: `403` on every HTTP path (including `/healthz` and
  `POST /login`) and on `/ws` pre-upgrade.
* Loopback works in allowlist mode; any mode does not break local access.

### `test_ssh.py`

* Banner is exactly `SSH-2.0-ptygate_0.1.0` (on the shared port, proving the
  multiplexer routes `SSH-`).
* Password = token, any username; wrong password is rejected (the test proves
  the askpass mechanism works before asserting it).
* `exec` runs a command, returns its stdout and its exit status (`exit 7` → 7).
* `ssh -tt` allocates a real PTY (`stty size` within the clamp ranges).
* With `--assert-denied`: TCP close before the banner.

---

## Expected RED (current state of the build)

The current `server.js` predates this contract. The suite is expected to be
**RED** until the build order below is complete. Nothing in the tests is
weakened to accommodate that.

**Step 2 — Node gateway catches up.** These families are RED today and should
go green with a Node implementation of `PROTOCOL.md`:

* `test_http`: `/version` (`404` today), `Cache-Control: no-store` on HTML,
  `Secure`-iff-TLS cookie rule, exact `/healthz` content type (mostly fine).
* `test_auth`: wrong token must be `401` (today: `302 /login?error=1`),
  `GET /logout` (today: `POST /logout`), logout-kills-detached-PTY, per-IP
  lockout semantics.
* `test_ws`: subprotocol negotiation and `426` (today: no subprotocol at all),
  check ordering, `1009` on oversized frames, 4-PTY cap (today 8), `exit.code`
  field (today `exitCode`; the browser client in `public/` still reads the old
  field — that is step 2 work outside `contract/`).
* `test_resume`: **all** of it. Today there is no detach frame, no grace, no
  replay, no resume, and no `4000` replace semantics; closing a socket kills
  the PTY.
* `test_regression`: largely green today (the hostile-cookie fix exists), but
  the subprotocol-order case and the 4-PTY cleanup case may be RED until step 2.
* `test_ip_policy`: mostly SKIPs on localhost; denial cases RED only once
  `--assert-denied` is used (today the IP guard exists and returns `403`).
* `test_ssh`: **all RED/SKIP** — there is no SSH door today, so `/version`
  does not report it and the module SKIPs.
* TLS: all TLS-specific assertions are RED/SKIP until a TLS listener exists.

**Step 3 — Go implementation.** The same suite must pass against the Go
gateway. Any test that passes on Node and fails on Go (or vice versa) is a
protocol bug in one of them, not a test bug. Run with `--expect-impl go`.

Expected SKIPs even after both implementations are complete:

* IP-denial tests without `--assert-denied`.
* Grace-expiry without `--slow --grace-ms`.
* SSH tests on machines with no `ssh` client or an OpenSSH too old for
  `SSH_ASKPASS_REQUIRE=force`.
* Lockout when the second loopback address cannot be bound.
* The `resize` test if the shell cannot run `stty size` (minimal/broken images).

A SKIP is never a substitute for a PASS. When a test SKIPs, read the reason and
ask whether the environment can be fixed; only environmental limits justify it.

---

## Test-writing rules (for future maintainers)

1. **The contract wins.** If the implementation disagrees, fix the
   implementation or change `PROTOCOL.md` deliberately in a versioned way — do
   not loosen the assertion.
2. **Every test must clean up.** Create a session, use it, terminate its shell
   (`exit\r`) and close the socket in `finally`. The 4-PTY cap is global.
3. **Never hang.** Every socket has a timeout; the harness also runs each test
   under a wall-clock alarm. A wedged server must produce FAIL, not a stuck
   suite.
4. **No implementation introspection.** Tests only use the wire: HTTP, WS, SSH,
   `/version`. No reading the server's files, logs, or process table.
5. **Assert status codes, not prose.** Error bodies are free-form.
6. **Mark optional behaviour SKIP with a reason**, never PASS by omission.
