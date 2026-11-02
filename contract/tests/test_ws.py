#!/usr/bin/env python3
"""WebSocket conformance: handshake, subprotocol, hello, I/O, resize, exit."""

from __future__ import annotations

import json
import sys

import harness
import httpclient as H
import wsclient
from harness import SkipTest, require, require_eq, require_in, test
from wsclient import WSClient, WSClosed


def _close_shell(client):
    try:
        client.send_json({"type": "input", "data": "exit\r"})
        client.wait_close(timeout=5)
    except Exception:  # noqa: BLE001 - cleanup must never mask the real failure
        pass
    finally:
        client.close_socket()


@test
def handshake_and_hello(cfg):
    """101 + echoed subprotocol + valid Accept + contract-shaped hello."""
    cookie = H.login_cookie(cfg)
    client = None
    try:
        client = WSClient(cfg, cookie=cookie).connect()
        require_eq(client.status, 101, "WS handshake status")
        require_eq(
            client._header("sec-websocket-protocol"),
            "ptygate.v1",
            "Sec-WebSocket-Protocol echo",
        )
        hello = client.recv_json()
        require_eq(hello.get("type"), "hello", "first server frame type")
        require_eq(hello.get("protocol"), 1, "hello.protocol")
        require_in(hello.get("impl"), ("node", "go"), "hello.impl")
        if cfg.expect_impl:
            require_eq(hello.get("impl"), cfg.expect_impl, "hello.impl (expected)")
        require_eq(hello.get("session"), cookie, "hello.session vs cookie")
        require_eq(hello.get("resumed"), False, "hello.resumed on first attach")
        require(
            isinstance(hello.get("cols"), int) and 20 <= hello["cols"] <= 500,
            f"hello.cols out of range: {hello.get('cols')!r}",
        )
        require(
            isinstance(hello.get("rows"), int) and 5 <= hello["rows"] <= 200,
            f"hello.rows out of range: {hello.get('rows')!r}",
        )
    finally:
        if client is not None:
            _close_shell(client)
        else:
            wsclient.terminate(cfg, cookie)


@test
def subprotocol_is_required(cfg):
    """Missing or wrong subprotocol is 426, never 101."""
    cookie = H.login_cookie(cfg)
    variants = [
        {"send_subprotocol": False},
        {"subprotocol": "ptygate.v2"},
        {"subprotocol": "chat"},
        {"subprotocol": ""},
    ]
    try:
        for kwargs in variants:
            status, client = wsclient.handshake_status(cfg, cookie=cookie, **kwargs)
            if client is not None:
                client.close_socket()
            require_eq(
                status, 426,
                f"handshake with {kwargs} must be 426, got {status}",
            )
    finally:
        # Even a buggy 101 must not leak a PTY into later tests.
        wsclient.terminate(cfg, cookie)


@test
def origin_must_match_host(cfg):
    """Cross-site WebSocket hijacking is a 403 pre-upgrade."""
    cookie = H.login_cookie(cfg)
    try:
        for origin in ("http://evil.example", "https://evil.example:443",
                       "null", f"http://{cfg.host_header}.evil.example"):
            status, client = wsclient.handshake_status(
                cfg, cookie=cookie, origin=origin
            )
            if client is not None:
                client.close_socket()
            require_eq(status, 403, f"Origin {origin!r} must be 403, got {status}")
    finally:
        wsclient.terminate(cfg, cookie)


@test
def missing_cookie_is_401(cfg):
    status, client = wsclient.handshake_status(cfg, cookie=None)
    if client is not None:
        client.close_socket()
    require_eq(status, 401, "WS handshake without a cookie")


@test
def invalid_cookie_is_401(cfg):
    for cookie in ("deadbeef", "0" * 64, "A" * 43):
        status, client = wsclient.handshake_status(cfg, cookie=cookie)
        if client is not None:
            client.close_socket()
        require_eq(status, 401, f"WS handshake with bogus cookie {cookie[:8]!r}")


@test
def wrong_path_is_404(cfg):
    cookie = H.login_cookie(cfg)
    try:
        status, client = wsclient.handshake_status(cfg, cookie=cookie, path="/wsx")
        if client is not None:
            client.close_socket()
        require_eq(status, 404, "WS handshake on /wsx")
    finally:
        wsclient.terminate(cfg, cookie)


