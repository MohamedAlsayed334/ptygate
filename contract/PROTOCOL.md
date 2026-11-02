# ptygate protocol — version 1

Status: **normative**. This document is the contract. Where this document and an
implementation disagree, the implementation is wrong.

Machine-readable companion: [`VERSION`](./VERSION).

```
PROTOCOL_VERSION=1
PROTOCOL_SUBPROTOCOL=ptygate.v1
GATEWAY_VERSION=0.1.0
```

Conformance suite: [`tests/`](./tests/README.md). Every **MUST** below is exercised
by at least one test. Anything labelled **MAY** is explicitly optional and is not
required to pass.

Normative words: **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, **MAY** as in
RFC 2119.

---

## 1. Overview

ptygate is a guarded terminal gateway intended to run inside a panel or Docker
container. It exposes exactly **one allocated TCP port** and multiplexes three
things on it:

1. the browser terminal (HTTP + WebSocket),
2. the same HTTP surface over TLS (when enabled),
3. an SSH door (plain TCP, never wrapped in TLS).

One PTY per authenticated session, a bounded resume window, and a hard cap of
four live PTYs. Two independent implementations (`node`, `go`) must be wire
compatible with this document.

### 1.1 One-port multiplexing

The server reads the first bytes of every accepted connection (peek, do not
consume) and routes on them:

```
                 one allocated TCP port
                          |
                 accept() -> peek(8)
                          |
      +-------------------+--------------------+
      |                   |                    |
 first byte 0x16      "SSH-" prefix      anything else
 (TLS ClientHello)    (identification)   (HTTP/1.1)
      |                   |                    |
 TLS enabled?        SSH door             HTTP door
   yes | no           (plain TCP)         (plain HTTP)
       |  |
       v  v
  TLS then   close
  HTTP/WS    immediately
```

| Peeked bytes                          | Route                                                |
| ------------------------------------- | ---------------------------------------------------- |
| first byte `0x16`                     | TLS ClientHello. If TLS is enabled, terminate TLS and then serve HTTP/WS inside it. If TLS is disabled, the connection is closed immediately (no plaintext fallback for this connection). |
| starts with `SSH-` (ASCII)            | SSH door, RFC 4253. Never wrapped in TLS.            |
| anything else, including empty input  | Plain HTTP/1.1 door. An empty/EOF connection is closed. |

Notes:

* Peeking MUST NOT consume bytes. Implementations read up to 8 bytes then hand
  the same bytes to the selected protocol parser.
* `0x16` is the TLS handshake record type. It is unambiguous with both `SSH-`
  and every HTTP method.
* A TLS-enabled server still answers **plain HTTP** on non-`0x16` first bytes.
  TLS is an additional door, not a replacement. The `Secure` cookie attribute is
  decided per request (§3.3).
* The protocol version is not negotiable at the multiplexer. Version negotiation
  happens via the WebSocket subprotocol (§4.2) and `/version` (§13).

---

## 2. Connection and session identity

There is exactly one identity in v1: the **session id**, which is the value of
the `wt_session` cookie. It is an opaque ASCII string of at least 32 random
bytes, encoded as hex or base64url (no `;`, no whitespace). It is created only by
a successful `POST /login`.

* One PTY per session id at any time.
* `hello.session` (§4.4) MUST equal the cookie value that authorised the
  WebSocket.
* The session id is a bearer secret. Implementations MUST NOT log it in full and
  MUST NOT log raw cookie headers (§14).

SSH connections do not use cookies. Each SSH connection that requests a PTY or
an exec is its own PTY consumer (see §8) and is **not** resumable in v1.

---

## 3. HTTP surface

Plain HTTP/1.1 and HTTP/1.1-over-TLS. HTTP/2 is out of scope for v1. Persistent
connections are **MAY**; every response in this contract is correct with
`Connection: close`.

### 3.1 Endpoints

| Method | Path        | Auth | Success response                                                        |
| ------ | ----------- | ---- | ----------------------------------------------------------------------- |
| GET    | `/healthz`  | no   | `200`, `Content-Type: text/plain`, body `ok`                             |
| GET    | `/version`  | no   | `200`, `Content-Type: application/json`, body per §3.2                   |
| GET    | `/login`    | no   | `200`, HTML login page                                                   |
| POST   | `/login`    | no   | `303 See Other`, `Location: /`, `Set-Cookie: wt_session=...` on success  |
| GET    | `/logout`   | no   | `303 See Other`, `Location: /login`, cookie cleared                      |
| GET    | `/`         | yes  | `200`, terminal HTML                                                     |
| GET    | `/assets/*` | no   | `200` static file, or `404` if the asset does not exist                   |
| GET    | `/ws`       | yes  | `101 Switching Protocols` (§4)                                           |

Rules:

* The IP policy (§7) applies to **every** endpoint, including `/healthz`,
  `/version`, `/login`, and `/assets/*`. A denied client gets `403` before any
  routing or parsing.
* No endpoint other than `POST /login` creates a session.
* Any other path returns `404`. A known path with the wrong method returns
  `405` (e.g. `POST /healthz`). `HEAD` for `GET` endpoints is **MAY**.
* `/assets/*` is public and MUST NOT redirect to `/login`. Assets contain no
  secrets.
