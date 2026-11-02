#!/usr/bin/env python3
"""Hostile-input regression tests.

The theme is: a malformed request is an error, never a hang, never a crash,
and never a wedged decoder. After every hostile request the gateway must still
answer /healthz.
"""

from __future__ import annotations

import sys
import time

import harness
import httpclient as H
import wsclient
from harness import require, require_eq, require_in, test

HOSTILE_COOKIES = [
    "%E0%A4%A",      # truncated UTF-8 + bad escape (the original regression)
    "%E0%A4",        # truncated UTF-8
    "%",             # lone percent
    "%zz",           # invalid hex
    "%00",           # NUL
    "%0d%0a",        # encoded CRLF
    "A" * 4000,      # oversized cookie value
    "w%C3%B6rld",    # valid percent-encoded UTF-8
    "%E0%A4%A%E0%A4",  # two bad sequences
    "%%%",           # repeated lone percents
]


def _healthz_ok(cfg, budget=5.0):
    started = time.monotonic()
    resp = H.get(cfg, "/healthz", timeout=budget)
    elapsed = time.monotonic() - started
    require_eq(resp.status, 200, "GET /healthz after hostile input")
    require_eq(resp.text.strip(), "ok", "GET /healthz body after hostile input")
    require(
        elapsed <= budget,
        f"GET /healthz took {elapsed:.2f}s after hostile input (budget {budget:g}s)",
    )


@test
def hostile_cookies_are_401_then_healthz(cfg):
    """Malformed cookie values are unauthorised, never a hang (401)."""
    for value in HOSTILE_COOKIES:
        label = value if len(value) <= 20 else value[:17] + "..."
        started = time.monotonic()
        status, client = wsclient.handshake_status(cfg, cookie=value, timeout=5)
        elapsed = time.monotonic() - started
        if client is not None:
            client.close_socket()
        require_eq(status, 401, f"WS upgrade with hostile cookie {label!r}")
        require(
            elapsed <= 5,
            f"hostile cookie {label!r} took {elapsed:.2f}s (server hung)",
        )
        _healthz_ok(cfg)


@test
def hostile_cookie_without_subprotocol_is_still_401(cfg):
    """Auth is checked before the subprotocol, so the cookie wins with 401."""
    status, client = wsclient.handshake_status(
        cfg, cookie="%E0%A4%A", send_subprotocol=False, timeout=5
    )
    if client is not None:
        client.close_socket()
    require_eq(
        status, 401,
        "hostile cookie without a subprotocol must be 401 (auth precedes 426)",
    )
    _healthz_ok(cfg)


@test
def missing_websocket_key_is_400(cfg):
    """A handshake without Sec-WebSocket-Key is a 400, not a 101."""
    cookie = H.login_cookie(cfg)
    request = (
        b"GET /ws HTTP/1.1\r\n"
        b"Host: " + cfg.host_header.encode("latin-1") + b"\r\n"
        b"Upgrade: websocket\r\n"
        b"Connection: Upgrade\r\n"
        b"Sec-WebSocket-Version: 13\r\n"
        b"Sec-WebSocket-Protocol: ptygate.v1\r\n"
        b"Cookie: " + H.cookie_header(cookie).encode("latin-1") + b"\r\n\r\n"
    )
    result = wsclient.raw_exchange(cfg, request, timeout=5)
    try:
        require_eq(result.status, 400, "handshake without Sec-WebSocket-Key")
        require(
            result.status != 101,
            "server upgraded a handshake with no Sec-WebSocket-Key",
        )
        _healthz_ok(cfg)
    finally:
        wsclient.terminate(cfg, cookie)


@test
def missing_host_header_is_400(cfg):
    """HTTP/1.1 requires Host; its absence is a 400."""
    request = b"GET /healthz HTTP/1.1\r\nConnection: close\r\n\r\n"
    result = wsclient.raw_exchange(cfg, request, timeout=5)
    require_eq(result.status, 400, "HTTP/1.1 request without Host")
    _healthz_ok(cfg)


@test
def binary_garbage_does_not_kill_the_server(cfg):
    """Random first bytes are rejected or dropped; the process keeps serving."""
    for blob in (
        b"\x00\x01\x02\x03garbage\r\n\r\n",
        b"\xff\xfe\xfd\r\n\r\n",
        b"PATCH\x00 / HTTP/1.1\r\n\r\n",
    ):
        result = wsclient.raw_exchange(cfg, blob, timeout=5)
        require_in(
            result.status, (None, 400, 404, 405, 501),
            f"binary garbage response status ({result.status})",
        )
        _healthz_ok(cfg)


@test
def partial_request_then_disconnect_is_harmless(cfg):
    """A client that closes mid-request leaks nothing."""
    sock = wsclient.open_socket(cfg, timeout=5)
    try:
        sock.sendall(
            b"GET /healthz HTTP/1.1\r\nHost: "
            + cfg.host_header.encode("latin-1")
            + b"\r\n"
        )
    finally:
        try:
            sock.close()
        except OSError:
            pass
    _healthz_ok(cfg)


@test
def hostile_requests_do_not_consume_pty_slots(cfg):
    """After the hostile traffic above, four normal sessions still fit."""
    clients = []
    try:
        for _ in range(4):
            cookie = H.login_cookie(cfg)
            client, hello = wsclient.attach(cfg, cookie)
            require_eq(hello.get("resumed"), False,
                       "hostile traffic left a PTY attached")
            clients.append(client)
        fifth_cookie = H.login_cookie(cfg)
        status, rejected = wsclient.handshake_status(cfg, cookie=fifth_cookie)
        if rejected is not None:
            rejected.close_socket()
        require_eq(status, 429, "four PTYs must still be available after garbage")
    finally:
        for client in clients:
            try:
                client.send_json({"type": "input", "data": "exit\r"})
                client.wait_close(timeout=5)
            except Exception:  # noqa: BLE001
                pass
            client.close_socket()


if __name__ == "__main__":
    module = sys.modules[__name__]
    raise SystemExit(harness.main(module))
