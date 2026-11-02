#!/usr/bin/env python3
"""Minimal RFC 6455 WebSocket client + raw socket helpers (stdlib only).

Implements the client half of ptygate's `/ws` handshake and framing:
  * handshake with `Sec-WebSocket-Protocol: ptygate.v1`
  * masked client frames, unmasked server frames
  * 7-bit / 16-bit / 64-bit payload lengths
  * fragmentation on receive, control frames, ping/pong, close parsing
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import socket
import ssl
import struct
import time

from harness import Failure

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
SUBPROTOCOL = "ptygate.v1"

OP_CONT = 0x0
OP_TEXT = 0x1
OP_BINARY = 0x2
OP_CLOSE = 0x8
OP_PING = 0x9
OP_PONG = 0xA


class HandshakeError(Exception):
    def __init__(self, status, reason="", headers=None):
        self.status = status
        self.reason = reason
        self.headers = headers or []
        super().__init__(f"HTTP {status} {reason}".strip())

    def header(self, name, default=None):
        low = name.lower()
        for key, value in self.headers:
            if key.lower() == low:
                return value
        return default


class WSClosed(Exception):
    """Server closed the TCP connection (possibly without a close frame)."""

    def __init__(self, code=None, reason="", initiator="server"):
        self.code = code
        self.reason = reason
        self.initiator = initiator
        super().__init__(f"websocket closed ({code!r}, {reason!r})")


class ProtocolError(Failure):
    pass


class Frame:
    __slots__ = ("fin", "opcode", "payload")

    def __init__(self, fin, opcode, payload):
        self.fin = fin
        self.opcode = opcode
        self.payload = payload

    def __repr__(self):
        return f"<Frame opcode=0x{self.opcode:x} len={len(self.payload)} fin={self.fin}>"


class CloseInfo:
    __slots__ = ("code", "reason", "how")

    def __init__(self, code, reason="", how="close-frame"):
        self.code = code
        self.reason = reason
        self.how = how

    def __repr__(self):
        return f"<Close code={self.code!r} reason={self.reason!r} how={self.how}>"


# --------------------------------------------------------------------------
# sockets / raw HTTP
# --------------------------------------------------------------------------

def _ssl_context():
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def open_socket(cfg, timeout=None, source_ip=None):
    timeout = cfg.timeout if timeout is None else timeout
    source = (source_ip, 0) if source_ip else None
    sock = socket.create_connection(
        (cfg.host, cfg.port), timeout=timeout, source_address=source
    )
    if cfg.tls:
        sock = _ssl_context().wrap_socket(sock, server_hostname=cfg.host)
    return sock


def parse_http_head(blob):
    """Parse HTTP response head. Returns (status, reason, headers)."""
    text = blob.decode("latin-1")
    lines = text.split("\r\n")
    status_line = lines[0] if lines else ""
    parts = status_line.split(" ", 2)
    try:
        status = int(parts[1])
    except (IndexError, ValueError):
        raise ConnectionError(f"bad HTTP status line: {status_line!r}")
    reason = parts[2] if len(parts) > 2 else ""
    headers = []
    for line in lines[1:]:
        if not line:
            continue
        if line[0] in " \t" and headers:  # obsolete line folding
            key, value = headers[-1]
            headers[-1] = (key, value + " " + line.strip())
            continue
        key, sep, value = line.partition(":")
        if sep:
            headers.append((key.strip(), value.strip()))
    return status, reason, headers


def _read_until_head(sock, timeout):
    deadline = time.monotonic() + timeout
    data = b""
    while b"\r\n\r\n" not in data:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("timed out reading HTTP response head")
        sock.settimeout(remaining)
        chunk = sock.recv(4096)
        if not chunk:
            raise ConnectionError("connection closed before HTTP response")
        data += chunk
        if len(data) > 65536:
            raise ConnectionError("HTTP response head larger than 64 KiB")
    head, _, rest = data.partition(b"\r\n\r\n")
    return head, rest


class RawResult:
    def __init__(self, status, reason, headers, rest, eof):
        self.status = status
        self.reason = reason
        self.headers = headers
        self.rest = rest
        self.eof = eof

    def header(self, name, default=None):
        low = name.lower()
        for key, value in self.headers:
            if key.lower() == low:
                return value
        return default


def raw_exchange(cfg, payload, timeout=None, source_ip=None):
    """Send raw bytes, read an HTTP response if one arrives, never hang."""
    timeout = cfg.timeout if timeout is None else timeout
    sock = open_socket(cfg, timeout=timeout, source_ip=source_ip)
    try:
        sock.sendall(payload)
        try:
            head, rest = _read_until_head(sock, timeout)
        except ConnectionError:
            return RawResult(None, "", [], b"", True)
        try:
            status, reason, headers = parse_http_head(head)
        except ConnectionError:
            return RawResult(None, "", [], rest, False)
        return RawResult(status, reason, headers, rest, False)
    finally:
        try:
            sock.close()
        except OSError:
            pass


# --------------------------------------------------------------------------
# WebSocket client
# --------------------------------------------------------------------------

class WSClient:
    def __init__(
        self,
        cfg,
        cookie=None,
        subprotocol=SUBPROTOCOL,
        send_subprotocol=True,
        origin="auto",
        path="/ws",
        extra_headers=None,
        source_ip=None,
        timeout=None,
    ):
        self.cfg = cfg
        self.cookie = cookie
        self.subprotocol = subprotocol
        self.send_subprotocol = send_subprotocol and subprotocol is not None
        self.origin = origin
        self.path = path
        self.extra_headers = list(extra_headers or [])
        self.source_ip = source_ip
        self.timeout = cfg.timeout if timeout is None else timeout

        self.sock = None
        self.key = None
        self.status = None
        self.headers = []
        self.buf = bytearray()
        self._msg_opcode = None
        self._msg_buf = b""
        self._close_sent = False
        self.pings_seen = []
        self.pongs_seen = []
        self.messages = []
        self.output = ""

    # -- handshake ---------------------------------------------------------

    def request_bytes(self):
        self.key = base64.b64encode(os.urandom(16)).decode("ascii")
        lines = [
            f"GET {self.path} HTTP/1.1",
            f"Host: {self.cfg.host_header}",
            "Upgrade: websocket",
            "Connection: Upgrade",
            f"Sec-WebSocket-Key: {self.key}",
            "Sec-WebSocket-Version: 13",
        ]
        if self.send_subprotocol:
            lines.append(f"Sec-WebSocket-Protocol: {self.subprotocol}")
        if self.cookie is not None:
            lines.append(f"Cookie: wt_session={self.cookie}")
        if self.origin == "auto":
            lines.append(f"Origin: {self.cfg.origin}")
        elif self.origin is not None:
            lines.append(f"Origin: {self.origin}")
        lines.extend(f"{k}: {v}" for k, v in self.extra_headers)
        return ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1")

    def connect(self):
        self.sock = open_socket(
            self.cfg, timeout=self.timeout, source_ip=self.source_ip
        )
        try:
            self.sock.sendall(self.request_bytes())
            head, rest = _read_until_head(self.sock, self.timeout)
            status, reason, headers = parse_http_head(head)
            self.status = status
            self.headers = headers
            self.buf = bytearray(rest)
            if status != 101:
                self.close_socket()
                raise HandshakeError(status, reason, headers)
            self._validate_upgrade()
            return self
        except BaseException:
            self.close_socket()
            raise

    def _header(self, name, default=None):
        low = name.lower()
        for key, value in self.headers:
            if key.lower() == low:
                return value
        return default

    def _validate_upgrade(self):
        expected = base64.b64encode(
            hashlib.sha1((self.key + GUID).encode("ascii")).digest()
        ).decode("ascii")
        accept = self._header("sec-websocket-accept")
        if accept != expected:
            raise ProtocolError(
                f"bad Sec-WebSocket-Accept: expected {expected!r}, got {accept!r}"
            )
        upgrade = (self._header("upgrade") or "").lower()
        if upgrade != "websocket":
            raise ProtocolError(f"bad Upgrade header: {upgrade!r}")
        connection = (self._header("connection") or "").lower()
        if "upgrade" not in connection:
            raise ProtocolError(f"bad Connection header: {connection!r}")
        echoed = self._header("sec-websocket-protocol")
        if self.send_subprotocol:
            if echoed != self.subprotocol:
                raise ProtocolError(
                    "server did not echo the subprotocol: "
                    f"expected {self.subprotocol!r}, got {echoed!r}"
                )
        elif echoed:
            raise ProtocolError(
                f"server echoed a subprotocol nobody offered: {echoed!r}"
            )

    # -- sending -----------------------------------------------------------

    def send_frame(self, opcode, payload=b"", fin=True):
        if isinstance(payload, str):
            payload = payload.encode("utf-8")
        length = len(payload)
        b0 = (0x80 if fin else 0x00) | (opcode & 0x0F)
        if length < 126:
            header = bytes([b0, 0x80 | length])
        elif length < 65536:
            header = bytes([b0, 0x80 | 126]) + struct.pack("!H", length)
        else:
            header = bytes([b0, 0x80 | 127]) + struct.pack("!Q", length)
        mask = os.urandom(4)
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        self.sock.sendall(header + mask + masked)

    def send_text(self, text):
        self.send_frame(OP_TEXT, text.encode("utf-8"))

    def send_json(self, obj):
        self.send_text(json.dumps(obj, separators=(",", ":")))

    def send_ping(self, payload=b""):
        if isinstance(payload, str):
            payload = payload.encode("utf-8")
        if len(payload) > 125:
            raise ValueError("ping payload too long")
        self.send_frame(OP_PING, payload)

    def send_pong(self, payload=b""):
        self.send_frame(OP_PONG, payload)

    def send_close(self, code=1000, reason=""):
        payload = struct.pack("!H", code) + reason.encode("utf-8")
        self.send_frame(OP_CLOSE, payload)
        self._close_sent = True

    # -- receiving ---------------------------------------------------------

    def _recv_exact(self, count, deadline):
        while len(self.buf) < count:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(
                    f"timed out waiting for {count} frame bytes"
                )
            self.sock.settimeout(remaining)
            try:
                chunk = self.sock.recv(max(4096, count - len(self.buf)))
            except socket.timeout:
                raise TimeoutError(
                    f"timed out waiting for {count} frame bytes"
                )
            if not chunk:
                raise WSClosed(None, "tcp-eof")
            self.buf.extend(chunk)
        out = bytes(self.buf[:count])
        del self.buf[:count]
        return out

    def recv_frame(self, timeout=None):
        timeout = self.timeout if timeout is None else timeout
        deadline = time.monotonic() + timeout
        first, second = self._recv_exact(2, deadline)
        fin = bool(first & 0x80)
        opcode = first & 0x0F
        masked = bool(second & 0x80)
        length = second & 0x7F
        if length == 126:
            length = struct.unpack("!H", self._recv_exact(2, deadline))[0]
        elif length == 127:
            length = struct.unpack("!Q", self._recv_exact(8, deadline))[0]
        if masked:
            raise ProtocolError("server sent a masked frame (RFC 6455 forbids it)")
        if opcode >= 0x8 and (length > 125 or not fin):
            raise ProtocolError("invalid control frame (fragmented or >125 bytes)")
        payload = self._recv_exact(length, deadline) if length else b""
        return Frame(fin, opcode, payload)

    def recv_message(self, timeout=None):
        """Return a complete data Frame, or a close Frame."""
        timeout = self.timeout if timeout is None else timeout
        deadline = time.monotonic() + timeout
        while True:
            remaining = max(0.001, deadline - time.monotonic())
            frame = self.recv_frame(timeout=remaining)
            if frame.opcode == OP_PING:
                self.pings_seen.append(frame.payload)
                self.send_pong(frame.payload)
                continue
            if frame.opcode == OP_PONG:
                self.pongs_seen.append(frame.payload)
                continue
            if frame.opcode == OP_CLOSE:
                return frame
            if frame.opcode in (OP_TEXT, OP_BINARY):
                if self._msg_opcode is not None:
                    raise ProtocolError("new data frame inside a fragmented message")
                self._msg_opcode = frame.opcode
                self._msg_buf = frame.payload
            elif frame.opcode == OP_CONT:
                if self._msg_opcode is None:
                    raise ProtocolError("continuation frame without a start frame")
                self._msg_buf += frame.payload
            else:
                raise ProtocolError(f"unexpected opcode 0x{frame.opcode:x}")
            if frame.fin:
                opcode = self._msg_opcode
                payload = self._msg_buf
                self._msg_opcode = None
                self._msg_buf = b""
                return Frame(True, opcode, payload)

    @staticmethod
    def parse_close(frame):
        payload = frame.payload
        if len(payload) >= 2:
            code = struct.unpack("!H", payload[:2])[0]
            reason = payload[2:].decode("utf-8", "replace")
        else:
            code, reason = None, ""
        return CloseInfo(code, reason, "close-frame")

    def recv_json(self, timeout=None):
        timeout = self.timeout if timeout is None else timeout
        deadline = time.monotonic() + timeout
        while True:
            remaining = max(0.001, deadline - time.monotonic())
            frame = self.recv_message(timeout=remaining)
            if frame.opcode == OP_CLOSE:
                info = self.parse_close(frame)
                if not self._close_sent:
                    try:
                        self.send_close(info.code or 1000, info.reason)
                    except OSError:
                        pass
                raise WSClosed(info.code, info.reason)
            if frame.opcode != OP_TEXT:
                raise ProtocolError(
                    f"expected a JSON text frame, got opcode 0x{frame.opcode:x}"
                )
            try:
                return json.loads(frame.payload.decode("utf-8"))
            except Exception as exc:  # noqa: BLE001
                raise ProtocolError(
                    f"server sent invalid JSON text: {exc}: "
                    f"{frame.payload[:120]!r}"
                )

    def wait_json(self, predicate=None, timeout=None):
        """Return the next JSON message matching predicate (default: any)."""
        timeout = self.timeout if timeout is None else timeout
        deadline = time.monotonic() + timeout
        while True:
            remaining = max(0.001, deadline - time.monotonic())
            msg = self.recv_json(timeout=remaining)
            if predicate is None or predicate(msg):
                return msg
            self.messages.append(msg)

    def wait_type(self, msg_type, timeout=None):
        return self.wait_json(lambda m: m.get("type") == msg_type, timeout=timeout)

    def wait_output(self, needle, timeout=None):
        """Consume messages until `needle` appears in accumulated output."""
        timeout = self.timeout if timeout is None else timeout
        deadline = time.monotonic() + timeout
        while True:
            remaining = max(0.001, deadline - time.monotonic())
            try:
                msg = self.wait_json(timeout=remaining)
            except TimeoutError:
                raise Failure(
                    f"output never contained {needle!r}; tail={self.output[-400:]!r}"
                )
            kind = msg.get("type")
            if kind == "output":
                self.output += str(msg.get("data", ""))
                if needle in self.output:
                    return self.output
            elif kind == "exit":
                raise Failure(
                    f"shell exited before {needle!r} appeared; "
                    f"tail={self.output[-400:]!r} exit={msg!r}"
                )
            elif kind == "error":
                continue
            else:
                self.messages.append(msg)

    def wait_pong(self, payload=b"", timeout=None):
        """Wait for a pong with the given payload; answer pings meanwhile."""
        timeout = self.timeout if timeout is None else timeout
        deadline = time.monotonic() + timeout
        while True:
            remaining = max(0.001, deadline - time.monotonic())
            frame = self.recv_frame(timeout=remaining)
            if frame.opcode == OP_PONG:
                self.pongs_seen.append(frame.payload)
                if frame.payload == payload:
                    return frame
            elif frame.opcode == OP_PING:
                self.pings_seen.append(frame.payload)
                self.send_pong(frame.payload)
            elif frame.opcode == OP_CLOSE:
                info = self.parse_close(frame)
                raise WSClosed(info.code, info.reason)

    def wait_close(self, timeout=None):
        """Wait for the server's close frame (or EOF). Does not raise on close."""
        timeout = self.timeout if timeout is None else timeout
        deadline = time.monotonic() + timeout
        while True:
            remaining = max(0.001, deadline - time.monotonic())
            try:
                frame = self.recv_message(timeout=remaining)
            except WSClosed:
                raise
            except TimeoutError:
                raise Failure(f"server did not close within {timeout:g}s")
            if frame.opcode != OP_CLOSE:
                continue
            info = self.parse_close(frame)
            if not self._close_sent:
                try:
                    self.send_close(info.code or 1000, info.reason)
                except OSError:
                    pass
            self.close_socket()
            return info

    def close_and_wait(self, code=1000, reason="", timeout=3.0):
        if not self._close_sent:
            try:
                self.send_close(code, reason)
            except OSError:
                pass
        try:
            return self.wait_close(timeout=timeout)
        except (WSClosed, Failure, OSError, TimeoutError):
            return None
        finally:
            self.close_socket()

    def close_socket(self):
        sock = self.sock
        self.sock = None
        if sock is None:
            return
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            sock.close()
        except OSError:
            pass

    def __enter__(self):
        return self.connect()

    def __exit__(self, *exc):
        self.close_socket()
        return False