* HTML responses (`/`, `/login`) MUST send `Cache-Control: no-store`.
* `/healthz` MUST NOT require authentication and MUST NOT create, touch, or
  require a session. It is the liveness probe.
* Requests are limited to 16 KiB of headers and 8 KiB of form body. Over-limit
  requests are rejected with `400` (or `413` for an over-large body); the
  connection is closed. Never hang.

### 3.2 `/version`

`GET /version` returns exactly this shape (additional fields are **MAY** and
MUST be ignored by clients):

```json
{
  "name": "ptygate",
  "impl": "node",
  "version": "0.1.0",
  "protocol": 1,
  "transports": { "http": true, "tls": false, "ssh": true },
  "ip_mode": "allowlist"
}
```

| Field                | Type    | Meaning |
| -------------------- | ------- | ------- |
| `name`               | string  | Always `"ptygate"`. |
| `impl`               | string  | `"node"` or `"go"`. |
| `version`            | string  | Gateway software version, semver. `0.1.0` for this contract. |
| `protocol`           | integer | `PROTOCOL_VERSION`, currently `1`. |
| `transports.http`    | bool    | Always `true`. |
| `transports.tls`     | bool    | TLS termination is enabled on this port. |
| `transports.ssh`     | bool    | SSH door is enabled on this port. |
| `ip_mode`            | string  | Effective mode: `"allowlist"` or `"any"`. |

`/version` is unauthenticated but subject to the IP policy. It MUST NOT reveal
the token, the data directory, allowed IPs, session ids, or host keys.

### 3.3 Cookies and sessions

On a successful login the server sends:

```
Set-Cookie: wt_session=<session-id>; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200
```

and additionally `; Secure` when the login request itself was served over TLS.

| Attribute        | Requirement |
| ---------------- | ----------- |
| name             | `wt_session` |
| value            | at least 32 random bytes, hex or base64url; MUST NOT contain `;`, `,`, whitespace, or control chars |
| `HttpOnly`       | MUST |
| `SameSite`       | `Strict` |
| `Path`           | `/` |
| `Max-Age`        | `43200` (12 hours) |
| `Secure`         | MUST be present iff the request that set the cookie arrived over TLS |

Cookie parsing MUST be total: malformed percent-escapes (`%`, `%zz`,
`%E0%A4%A`, truncated UTF-8) MUST NOT throw and MUST NOT hang. A cookie that
does not name a live session is simply unauthenticated (`401` for `/ws`, `302`
for `/`). See §15.2 for the mandatory hostile-input cases.

Session ids are valid for the `Max-Age` window. A session is invalidated by
`GET /logout` (§3.5) or by a process restart (§5.8); **PTY exit does not
invalidate the cookie**. After a PTY exits, or after its grace expires, a new
`/ws` upgrade with the same cookie spawns a fresh PTY (`resumed: false`) until
the cookie itself expires.

### 3.4 `/login`

`GET /login` returns the HTML login form (public). It MAY redirect to `/` with
`302` when the request already carries a valid session; tests do not require
this.

`POST /login` accepts `Content-Type: application/x-www-form-urlencoded` with the
single field `token`:

| Condition                      | Response |
| ------------------------------ | -------- |
| token matches (§6)             | `303`, `Location: /`, sets cookie |
| token missing or wrong         | `401` |
| IP currently locked out (§6)   | `429` |
| body/field unparseable         | `401` (never `500`) |

Failure responses MUST NOT set a `wt_session` cookie and MUST NOT echo the
submitted token in the body or headers. There is no redirect-to-`/login?error`
behaviour in v1: the status code is the result.

### 3.5 `/logout`

`GET /logout`:

* invalidates the session id presented in the cookie (if any) and, if its PTY is
  detached, terminates the resume grace immediately (§5.6);
