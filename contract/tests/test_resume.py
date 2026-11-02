#!/usr/bin/env python3
"""Session and resume conformance: detach, replay, replace, bounds."""

from __future__ import annotations

import sys
import time

import harness
import httpclient as H
import wsclient
from harness import SkipTest, require, require_eq, test
from wsclient import WSClient


def _detach(client):
    client.send_json({"type": "detach"})
    info = client.wait_close(timeout=10)
    client.close_socket()
    return info


@test
def detach_keeps_the_pty_and_replays(cfg):
    """detach -> close 1000 'detached' -> reattach resumed=true + replay."""
    cookie = H.login_cookie(cfg)
    ws2 = None
    try:
        client, hello = wsclient.attach(cfg, cookie)
        require_eq(hello.get("resumed"), False, "first attach resumed")
        client.send_json(
            {"type": "input", "data": "printf 'RESUME%s\\n' _MARKER\r"}
        )
        client.wait_output("RESUME_MARKER", timeout=cfg.timeout)

        info = _detach(client)
        require_eq(info.code, 1000, "detach close code")
        require_eq(info.reason, "detached", "detach close reason")

        ws2, hello2 = wsclient.attach(cfg, cookie)
        require_eq(hello2.get("resumed"), True, "resumed after detach")
        require_eq(hello2.get("session"), cookie, "resumed session id")
        # No input has been sent on ws2: this can only come from the replay.
        ws2.wait_output("RESUME_MARKER", timeout=cfg.timeout)

        ws2.send_json({"type": "input", "data": "printf 'LIVE%s\\n' _OK\r"})
        ws2.wait_output("LIVE_OK", timeout=cfg.timeout)
    finally:
        if ws2 is not None:
            try:
                ws2.send_json({"type": "input", "data": "exit\r"})
                ws2.wait_close(timeout=5)
            except Exception:  # noqa: BLE001
                pass
            ws2.close_socket()
        else:
            wsclient.terminate(cfg, cookie)


@test
def output_while_detached_is_buffered(cfg):
    """The PTY keeps running during grace; new output appears in replay."""
    cookie = H.login_cookie(cfg)
    ws2 = None
    try:
        client, _hello = wsclient.attach(cfg, cookie)
        client.send_json(
            {
                "type": "input",
                "data": "(sleep 1; printf 'DETACHED%s\\n' _OUT) &\r",
            }
        )
        time.sleep(0.2)
        _detach(client)
        time.sleep(2.0)
        ws2, hello2 = wsclient.attach(cfg, cookie)
        require_eq(hello2.get("resumed"), True, "resumed after detached output")
        ws2.wait_output("DETACHED_OUT", timeout=cfg.timeout)
    finally:
        if ws2 is not None:
            try:
                ws2.send_json({"type": "input", "data": "exit\r"})
                ws2.wait_close(timeout=5)
            except Exception:  # noqa: BLE001
                pass
            ws2.close_socket()
        else:
            wsclient.terminate(cfg, cookie)


@test
def second_connection_replaces_the_first(cfg):
    """Same cookie: new socket wins, old socket gets 4000 'detached'."""
    cookie = H.login_cookie(cfg)
    first = second = None
    try:
        first, hello1 = wsclient.attach(cfg, cookie)
        require_eq(hello1.get("resumed"), False, "first attach resumed")

        second = WSClient(cfg, cookie=cookie).connect()
        hello2 = second.recv_json()
        require_eq(hello2.get("type"), "hello", "second connection hello")
        require_eq(hello2.get("resumed"), True, "replacement reports resumed=true")

        info = first.wait_close(timeout=cfg.timeout)
        require_eq(info.code, 4000, "replaced socket close code")
        require_eq(info.reason, "detached", "replaced socket close reason")
        first.close_socket()
        first = None

        second.send_json({"type": "input", "data": "printf 'WIN%s\\n' _NER\r"})
        second.wait_output("WIN_NER", timeout=cfg.timeout)
    finally:
        if first is not None:
            first.close_socket()
        if second is not None:
            try:
                second.send_json({"type": "input", "data": "exit\r"})
                second.wait_close(timeout=5)
            except Exception:  # noqa: BLE001
                pass
            second.close_socket()