# --------------------------------------------------------------------------
# helpers used by several modules
# --------------------------------------------------------------------------

def handshake_status(cfg, **kwargs):
    """Try a handshake; return (status, client_or_None). Never raises on HTTP."""
    client = WSClient(cfg, **kwargs)
    try:
        client.connect()
        return 101, client
    except HandshakeError as exc:
        return exc.status, None


def attach(cfg, cookie):
    """Connect, return (client, hello). Raises Failure with a useful message."""
    client = WSClient(cfg, cookie=cookie)
    try:
        client.connect()
    except HandshakeError as exc:
        raise Failure(
            f"WS upgrade with a valid session failed: HTTP {exc.status} "
            f"{exc.reason}"
        )
    try:
        hello = client.recv_json()
    except Exception:
        client.close_socket()
        raise
    if hello.get("type") != "hello":
        client.close_socket()
        raise Failure(f"first server frame was {hello.get('type')!r}, not 'hello'")
    return client, hello


def terminate(cfg, cookie, timeout=6.0):
    """Best-effort: reattach to a session and make its shell exit.

    Conformance tests must leave zero PTYs behind, otherwise the 4-PTY cap
    leaks into later tests. Swallows every error.
    """
    client = None
    try:
        client, hello = attach(cfg, cookie)
        if not hello.get("resumed"):
            # Freshly spawned or already exited; either way exit it.
            pass
        client.send_json({"type": "input", "data": "exit\r"})
        client.wait_close(timeout=timeout)
    except Exception:  # noqa: BLE001
        pass
    finally:
        if client is not None:
            client.close_socket()