* replies `303` with `Location: /login`;
* sends `Set-Cookie: wt_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
  (plus `Secure` when this request arrived over TLS);
* is idempotent and succeeds without a cookie.

`POST /logout` **MAY** also be accepted for the existing browser form, but
`GET /logout` is the contract.

### 3.6 HTTP status codes used

| Status | Meaning in v1 |
| ------ | ------------- |
| `101`  | WebSocket upgrade accepted. |
| `200`  | OK. |
| `302`  | `GET /` without a valid session, `Location: /login`. |
| `303`  | Login success, logout. |
| `400`  | Malformed request, bad handshake, missing `Host`, bad `Content-Length`. |
| `401`  | Missing/invalid session (WS), missing/wrong login token. |
| `403`  | IP policy denial; Origin/Host mismatch. |
| `404`  | Unknown path or asset. |
| `405`  | Known path, wrong method. |
| `413`  | Request body too large. |
| `426`  | WebSocket subprotocol missing or not `ptygate.v1`. |
| `429`  | Login lockout, or PTY capacity exhausted. |
| `500`  | Unexpected internal error. The process keeps serving. |

Error bodies are human-readable text; clients MUST key on the status code, not
on the body.

---

## 4. WebSocket `/ws`

### 4.1 Handshake requirements

A valid upgrade request:

```
GET /ws HTTP/1.1
Host: 127.0.0.1:8080
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: <base64, 16 random bytes>
Sec-WebSocket-Version: 13
Sec-WebSocket-Protocol: ptygate.v1
Cookie: wt_session=<session-id>
Origin: http://127.0.0.1:8080
```

* `Sec-WebSocket-Version` MUST be `13`.
* `Sec-WebSocket-Key` MUST be present and base64.
* The response MUST contain `Sec-WebSocket-Accept` =
  `base64(sha1(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))`.
* `Origin` is optional. When present, its host **and port** MUST equal the
  `Host` header, compared case-insensitively. `Origin: null` is a mismatch.
  Missing `Origin` is allowed (non-browser clients).
* Any other `Upgrade` target than `/ws` returns `404`.

### 4.2 Subprotocol and check order

The **only** accepted subprotocol is `ptygate.v1`. The client MUST send it and
the server MUST echo exactly that value in `Sec-WebSocket-Protocol` on `101`.

A missing, empty, or different subprotocol returns `426 Upgrade Required`
**before** the upgrade completes. The `426` response SHOULD advertise
`Sec-WebSocket-Protocol: ptygate.v1`; the server MUST NOT return `101` without
having echoed the exact subprotocol.

The server evaluates checks in this fixed order, so tests are deterministic:

1. Malformed handshake (missing `Upgrade`/`Connection`/`Sec-WebSocket-Key`/
   `Sec-WebSocket-Version`, bad method, bad path shape) → `400` / `404`.
2. IP policy (§7) → `403`.
3. `Origin` present and not equal to `Host` → `403`.
4. Session cookie missing, malformed, or unknown → `401`.
5. Capacity (§9) → `429`.
6. Subprotocol missing/mismatched → `426`.
7. Otherwise `101`.

Consequences (normative): a hostile cookie is rejected with `401` even when no
subprotocol is offered, and an allowed, authenticated client that forgets the
subprotocol gets `426`, not `101`.

### 4.3 Framing

Standard RFC 6455. Servers and clients MUST:

* Use text frames (`opcode 0x1`) carrying UTF-8 JSON objects. Binary frames are
  not part of v1; a server MAY ignore them.
* Mask every client→server frame (4-byte mask) and never mask server→client
  frames. A server receiving an unmasked client data frame MAY close `1002`.
* Support 7-bit, 16-bit (`126`, 2-byte big-endian) and 64-bit (`127`, 8-byte
  big-endian) payload lengths. Lengths are payload bytes, not including mask.
* Support fragmentation on receive (continuation `0x0`) and MUST send each JSON
  message as a single unfragmented frame.
* Control frames: close `0x8`, ping `0x9`, pong `0xA`. Control frames MUST NOT
  be fragmented and MUST have payload ≤ 125 bytes.
* Send `close` with a status code before closing TCP whenever possible.

Limits (see §9):

* **Client→server frame payload: 65536 bytes maximum.** Larger input closes the
  socket with code `1009` ("message too big") after an optional `error` frame.
* **Server→client:** normal frames SHOULD stay ≤ 65536 bytes. The one exception
  is replay (§5.3), which MAY be sent as one coalesced frame of up to 262144
  bytes. A client MUST handle both the coalesced and the split forms.

### 4.4 Messages

All messages are JSON objects with a string `type`. Unknown `type` values MUST
be ignored (forward compatibility). Unknown extra fields MUST be ignored.
Malformed JSON from the client MAY be ignored or answered with an `error` frame;
it MUST NOT close the connection and MUST NOT crash the server.

**Server → client, always first:**

```json
{"type":"hello","protocol":1,"impl":"node","session":"<session-id>","cols":80,"rows":24,"resumed":false}
```

| Field      | Type    | Rules |
| ---------- | ------- | ----- |
| `type`     | string  | `"hello"` |
| `protocol` | integer | `1` |
| `impl`     | string  | `"node"` or `"go"` |
| `session`  | string  | the cookie value that authorised this socket |
| `cols`     | integer | current PTY columns, `20..500` |
| `rows`     | integer | current PTY rows, `5..200` |
| `resumed`  | bool    | `true` iff this socket attached to an existing PTY (live or detached); `false` iff a new PTY was spawned |

`hello` MUST be the first server frame on every successful connection,
including resumes. The initial PTY size is implementation-chosen within the
bounds above. A `cols`/`rows` query parameter on the upgrade URL MAY be honoured;
tests do not require it.

**Client → server:**

```json
{"type":"input","data":"ls -la\r"}
{"type":"resize","cols":120,"rows":40}
{"type":"detach"}
```

| Type     | Fields        | Semantics |
| -------- | ------------- | --------- |
| `input`  | `data`: string | Bytes written to the PTY exactly as given (UTF-8). Empty strings are no-ops. |
| `resize` | `cols`, `rows`: integers | Resize the PTY. Values are clamped to `20..500` columns and `5..200` rows; out-of-range values MUST NOT error. |
| `detach` | — | Client-initiated detach: the server closes with `1000` and reason `detached`, and the PTY survives the grace window. The client MUST NOT expect further frames. |

**Server → client (after `hello`):**

```json
{"type":"output","data":"..."}
{"type":"exit","code":0,"signal":""}
{"type":"error","code":"bad_frame","message":"..."}
```

| Type     | Fields | Semantics |
| -------- | ------ | --------- |
| `output` | `data`: string | PTY output, in order. May be split at any UTF-8 boundary. |
| `exit`   | `code`: integer, `signal`: string | The shell exited. `code` is the exit status. `signal` is `""` for a normal exit, otherwise the signal name without the `SIG` prefix (e.g. `"TERM"`). Sent immediately before `close` `1000`. |
| `error`  | `code`: string, `message`: string | Non-fatal or pre-close error. Machine codes: `bad_frame`, `too_large`, `pty_spawn_failed`, `internal`. Optional; clients MUST tolerate its absence. |

When the shell exits: send `exit`, then `close` with code `1000`. The PTY is
destroyed immediately (no resume grace). The session cookie remains valid; a
later upgrade spawns a new PTY and reports `resumed: false`.

### 4.5 Heartbeat

* The server sends a WebSocket ping (`0x9`) every 30 seconds.
* The client MUST answer with a pong (`0xA`) carrying the same payload.
* After **2 consecutive missed pongs** (i.e. the second unanswered ping), the
  server terminates the TCP connection. The PTY is treated like an abrupt
  disconnect and enters the grace window.
* The server MUST answer client pings with pongs. Clients MUST NOT depend on
  pings arriving.

### 4.6 Close codes

| Code   | Reason string   | When |
| ------ | --------------- | ---- |
| `1000` | `""`            | Shell exited (after `exit` frame), or client sent `detach` (reason `"detached"`). |
| `1000` | `"detached"`    | Client-initiated `detach`. |
| `1001` | `"shutdown"`    | Server is shutting down. |
| `1002` | `"protocol error"` | Invalid frame/UTF-8, or `hello.protocol` mismatch detected by the client. |
| `1009` | `"message too big"` | Client frame payload > 65536 bytes. |
| `1011` | `"failed to start shell"` | PTY spawn failed. |
| `4000` | `"detached"`    | This socket was replaced by a newer socket for the same session. The PTY keeps running under the new socket. |

Codes >= 4000 are application codes and MUST be in the 4000–4999 range.

---

## 5. Sessions, PTYs and resume

### 5.1 PTY ownership

* The first successful `/ws` upgrade for a session id spawns one PTY running
  the user's login shell (`$SHELL -l`, fallback `/bin/bash`/`/bin/sh`).
* Exactly one PTY exists per session id at a time.
* The PTY is owned by the **socket**, not the HTTP connection: closing the
  TCP socket does not kill it immediately (see grace).
* PTY output is captured in a per-PTY ring buffer of the **last 262144 bytes**
  for the whole life of the PTY, whether attached or detached. The buffer is
  discarded when the PTY is destroyed.

### 5.2 Attach and replace

Every accepted upgrade with a valid session cookie attaches the socket to the
session's PTY, spawning it if it does not exist:

| Existing state for the session          | Result |
| --------------------------------------- | ------ |
| no PTY                                  | spawn PTY; `hello.resumed = false` |
| detached PTY inside the grace window    | reattach; replay then live; `hello.resumed = true` |
| PTY already attached to another socket  | **replace**: new socket becomes the owner; old socket is closed with code `4000`, reason `"detached"`; PTY, ring buffer and size unchanged; `hello.resumed = true` |

Replacement never creates a second PTY and never counts as a new PTY against
the cap (§9). The server closes the old socket **before or after** sending the
new `hello`; the ordering is not observable to a correct client.

### 5.3 Replay on reattach

Immediately after `hello` with `resumed: true`, and **before any live output**,
the server sends the ring buffer contents as `output` frame(s):

* total replay MUST be ≤ 262144 bytes;
* it SHOULD equal the last `min(total_output, 262144)` bytes of PTY output;
* it MAY be trimmed forward to a UTF-8 boundary;
* it MAY be one coalesced frame (≤ 262144 bytes) or several frames (≤ 65536
  each); clients MUST concatenate consecutive `output` frames;
* an empty buffer produces zero replay frames.

Live output follows the replay. The client cannot distinguish the end of the
replay from the start of live output by frame metadata; it simply renders all
`output` frames in order.

### 5.4 Detach

A socket can stop owning a PTY in three ways:

1. **Client sends `{"type":"detach"}`** → server closes with `1000`, reason
   `"detached"`; PTY survives.
2. **TCP connection drops / heartbeat timeout** → server detects the close; PTY
   survives (no close frame can be sent).
3. **Replaced** by a newer socket → old socket gets `4000`, reason
   `"detached"` (the PTY does not enter the detached state; it is already
   attached to the new socket).

### 5.5 Resume grace

A detached PTY survives `RESUME_GRACE_MS`, default **300000 ms** (5 minutes),
configurable with the `RESUME_GRACE_MS` environment variable.

* During grace, output keeps accumulating in the ring buffer.
* A new upgrade with the same session cookie reattaches and gets `resumed:true`.
* At expiry the server sends `SIGTERM` to the PTY process group, then `SIGKILL`
  after 2000 ms if it is still alive, and frees the PTY slot.
* After expiry, the next upgrade spawns a new PTY (`resumed:false`). The cookie
  itself remains valid.
* `GET /logout` (or session invalidation) kills a detached PTY immediately;
  `logout` is the supported way to free a slot without waiting.

### 5.6 Shell exit

When the shell process exits while attached:

1. server sends `{"type":"exit","code":N,"signal":"..."}`;
2. server sends WebSocket `close` `1000`;
3. the PTY and its ring buffer are destroyed immediately — **no grace**, no
   resume. A later upgrade spawns a new PTY.

If the shell exits while detached, the PTY is destroyed immediately and the
slot is freed; there is nothing to resume.

### 5.7 State machine

```
                     POST /login (valid token)
                              |
                              v
                        [ session, no PTY ]
                              |
                    /ws upgrade (first)
                              |
                              v
   +--------------------> [ attached ] <-------------------+
   |                          |  |                          |
   |   /ws upgrade same sid   |  |  detach / TCP close /    |
   |   (replace)              |  |  heartbeat timeout       |
   |                          |  v                          |
   |                     [ detached: grace 300 s ]          |
   |                          |                             |
   |                          +--- /ws upgrade same sid ----+
   |                          |           (resumed=true)
   |                          |
   |                          +--- grace expiry (SIGTERM, +2 s SIGKILL)
   |                          |           |
   |                          |           v
   |                          |      [ destroyed ]
   |                          |
   |   shell exit             |
   +---- exit frame + close   v
        1000 -------------> [ destroyed ]

  old socket replaced ----> close 4000 "detached" (PTY stays attached)