@test
def replay_is_bounded_to_262144_bytes(cfg):
    """A large scrollback is truncated to the last 262144 bytes."""
    cookie = H.login_cookie(cfg)
    client = None
    ws2 = None
    try:
        client, _hello = wsclient.attach(cfg, cookie)
        command = (
            "printf 'BEGIN%s\\n' _TRUNC; "
            "head -c 300000 /dev/zero | tr '\\000' 'A'; "
            "printf '\\nEND%s\\n' _TRUNC\r"
        )
        client.send_json({"type": "input", "data": command})
        client.wait_output("END_TRUNC", timeout=30)
        require(
            len(client.output.encode("utf-8", "ignore")) >= 270000,
            "the shell produced too little output to exercise the ring buffer",
        )
        info = _detach(client)
        client = None
        require_eq(info.code, 1000, "detach close code")

        ws2, hello2 = wsclient.attach(cfg, cookie)
        require_eq(hello2.get("resumed"), True, "resumed for truncation test")

        replay = ""
        deadline = time.monotonic() + 1.5
        while time.monotonic() < deadline:
            try:
                msg = ws2.recv_json(timeout=max(0.01, deadline - time.monotonic()))
            except TimeoutError:
                break
            if msg.get("type") == "output":
                replay += str(msg.get("data", ""))
            elif msg.get("type") == "exit":
                break
        size = len(replay.encode("utf-8", "ignore"))
        require(
            "END_TRUNC" in replay,
            "the replay must include the most recent output (END_TRUNC missing)",
        )
        require(
            "BEGIN_TRUNC" not in replay,
            "the replay was not truncated: 300 KB of scrollback was replayed",
        )
        # +4 KiB slack for a prompt/live bytes that may follow the replay.
        require(
            size <= 262144 + 4096,
            f"replay was {size} bytes, over the 262144-byte bound",
        )
    finally:
        if client is not None:
            client.close_socket()
        if ws2 is not None:
            try:
                ws2.send_json({"type": "input", "data": "exit\r"})
                ws2.wait_close(timeout=5)
            except Exception:  # noqa: BLE001
                pass
            ws2.close_socket()
        else:
            wsclient.terminate(cfg, cookie)


@test
def attach_after_shell_exit_spawns_a_new_pty(cfg):
    """Exit destroys the PTY; the cookie stays valid and resumed=false returns."""
    cookie = H.login_cookie(cfg)
    client, _hello = wsclient.attach(cfg, cookie)
    client.send_json({"type": "input", "data": "exit 0\r"})
    client.wait_type("exit", timeout=cfg.timeout)
    client.wait_close(timeout=cfg.timeout)
    client.close_socket()

    again = None
    try:
        again, hello2 = wsclient.attach(cfg, cookie)
        require_eq(hello2.get("resumed"), False,
                   "a new PTY after shell exit must report resumed=false")
    finally:
        if again is not None:
            again.send_json({"type": "input", "data": "exit\r"})
            try:
                again.wait_close(timeout=5)
            except Exception:  # noqa: BLE001
                pass
            again.close_socket()


@test
def grace_expiry_destroys_the_pty(cfg):
    """After RESUME_GRACE_MS, the next attach is a brand-new PTY."""
    if not cfg.slow:
        raise SkipTest("requires --slow and --grace-ms")
    if cfg.grace_ms is None:
        raise SkipTest("requires --grace-ms <server RESUME_GRACE_MS>")
    if cfg.grace_ms > 60000:
        raise SkipTest(
            f"grace is {cfg.grace_ms} ms; start the server with a shorter "
            "RESUME_GRACE_MS to run this test"
        )
    cookie = H.login_cookie(cfg)
    client, _hello = wsclient.attach(cfg, cookie)
    info = _detach(client)
    require_eq(info.code, 1000, "detach close code")
    time.sleep((cfg.grace_ms / 1000.0) + 2.5)

    again = None
    try:
        again, hello2 = wsclient.attach(cfg, cookie)
        require_eq(hello2.get("resumed"), False,
                   "PTY must be gone after grace expiry")
    finally:
        if again is not None:
            again.send_json({"type": "input", "data": "exit\r"})
            try:
                again.wait_close(timeout=5)
            except Exception:  # noqa: BLE001
                pass
            again.close_socket()


if __name__ == "__main__":
    module = sys.modules[__name__]
    raise SystemExit(harness.main(module))
