#!/usr/bin/env python3
"""HTTP surface conformance: endpoints, status codes, headers, cookies."""

from __future__ import annotations

import os
import sys
import time
from urllib.parse import urlsplit

import harness
import httpclient as H
from harness import SkipTest, require, require_eq, require_in, test


def _location_path(resp):
    loc = resp.header("location")
    if loc is None:
        return None
    parts = urlsplit(loc)
    return parts.path or "/"


def _require_no_store(resp, what):
    cache = (resp.header("cache-control") or "").lower()
    require(
        "no-store" in cache,
        f"{what}: HTML must send Cache-Control: no-store, got {cache!r}",
    )


@test
def healthz_ok(cfg):
    """GET /healthz is 200 text/plain 'ok' with no authentication."""
    resp = H.get(cfg, "/healthz")
    require_eq(resp.status, 200, "GET /healthz status")
    ctype = (resp.header("content-type") or "").lower()
    require(
        ctype.startswith("text/plain"),
        f"GET /healthz Content-Type: expected text/plain, got {ctype!r}",
    )
    require_eq(resp.text.strip(), "ok", "GET /healthz body")


@test
def healthz_over_raw_socket(cfg):
    """The one-port multiplexer routes a plain GET to HTTP."""
    request = (
        b"GET /healthz HTTP/1.1\r\n"
        b"Host: " + cfg.host_header.encode("latin-1") + b"\r\n"
        b"Connection: close\r\n\r\n"
    )
    import wsclient

    result = wsclient.raw_exchange(cfg, request, timeout=cfg.timeout)
    require_eq(result.status, 200, "raw GET /healthz status")
    require(
        b"ok" in result.rest.lower(),
        f"raw GET /healthz body missing 'ok': {result.rest[:120]!r}",
    )


@test
def version_shape(cfg):
    """GET /version returns the exact protocol/version document."""
    resp = H.get(cfg, "/version")
    require_eq(resp.status, 200, "GET /version status")
    ctype = (resp.header("content-type") or "").lower()
    require(
        ctype.startswith("application/json"),
        f"GET /version Content-Type: expected application/json, got {ctype!r}",
    )
    data = resp.json()
    require_eq(data.get("name"), "ptygate", "/version name")
    require_eq(data.get("protocol"), 1, "/version protocol")
    require_eq(data.get("version"), "0.1.0", "/version version")
    require_in(data.get("impl"), ("node", "go"), "/version impl")
    if cfg.expect_impl:
        require_eq(data.get("impl"), cfg.expect_impl, "/version impl (expected)")

    transports = data.get("transports")
    require(isinstance(transports, dict), "/version transports must be an object")
    require_eq(transports.get("http"), True, "/version transports.http")
    require(
        isinstance(transports.get("tls"), bool),
        f"/version transports.tls must be bool, got {transports.get('tls')!r}",
    )
    require(
        isinstance(transports.get("ssh"), bool),
        f"/version transports.ssh must be bool, got {transports.get('ssh')!r}",
    )
    if cfg.tls:
        require_eq(transports.get("tls"), True,
                   "/version transports.tls when the suite is on TLS")

    require_in(data.get("ip_mode"), ("allowlist", "any"), "/version ip_mode")
    if cfg.expect_ip_mode:
        require_eq(data.get("ip_mode"), cfg.expect_ip_mode,
                   "/version ip_mode (expected)")

    blob = resp.text.lower()
    for secret_key in ("token", "authorized_keys", "ssh_host", "data_dir"):
        require(
            secret_key not in blob,
            f"/version must not expose {secret_key!r}",
        )


@test
def root_redirects_without_session(cfg):
    """GET / without a session is a 302 to /login."""
    resp = H.get(cfg, "/")
    require_eq(resp.status, 302, "GET / without a session status")
    require_eq(_location_path(resp), "/login", "GET / Location")


@test
def login_page_is_public_html(cfg):
    """GET /login is public HTML and is not cached."""
    resp = H.get(cfg, "/login")
    require_eq(resp.status, 200, "GET /login status")
    ctype = (resp.header("content-type") or "").lower()
    require("text/html" in ctype, f"GET /login Content-Type: {ctype!r}")
    _require_no_store(resp, "GET /login")
    require(len(resp.body) > 0, "GET /login returned an empty body")