@test
def input_becomes_output(cfg):
    """A JSON input frame reaches the PTY and its output comes back."""
    cookie = H.login_cookie(cfg)
    client, _hello = wsclient.attach(cfg, cookie)
    try:
        client.send_json(
            {"type": "input", "data": "printf 'PTYGATE%s\\n' _INPUT_OK\r"}
        )
        client.wait_output("PTYGATE_INPUT_OK", timeout=cfg.timeout)
    finally:
        _close_shell(client)


@test
def resize_reaches_the_pty(cfg):
    """A resize frame changes the kernel PTY size (stty size proves it)."""
    cookie = H.login_cookie(cfg)
    client, _hello = wsclient.attach(cfg, cookie)
    try:
        client.send_json({"type": "resize", "cols": 133, "rows": 44})
        client.send_json({"type": "input", "data": "stty size\r"})
        try:
            client.wait_output("44 133", timeout=cfg.timeout)
        except Exception as exc:  # noqa: BLE001
            lowered = client.output.lower()
            if "not found" in lowered or "inappropriate ioctl" in lowered:
                raise SkipTest(f"the shell cannot report its PTY size: {exc}")
            raise
    finally:
        _close_shell(client)


@test
def exit_frame_then_close_1000(cfg):
    """`exit 0` produces an exit frame with code 0, then a 1000 close."""
    cookie = H.login_cookie(cfg)
    client, _hello = wsclient.attach(cfg, cookie)
    try:
        client.send_json({"type": "input", "data": "exit 0\r"})
        exit_frame = None
        while exit_frame is None:
            msg = client.wait_json()
            if msg.get("type") == "exit":
                exit_frame = msg
        require_eq(exit_frame.get("code"), 0, "exit.code")
        require(
            isinstance(exit_frame.get("signal"), str),
            f"exit.signal must be a string, got {exit_frame.get('signal')!r}",
        )
        info = client.wait_close(timeout=cfg.timeout)
        require_eq(info.code, 1000, "close code after shell exit")
    except WSClosed as exc:
        raise harness.Failure(
            f"server closed before sending the exit frame (code={exc.code!r}, "
            f"reason={exc.reason!r})"
        )
    finally:
        client.close_socket()


@test
def exit_status_is_propagated(cfg):
    """A non-zero shell exit status is carried in exit.code."""
    cookie = H.login_cookie(cfg)
    client, _hello = wsclient.attach(cfg, cookie)
    try:
        client.send_json({"type": "input", "data": "exit 7\r"})
        exit_frame = client.wait_type("exit", timeout=cfg.timeout)
        require_eq(exit_frame.get("code"), 7, "exit.code for `exit 7`")
        client.wait_close(timeout=cfg.timeout)
    finally:
        client.close_socket()


@test
def server_answers_ping(cfg):
    """The gateway answers a client ping with a matching pong."""
    cookie = H.login_cookie(cfg)
    client, _hello = wsclient.attach(cfg, cookie)
    try:
        probe = b"ptygate-ping"
        client.send_ping(probe)
        client.wait_pong(probe, timeout=cfg.timeout)
    finally:
        _close_shell(client)


@test
def oversized_client_frame_closes_1009(cfg):
    """A client frame over 65536 bytes is rejected with close 1009."""
    cookie = H.login_cookie(cfg)
    client, _hello = wsclient.attach(cfg, cookie)
    payload = json.dumps({"type": "input", "data": "A" * 70000})
    try:
        client.send_text(payload)
        try:
            info = client.wait_close(timeout=cfg.timeout)
        except WSClosed as exc:
            raise harness.Failure(
                "oversized frame closed the TCP connection without a close "
                f"frame (raw code {exc.code!r}); expected 1009"
            )
        require_eq(info.code, 1009, "close code for a >65536-byte frame")
    finally:
        client.close_socket()
        # The PTY survives abnormal closes by design; reattach and exit it.
        wsclient.terminate(cfg, cookie)


@test
def four_pty_cap(cfg):
    """Five distinct sessions: the fifth PTY is refused with 429."""
    cookies = []
    clients = []
    try:
        for _ in range(4):
            cookie = H.login_cookie(cfg)
            cookies.append(cookie)
            client, _hello = wsclient.attach(cfg, cookie)
            clients.append(client)

        fifth = H.login_cookie(cfg)
        cookies.append(fifth)
        status, rejected = wsclient.handshake_status(cfg, cookie=fifth)
        if rejected is not None:
            rejected.close_socket()
        require_eq(status, 429, "fifth concurrent PTY must be 429")
    finally:
        for client in clients:
            _close_shell(client)


if __name__ == "__main__":
    module = sys.modules[__name__]
    raise SystemExit(harness.main(module))
