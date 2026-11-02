#!/usr/bin/env python3
"""Authentication conformance: token matching, cookie reuse, logout, lockout."""

from __future__ import annotations

import os
import random
import sys

import harness
import httpclient as H
import wsclient
from harness import SkipTest, require, require_eq, require_in, test


@test
def correct_token_is_303(cfg):
    resp, cookie = H.login(cfg)
    require_eq(resp.status, 303, "POST /login with the correct token")
    require_eq(resp.header("location"), "/", "Location after login")
    require(cookie, "successful login did not set wt_session")
    wsclient.terminate(cfg, cookie)


@test
def wrong_token_is_401(cfg):
    wrong = "x" * max(16, len(cfg.token)) + "nope"
    resp, cookie = H.login(cfg, token=wrong)
    require_eq(resp.status, 401, "POST /login with a wrong token")
    require(cookie is None, "failed login must not set wt_session")
    require(
        cfg.token not in resp.text,
        "failed login response echoed the real token",
    )
    for value in resp.header_all("set-cookie"):
        require(
            "wt_session=" not in value or "Max-Age=0" in value,
            "failed login must not hand out a live session cookie",
        )


@test
def short_wrong_token_is_401(cfg):
    """Length mismatches take the same 401 path (no crash, no early success)."""
    resp, cookie = H.login(cfg, token="abc")
    require_eq(resp.status, 401, "POST /login with a 3-char token")
    require(cookie is None, "short token produced a cookie")


@test
def missing_token_field_is_401(cfg):
    resp = H.post_form(cfg, "/login", {})
    require_eq(resp.status, 401, "POST /login without a token field")


@test
def token_is_not_trimmed_or_case_folded(cfg):
    resp, cookie = H.login(cfg, token=" " + cfg.token)
    require_eq(resp.status, 401, "token with leading whitespace")
    require(cookie is None, "whitespace-padded token produced a cookie")

    resp, cookie = H.login(cfg, token=cfg.token.upper())
    if cfg.token.upper() != cfg.token:
        require_eq(resp.status, 401, "uppercased token")
        require(cookie is None, "uppercased token produced a cookie")


@test
def cookie_reuse_and_logout(cfg):
    """A cookie authenticates; GET /logout clears it and 303s to /login."""
    cookie = H.login_cookie(cfg)
    authed = H.get(cfg, "/", headers={"Cookie": H.cookie_header(cookie)})
    require_eq(authed.status, 200, "GET / with a fresh cookie")

    resp = H.logout(cfg, cookie=cookie)
    require_eq(resp.status, 303, "GET /logout status")
    require_eq(resp.header("location"), "/login", "GET /logout Location")
    cleared = [h for h in resp.set_cookies if h.lower().startswith("wt_session=")]
    require(cleared, "GET /logout did not send a wt_session Set-Cookie")
    parsed = H.parse_set_cookie(cleared[0])
    require_eq(parsed[2]["attrs"].get("max-age"), "0",
               "logout cookie Max-Age must be 0")
    require_eq(parsed[1], "", "logout cookie value must be empty")

    after = H.get(cfg, "/", headers={"Cookie": H.cookie_header(cookie)})
    require_eq(after.status, 302, "GET / with a logged-out cookie")
    from urllib.parse import urlsplit

    require_eq(
        urlsplit(after.header("location") or "").path,
        "/login",
        "GET / after logout Location",
    )


@test
def logout_without_cookie_is_idempotent(cfg):
    resp = H.get(cfg, "/logout")
    require_eq(resp.status, 303, "GET /logout without a cookie")


@test
def logout_kills_a_detached_pty(cfg):
    """After logout the old cookie is dead and its detached PTY is gone."""
    cookie = H.login_cookie(cfg)
    client, hello = wsclient.attach(cfg, cookie)
    require_eq(hello.get("resumed"), False, "first attach resumed flag")
    client.send_json({"type": "detach"})
    client.wait_close(timeout=cfg.timeout)
    client.close_socket()

    out = H.logout(cfg, cookie=cookie)
    require_eq(out.status, 303, "GET /logout for a detached session")

    status, reattached = wsclient.handshake_status(cfg, cookie=cookie)
    if reattached is not None:
        reattached.close_socket()
    require_eq(status, 401, "logged-out cookie must not open a WebSocket")


@test
def lockout_after_ten_failures(cfg):
    """10 bad logins lock that IP out for 15 minutes (429), other IPs unaffected."""
    source = cfg.source_ip
    if source in ("127.0.0.1", "::1"):
        # Use a throwaway loopback source so a stale 15-minute lockout from a
        # previous suite run cannot make this test vacuous.
        source = f"127.0.0.{random.randint(100, 250)}"

    wrong = "not-" + os.urandom(12).hex()
    statuses = []
    try:
        for _ in range(12):
            resp, cookie = H.login(cfg, token=wrong, source_ip=source)
            statuses.append(resp.status)
            if resp.status == 429:
                break
        else:
            resp = None
    except OSError as exc:
        raise SkipTest(
            f"cannot bind source address {source} to exercise per-IP lockout: {exc}"
        )

    require(
        429 in statuses,
        "10 failed logins did not produce a 429; saw " + repr(statuses),
    )
    require_eq(statuses[-1], 429, "final failed login status")

    # Even the correct token is rejected while locked.
    resp, cookie = H.login(cfg, token=cfg.token, source_ip=source)
    require_eq(resp.status, 429, "correct token from a locked-out IP")
    require(cookie is None, "locked-out login produced a cookie")

    # A different IP is unaffected.
    ok, other_cookie = H.login(cfg, source_ip="127.0.0.1")
    require_in(ok.status, (303,), "login from a non-locked IP")
    if other_cookie:
        wsclient.terminate(cfg, other_cookie)


if __name__ == "__main__":
    module = sys.modules[__name__]
    raise SystemExit(harness.main(module))
