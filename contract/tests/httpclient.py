#!/usr/bin/env python3
"""Minimal HTTP client helpers (Python 3 stdlib only).

Used by the conformance suite. Deliberately dumb: no redirect following, no
cookie jar, no retries. Tests assert exact status codes and headers.
"""

from __future__ import annotations

import http.client
import json
import ssl
from urllib.parse import urlencode

from harness import Failure, require


class Response:
    def __init__(self, method, path, status, reason, headers, body):
        self.method = method
        self.path = path
        self.status = status
        self.reason = reason
        self.headers = headers  # list[(name, value)] preserving order
        self.body = body

    def header(self, name, default=None):
        low = name.lower()
        for key, value in self.headers:
            if key.lower() == low:
                return value
        return default

    def header_all(self, name):
        low = name.lower()
        return [value for key, value in self.headers if key.lower() == low]

    @property
    def set_cookies(self):
        return self.header_all("set-cookie")

    @property
    def text(self):
        return self.body.decode("utf-8", "replace")

    def json(self):
        try:
            return json.loads(self.body.decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            raise Failure(
                f"{self.method} {self.path}: body is not JSON ({exc}): "
                f"{self.text[:200]!r}"
            )

    def __repr__(self):
        return f"<Response {self.method} {self.path} {self.status}>"


def _ssl_context():
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def _connection(cfg, source_ip=None, timeout=None):
    source = (source_ip, 0) if source_ip else None
    timeout = cfg.timeout if timeout is None else timeout
    if cfg.tls:
        return http.client.HTTPSConnection(
            cfg.host, cfg.port, timeout=timeout,
            context=_ssl_context(), source_address=source,
        )
    return http.client.HTTPConnection(
        cfg.host, cfg.port, timeout=timeout, source_address=source,
    )


def request(cfg, method, path, headers=None, body=None, source_ip=None,
            timeout=None):
    conn = _connection(cfg, source_ip=source_ip, timeout=timeout)
    hdrs = {
        "User-Agent": "ptygate-conformance/1",
        "Accept": "*/*",
        "Connection": "close",
    }
    if headers:
        hdrs.update(headers)
    try:
        conn.request(method, path, body=body, headers=hdrs)
        raw = conn.getresponse()
        data = raw.read()
        resp = Response(method, path, raw.status, raw.reason,
                        raw.getheaders(), data)
    finally:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass
    return resp


def get(cfg, path, headers=None, source_ip=None, timeout=None):
    return request(cfg, "GET", path, headers=headers, source_ip=source_ip,
                   timeout=timeout)


def post_form(cfg, path, fields, source_ip=None, timeout=None):
    body = urlencode(fields).encode("utf-8")
    headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": str(len(body)),
    }
    return request(cfg, "POST", path, headers=headers, body=body,
                   source_ip=source_ip, timeout=timeout)


def get_json(cfg, path, **kwargs):
    resp = get(cfg, path, **kwargs)
    require(resp.status == 200, f"GET {path}: expected 200, got {resp.status}")
    return resp.json()


# --------------------------------------------------------------------------
# cookies and login
# --------------------------------------------------------------------------

def parse_set_cookie(value):
    """Return (name, cookie_value, attributes) from one Set-Cookie header."""
    parts = [p.strip() for p in value.split(";")]
    first = parts[0] if parts else ""
    name, _, cookie_value = first.partition("=")
    attrs = {}
    flags = set()
    for part in parts[1:]:
        if not part:
            continue
        key, sep, val = part.partition("=")
        key_low = key.strip().lower()
        if sep:
            attrs[key_low] = val.strip()
        else:
            flags.add(key_low)
    return name.strip(), cookie_value.strip(), {"attrs": attrs, "flags": flags}


def session_cookie_from(response):
    """Find the wt_session Set-Cookie and return (value, parsed)."""
    for header in response.set_cookies:
        name, value, parsed = parse_set_cookie(header)
        if name == "wt_session":
            return value, parsed
    raise Failure(
        f"{response.method} {response.path}: no wt_session Set-Cookie "
        f"(status {response.status})"
    )


def cookie_header(cookie):
    return f"wt_session={cookie}"


def login(cfg, token=None, source_ip=None):
    """POST /login. Returns (Response, cookie_value_or_None)."""
    token = cfg.token if token is None else token
    resp = post_form(cfg, "/login", {"token": token}, source_ip=source_ip)
    cookie = None
    for header in resp.set_cookies:
        name, value, _ = parse_set_cookie(header)
        if name == "wt_session" and value:
            cookie = value
    return resp, cookie


def login_cookie(cfg, source_ip=None):
    """POST /login and require a 303 + cookie; return the cookie value."""
    resp, cookie = login(cfg, source_ip=source_ip)
    if resp.status != 303:
        raise Failure(
            f"POST /login with the correct token: expected 303, got "
            f"{resp.status}"
        )
    if not cookie:
        raise Failure("POST /login succeeded but set no wt_session cookie")
    return cookie


def logout(cfg, cookie=None, source_ip=None):
    headers = {}
    if cookie:
        headers["Cookie"] = cookie_header(cookie)
    return get(cfg, "/logout", headers=headers, source_ip=source_ip)


def version(cfg):
    return get_json(cfg, "/version")


def ssh_enabled(cfg):
    try:
        data = version(cfg)
    except Failure:
        return False
    transports = data.get("transports")
    return isinstance(transports, dict) and transports.get("ssh") is True