```

### 5.8 No persistence across restart

**Sessions, PTYs, ring buffers, the login lockout table and all WebSocket
state live in memory only.** A process restart destroys every session and
every PTY. There is no PTY re-parenting, no session store, and no cookie that
survives. This is a deliberate v1 property, not a bug: a panel restart is a
fresh gateway. The token, host key, TLS certificate, `authorized_keys` and
`config.json` do survive because they are files (§10.3).

---

## 6. Authentication

### 6.1 Tokens

* The gateway token is a printable string of at least **16 characters**.
  Shorter tokens are a startup error; the process MUST refuse to start.
* If no token is configured, the server generates one from at least 24 random
  bytes (base64url or hex) and prints it once to stderr/log.
* Comparison is **constant-time** over equal-length buffers; a length mismatch
  still performs a dummy comparison and returns false. No early-exit byte
  comparison.
* The token is accepted only as:
  * the `token` form field of `POST /login`;
  * the SSH password, with any username (§8.3).

The token is never accepted in a query string, header, path, or cookie.

### 6.2 Login throttling

* Counter key: the client IP as seen by the server after unmapping
  IPv4-mapped IPv6 (`::ffff:1.2.3.4` → `1.2.3.4`).
* A failed attempt is a missing or wrong `token`; a successful login resets the
  counter.
* After **10 failed attempts** the IP is locked out for **900 seconds**
  (15 minutes); every `POST /login` from that IP returns `429` until the lock
  expires, including attempts with the correct token.
* Lockout is per IP and does not invalidate existing sessions or block `/ws`
  for an already-authenticated session, `/healthz`, or `/version`.
* SSH password failures count toward the same counter (§8.3).
* Lockout state is in memory and lost on restart.

### 6.3 What is never logged

The token, any submitted password, keystrokes, PTY input, raw `Cookie` headers
and full session ids MUST NOT appear in logs, error bodies, or `/version`.
Session ids MAY appear truncated to 8 hex characters of a hash for correlation.

---

## 7. IP policy

`IP_MODE` is `"allowlist"` (default) or `"any"`.

### 7.1 Allowlist mode

`ALLOWED_IPS` is a comma-separated list of IPv4/IPv6 addresses and CIDRs
(`10.0.0.0/8`, `192.168.1.7`, `fd00::/8`, `::1`). Whitespace around entries is
ignored; empty entries are ignored.

When `ALLOWED_IPS` is unset or empty, the default allowlist is:

| Range | Reason |
| ----- | ------ |
| `127.0.0.0/8`, `::1` | loopback |
| `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` | RFC 1918 |
| `100.64.0.0/10` | CGNAT / Tailscale |
| `169.254.0.0/16`, `fe80::/10` | link-local |
| `fc00::/7` | IPv6 unique-local |

Explicit `ALLOWED_IPS` **replaces** the default list entirely. An explicit list
that excludes loopback therefore denies loopback; this is how denial is tested.

### 7.2 Any mode

`IP_MODE=any` allows every source address. Because that is a materially larger
exposure, TLS auto-enables unless explicitly disabled (§9.2, §10.1).

### 7.3 Enforcement points

| Door | Denied behaviour |
| ---- | ---------------- |
| HTTP (plain or TLS) | `403` before routing, for every path including `/healthz`, `/version`, `/login`, `/assets/*`. The socket is closed after the response. |
| WebSocket | `403` HTTP response before `101`; no `hello`, no PTY spawned. |
| SSH | TCP connection closed **before** the server banner is sent. The client sees EOF/reset, not an authentication prompt. |

Denials MUST be fast (the tests require `/healthz` to answer within seconds
after hostile traffic). Denials MUST NOT crash the process or consume a PTY
slot.

---

## 8. SSH door

The SSH door shares the single allocated port and is selected by the `SSH-`
prefix (§1.1). It is never wrapped in TLS.

### 8.1 Banner and host key

* Server identification string: exactly `SSH-2.0-ptygate_0.1.0\r\n`
  (the software version follows the gateway semver).
* The server sends the banner immediately on connect, before any
  authentication, and does not wait for the client banner.
* Host key: **Ed25519**, generated on first run, stored in the data dir as
  `ssh_host_ed25519` (private, mode `0600`) and `ssh_host_ed25519.pub`
  (public). It is reused across restarts.
* SSH protocol: standard SSH-2.0 (RFC 4251–4254). Only the pieces needed for
  shell/exec are required; `none` authentication MUST NOT be accepted.

### 8.2 Authentication

Two mechanisms, either succeeds:

1. **password** — the password equals the gateway token; the username is
   ignored (any non-empty username is accepted).
2. **publickey** — the offered key is listed in `authorized_keys` in the data
   dir (OpenSSH `authorized_keys` format; blank lines and `#` comments
   ignored; key type/options parsed leniently).

Keyboard-interactive is **MAY** and, if implemented, MUST behave exactly like
password. `none` MUST fail. Wrong credentials produce a normal SSH
authentication failure. Ten failed authentications from one IP trigger the
same 15-minute lockout as §6.2; while locked, the server closes the TCP
connection (before or immediately after the banner) without accepting auth.

### 8.3 Channels

* **PTY request** (`pty-req`): allocate a PTY and spawn the login shell.
  `TERM` from the request is used for the child environment.
  `window-change` requests resize the PTY, clamped to `20..500` × `5..200`.
* **exec** (`exec` request without a PTY): run the command through the login
  shell (`sh -c <command>`), stream stdout/stderr over the channel, and return
  the command's exit status (`exit-status`). Signal exits map to
  `exit-signal`.
* **shell** (without PTY): **MAY**; if implemented, behaves like a PTY shell
  with default size.
* `env` requests are **MAY**; unsupported requests are rejected, never fatal.
* SSH sessions are **not resumable**. Closing the connection kills the PTY;
  no grace, no replay. Each PTY/exec counts against the 4-PTY cap (§9) while
  active.
* Port forwarding (`direct-tcpip`, `tcpip-forward`), SFTP and SCP are out of
  scope (§16) and MUST be rejected (`SSH_MSG_CHANNEL_OPEN_FAILURE`).

---

## 9. TLS

### 9.1 When it is enabled

| Situation | TLS on the port |
| --------- | --------------- |
| `--tls` / `PTYGATE_TLS=1` | enabled |
| `--no-tls` / `PTYGATE_TLS=0` | disabled |
| `IP_MODE=any`, nothing explicit | **enabled** (auto) |
| `IP_MODE=allowlist`, nothing explicit | disabled (plain HTTP only) |

Explicit configuration always wins over the auto rule, including
`--no-tls` with `IP_MODE=any`. TLS is a property of the **port**, not of a
route: when enabled, a `0x16` first byte is terminated and HTTP/WS is served
inside TLS; non-`0x16` first bytes still serve plain HTTP/WS on the same port.

### 9.2 Certificate

* Self-signed **ECDSA P-256** certificate, SHA-256 signature.
* Subject CN: `ptygate`.
* SANs MUST include `DNS:localhost`, `IP:127.0.0.1`, `IP:::1`, and every
  non-loopback local IP detected on the host's interfaces at generation time.
* Stored as `cert.pem` (certificate) and `key.pem` (private key, mode `0600`) in
  the data dir. Generated on first run. Regenerated when missing, unreadable,
  expired, or when the SAN set no longer covers the current local IPs.
* Validity: 365 days. There is no ACME, no CA trust, and no certificate
  pinning in v1; clients are expected to accept the self-signed certificate or
  use `--insecure`-style verification off.
* TLS 1.2 minimum. ALPN offers `http/1.1`; HTTP/2 is out of scope.

---

## 10. Configuration

### 10.1 Precedence

Highest wins:

1. **CLI flag**
2. **environment variable** (with `PTYGATE_*` beating legacy names)
3. **stored `config.json`** in the data dir
4. **generated/default**

### 10.2 Flags and environment

| Setting | CLI | Env (canonical) | Legacy env (MUST keep working) | Default |
| ------- | --- | --------------- | ------------------------------ | ------- |
| port | `--port N` | `PTYGATE_PORT` | `PORT`, `SERVER_PORT` | `8080` |
| host | `--host ADDR` | `PTYGATE_HOST` | `HOST`, `LAN=1` (⇒ `0.0.0.0`) | container ? `0.0.0.0` : `127.0.0.1` |
| token | `--token S` | `PTYGATE_TOKEN` | `TERMINAL_TOKEN` | generated (≥24 random bytes) |
| IP mode | `--ip-mode allowlist\|any` | `PTYGATE_IP_MODE` | `ALLOW_PRIVATE_ONLY=0` ⇒ `any`; `ALLOW_PRIVATE_ONLY=1` ⇒ `allowlist` | `allowlist` |
| allowed IPs | `--allowed-ips LIST` | `PTYGATE_ALLOWED_IPS` | `ALLOWED_IPS` | loopback + RFC1918 + CGNAT (§7.1) |
| data dir | `--data-dir PATH` | `PTYGATE_DATA_DIR` | — | `$XDG_CONFIG_HOME/ptygate`, else `~/.config/ptygate` |
| TLS | `--tls` / `--no-tls` | `PTYGATE_TLS=1\|0` | — | auto (§9.1) |
| console | `--console` | `LOCAL_CONSOLE=1` (legacy) | — | off |
| log level | `--log-level LEVEL` | `PTYGATE_LOG_LEVEL` | — | `info` |
| version | `--version` | — | — | prints `ptygate 0.1.0 (protocol 1)` and exits 0 |

Rules:

* `--tls` and `--no-tls` are mutually exclusive; if both appear, `--no-tls`
  wins (documented, not tested) — or the process exits with a usage error.
  Tests never pass both.
* `LAN=1` only changes the default **host**, never the IP mode.
* `ALLOW_PRIVATE_ONLY=0` maps to `IP_MODE=any`; `ALLOW_PRIVATE_ONLY` unset or
  `1` leaves `IP_MODE=allowlist`.
* Empty env values are treated as unset.
* Unknown flags: exit non-zero with usage on stderr.
* Invalid values (non-numeric port, unknown `--ip-mode`, token shorter than 16
  chars) are startup errors: print a clear message to stderr and exit `1`.

### 10.3 Container detection and default host

The process counts as "inside a container" if any of:

* `/.dockerenv` exists,
* `/run/.containerenv` exists,
* `/proc/1/cgroup` contains `docker`, `kubepods`, `containerd`, `lxc`, or
  `pterodactyl`.

Inside a container the default host is `0.0.0.0`; otherwise `127.0.0.1`.
`TEST`/CI is not special-cased.

### 10.4 Data directory

Resolution order: `--data-dir` > `PTYGATE_DATA_DIR` > `config.json` >
`$XDG_CONFIG_HOME/ptygate` > `~/.config/ptygate`. The directory is created
with mode `0700` if missing. Files:

| File | Mode | Purpose |
| ---- | ---- | ------- |
| `token` | `0600` | generated token when none was configured; read on next start |
| `ssh_host_ed25519` | `0600` | Ed25519 host private key |
| `ssh_host_ed25519.pub` | `0644` | host public key |
| `authorized_keys` | `0600` | public keys accepted for SSH auth |
| `cert.pem` | `0644` | TLS certificate |
| `key.pem` | `0600` | TLS private key |
| `config.json` | `0600` | persisted effective config (the lowest-priority source) |

If `HOME` is unset or not writable, startup fails with a clear message rather
than silently writing to `/`.

---

## 11. Limits

| Limit | Value | Enforcement |
| ----- | ----- | ----------- |
| concurrent PTYs, all doors | **4** | 5th new PTY → `429` (HTTP/WS) or SSH channel failure/disconnect |
| PTYs per session id | **1** | new socket replaces the old (`4000`) |
| client→server WebSocket frame | 65536 bytes | `close 1009` |
| replay payload | 262144 bytes | ring buffer bound |
| request headers | 16 KiB | `400` |
| login body | 8 KiB | `413` (or `400`) |
| failed logins per IP | 10 per 15 min | `429` |
| session lifetime | 12 h | cookie `Max-Age=43200` |
| resume grace | 300000 ms | `SIGTERM`, `SIGKILL` +2 s |
| heartbeat | ping 30 s, 2 missed pongs | terminate socket |
| resize clamp | cols 20–500, rows 5–200 | clamp, never error |
| SSH auth attempts per IP | 10 per 15 min | disconnect/lockout |

Capacity accounting:

* A PTY counts while attached **and** while detached in the grace window.
* Replacing a socket for a session that already owns a PTY never adds a count.
* Reattaching inside grace never adds a count.
* Shell exit and grace expiry free the slot immediately.
* Local `--console` is a recovery shell, not a network door: it does **not**
  count against the 4-PTY cap.

---

## 12. `--console` (recovery path)

`--console` bridges a PTY to the server process's own stdin/stdout, in addition
to the network doors. It requires an interactive TTY; on a non-TTY it logs a
warning and runs headless.

* While the console shell is active, normal log lines are **buffered** (bounded,
  e.g. 200 lines) so they do not corrupt the terminal, then flushed to stderr
  when the shell exits.
* The console shell is a normal login shell with the terminal's size; it
  resizes with the local terminal.
* `exit` ends the console shell and returns to the server; the network doors
  keep running and the buffered log is printed.
* The panel start command SHOULD include `--console`. When the HTTP and SSH
  doors are broken (bad token, bad TLS, misconfigured allowlist), the console
  is the only way back in without redeploying. This is the documented recovery
  path.

---

## 13. Versioning

Three independent numbers:

1. **`PROTOCOL_VERSION`** — wire contract revision. Currently `1`. Lives in
   `contract/VERSION`, `/version.protocol`, and `hello.protocol`.
2. **WebSocket subprotocol** — `ptygate.v1`. This is the hard gate: a server
   MUST NOT upgrade a socket that does not offer it, and MUST echo it on `101`.
3. **Gateway software version** — semver, `0.1.0` today. Appears in
   `/version.version` and the SSH banner.

Compatibility contract:

* Adding new JSON fields or new optional message types is backward compatible
  within protocol 1; clients MUST ignore unknown fields/types.
* Removing or retyping a field, changing a status code, changing a cookie name,
  changing the subprotocol, or changing close-code meanings requires
  `PROTOCOL_VERSION=2` with subprotocol `ptygate.v2` and a new `/version`.
* Mismatch rejection:
  * **WebSocket:** missing/different subprotocol → `426` before `101`; the
    `426` SHOULD advertise `Sec-WebSocket-Protocol: ptygate.v1`.
  * **Client after upgrade:** if `hello.protocol != 1`, the client MUST close
    with `1002` and not send input.
  * **Preflight:** clients SHOULD `GET /version` and refuse to connect when
    `protocol != 1`; `name` must be `ptygate`.
  * **SSH:** the banner identifies software and version; SSH's own version
    negotiation is unaffected. A v2 gateway may keep the same banner scheme.

The conformance suite is written against protocol **1** and MUST NOT be
weakened to accept other revisions.

---

## 14. Logging

One line per event, to **stderr**, in this exact grammar:

```
LEVEL event key=value key=value ...
```

* `LEVEL` ∈ `DEBUG`, `INFO`, `WARN`, `ERROR` (uppercase).
* `event` is a dotted lowercase token, e.g. `http.request`, `ws.attach`,
  `pty.exit`, `auth.fail`, `ip.deny`, `tls.ready`.
* Keys are lowercase dotted tokens; values are unquoted unless they contain
  spaces, `=`, or quotes, in which case they are double-quoted with `\"`/`\\`
  escaping.
* One line per event; no multi-line messages and no embedded newlines.
* Stdout is reserved for the `--console` PTY bridge and MUST NOT carry logs.

Examples:

```
INFO http.listen addr=0.0.0.0:8080 tls=true ssh=true ip_mode=allowlist
INFO ws.attach session=9f2c1a7b cols=120 rows=40 resumed=false ip=10.0.0.5
WARN auth.fail ip=203.0.113.9 attempts=3
ERROR pty.spawn_failed ip=10.0.0.5 reason="shell not found"
```

Never logged: token, password, keystrokes/PTY input, raw cookies, full session
ids, private keys, TLS private material.

Log level is set by `--log-level` / `PTYGATE_LOG_LEVEL` (`debug`, `info`,
`warn`, `error`). Invalid levels are a startup error.

---

## 15. Mandatory hostile-input behaviour

These are MUSTs because they are the difference between "returns an error" and
"wedges the gateway".

### 15.1 Cookie decoding

Cookie values are percent-decoded with a decoder that never throws. Invalid
escapes are left as literal text or cause the cookie to be treated as absent.
A malformed cookie MUST NOT produce a `500`, MUST NOT close the process, and
MUST NOT hang the request. Such a cookie is simply unauthorised: `401` on a
raw `/ws` upgrade, `302` on `/`.

### 15.2 Required cases (asserted by `test_regression.py`)

| `Cookie: wt_session=` value | Expected `/ws` result |
| --------------------------- | --------------------- |
| `%E0%A4%A` (truncated UTF-8, bad escape) | `401` |
| `%E0%A4` | `401` |
| `%` | `401` |
| `%zz` | `401` |
| 4000 `A` characters | `401` |
| `%00`, `%0d%0a`, mixed valid/invalid escapes | `401` |

After **each** case, `GET /healthz` MUST still answer `200 ok` within 5 seconds.
This proves the hostile request left no stuck decoder, no leaked socket state,
and no wedged worker.

### 15.3 Other malformed input

* A request line with binary garbage, or a non-ASCII method, gets `400` or a
  connection close; the process survives.
* An HTTP/1.1 request with no `Host` header gets `400`.
* A WebSocket handshake missing `Sec-WebSocket-Key` (with a valid cookie and
  subprotocol) gets `400`.
* Partial requests (headers split across packets) are handled normally;
  a client that disconnects mid-request leaks nothing.
* These requests may not allocate a PTY.
* For SSH, a client that connects and sends garbage before its identification
  line gets disconnected; the server keeps serving other doors.

---

## 16. Explicitly out of scope for v1

Not implemented, not promised, and not tested:

* **File transfer** — SFTP, SCP, upload/download endpoints.
* **Editor / file browser** — terminal only.
* **Port forwarding / proxying** — SSH `-L`/`-R`/`-D`, HTTP CONNECT, arbitrary
  TCP proxy.
* **Multi-user** — one shared gateway token, one shared allowlist, no accounts,
  no per-user sessions, no roles.
* **Persistence across process restart** — sessions, PTYs and scrollback die
  with the process (§5.8).
* **Session recording / audit trail** — no keystroke or output recording.
* **Clipboard integration, OSC 52, image protocols**.
* **HTTP/2, HTTP/3, WebTransport**.
* **ACME / public CA certificates, certificate pinning**.
* **TLS on the SSH door**.
* **Multiple allocated ports** — the whole point is one.
* **Desktop notifications, mobile apps, PWA offline mode**.

---

## Appendix A — Raw handshake example

```
GET /ws HTTP/1.1\r\n
Host: 127.0.0.1:8080\r\n
Upgrade: websocket\r\n
Connection: Upgrade\r\n
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n
Sec-WebSocket-Version: 13\r\n
Sec-WebSocket-Protocol: ptygate.v1\r\n
Cookie: wt_session=0123...cdef\r\n
Origin: http://127.0.0.1:8080\r\n
\r\n
```

Expected first server frame:

```
{"type":"hello","protocol":1,"impl":"go","session":"0123...cdef","cols":80,"rows":24,"resumed":false}
```

then, after the client sends
`{"type":"input","data":"printf 'hi\\n'\r"}`, `output` frames carrying the
shell's echo and `hi`.

## Appendix B — Conformance

See [`tests/README.md`](./tests/README.md) for how to run the suite, what each
module proves, and which checks are expected to be RED until the Node and Go
implementations catch up.