@test
def login_sets_contract_cookie(cfg):
    """POST /login (valid token) is a 303 with the full cookie contract."""
    resp, cookie = H.login(cfg)
    require_eq(resp.status, 303, "POST /login with a valid token")
    require_eq(_location_path(resp), "/", "POST /login Location")
    require(cookie, "POST /login did not set wt_session")

    name, value, parsed = H.parse_set_cookie(
        next(h for h in resp.set_cookies if h.lower().startswith("wt_session="))
    )
    require_eq(name, "wt_session", "Set-Cookie name")
    require_eq(value, cookie, "Set-Cookie value")
    require(
        len(value) >= 32,
        f"session id must be at least 32 chars, got {len(value)}",
    )
    require(
        not any(ch in value for ch in ";,\r\n\t "),
        f"session id contains an illegal character: {value!r}",
    )

    attrs = parsed["attrs"]
    flags = parsed["flags"]
    require_eq(attrs.get("path"), "/", "cookie Path")
    require_eq(attrs.get("max-age"), "43200", "cookie Max-Age")
    require_eq(attrs.get("samesite", "").lower(), "strict", "cookie SameSite")
    require("httponly" in flags, "cookie must be HttpOnly")
    if cfg.tls:
        require("secure" in flags, "cookie must be Secure over TLS")
    else:
        require(
            "secure" not in flags,
            "cookie must not be Secure when the login request was plain HTTP",
        )

    # A session id is opaque: cleanup should not depend on this test.
    import wsclient

    wsclient.terminate(cfg, cookie)


@test
def session_cookie_is_reusable(cfg):
    """The cookie from POST /login authenticates GET /."""
    cookie = H.login_cookie(cfg)
    try:
        resp = H.get(cfg, "/", headers={"Cookie": H.cookie_header(cookie)})
        require_eq(resp.status, 200, "GET / with a valid session")
        ctype = (resp.header("content-type") or "").lower()
        require("text/html" in ctype, f"GET / Content-Type: {ctype!r}")
        _require_no_store(resp, "GET /")
        require(b"<" in resp.body, "GET / returned an empty-looking HTML body")
    finally:
        import wsclient

        wsclient.terminate(cfg, cookie)


@test
def session_ids_are_unique(cfg):
    """Two logins produce different session ids."""
    first = H.login_cookie(cfg)
    second = H.login_cookie(cfg)
    try:
        require(first != second, "two logins returned the same session id")
    finally:
        import wsclient

        wsclient.terminate(cfg, first)
        wsclient.terminate(cfg, second)


@test
def assets_are_not_auth_gated(cfg):
    """GET /assets/* must not redirect to /login."""
    path = f"/assets/definitely-not-here-{os.urandom(6).hex()}.txt"
    resp = H.get(cfg, path)
    require_in(resp.status, (200, 404), f"GET {path} status")
    require(
        _location_path(resp) != "/login",
        f"GET {path} must not redirect to /login",
    )


@test
def unknown_path_is_404(cfg):
    resp = H.get(cfg, f"/no-such-route-{os.urandom(6).hex()}")
    require_eq(resp.status, 404, "unknown path status")


@test
def tls_certificate_shape(cfg):
    """When TLS is on, the cert is self-signed and covers localhost + ::1."""
    if not cfg.tls:
        raise SkipTest("run with --base https://... to exercise TLS")
    import socket as socketmod
    import ssl
    import tempfile

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    raw = socketmod.create_connection((cfg.host, cfg.port), timeout=cfg.timeout)
    tls = ctx.wrap_socket(raw, server_hostname=cfg.host)
    try:
        der = tls.getpeercert(binary_form=True)
    finally:
        tls.close()
    require(der, "TLS handshake returned no peer certificate")

    pem = ssl.DER_cert_to_PEM_cert(der)
    decode = getattr(getattr(ssl, "_ssl", None), "_test_decode_cert", None)
    if decode is None:
        raise SkipTest("this Python has no stdlib X.509 decoder")
    handle, path = tempfile.mkstemp(suffix=".pem", prefix="ptygate-cert-")
    try:
        os.write(handle, pem.encode("ascii"))
        os.close(handle)
        decoded = decode(path)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass

    require_eq(decoded.get("subject"), decoded.get("issuer"),
               "TLS certificate must be self-signed")
    sans = decoded.get("subjectAltName") or ()
    dns = {value for kind, value in sans if kind == "DNS"}
    ips = {value for kind, value in sans if kind == "IP Address"}
    require("localhost" in dns, f"cert SANs missing DNS:localhost: {sans!r}")
    require("127.0.0.1" in ips, f"cert SANs missing IP:127.0.0.1: {sans!r}")
    require("::1" in ips, f"cert SANs missing IP:::1: {sans!r}")

    expires = ssl.cert_time_to_seconds(decoded["notAfter"])
    require(expires > time.time(),
            f"TLS certificate expired on {decoded.get('notAfter')}")


if __name__ == "__main__":
    module = sys.modules[__name__]
    raise SystemExit(harness.main(module))
