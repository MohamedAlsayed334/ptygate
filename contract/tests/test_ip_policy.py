#!/usr/bin/env python3
"""IP policy conformance (best effort from localhost)."""

from __future__ import annotations

import sys

import harness
import httpclient as H
import wsclient
from harness import SkipTest, require_eq, require_in, test


@test
def version_reports_effective_mode(cfg):
    """The effective IP mode is advertised and well formed."""
    data = H.version(cfg)
    require_in(data.get("ip_mode"), ("allowlist", "any"), "/version ip_mode")
    if cfg.expect_ip_mode:
        require_eq(data.get("ip_mode"), cfg.expect_ip_mode,
                   "/version ip_mode (expected)")


@test
def deny_all_http_paths(cfg):
    """A denied source gets 403 on every HTTP path, including healthz."""
    if not cfg.assert_denied:
        raise SkipTest(
            "the suite's source IP is not known to be denied; start the server "
            "with ALLOWED_IPS that excludes it (e.g. 10.0.0.0/8) and re-run "
            "with --assert-denied"
        )
    for path in ("/healthz", "/version", "/login", "/"):
        resp = H.get(cfg, path)
        require_eq(resp.status, 403, f"denied GET {path} status")

    resp = H.post_form(cfg, "/login", {"token": cfg.token})
    require_eq(resp.status, 403, "denied POST /login status")


@test
def deny_websocket_before_upgrade(cfg):
    """A denied source gets 403 with no hello and no PTY."""
    if not cfg.assert_denied:
        raise SkipTest(
            "set --assert-denied (and an ALLOWED_IPS that excludes this host)"
        )
    status, client = wsclient.handshake_status(cfg, cookie="irrelevant")
    if client is not None:
        client.close_socket()
    require_eq(status, 403, "denied WS upgrade status")


@test
def allowlist_mode_is_default_loopback(cfg):
    """In allowlist mode, loopback works (proves the default list includes it)."""
    data = H.version(cfg)
    if data.get("ip_mode") != "allowlist":
        raise SkipTest("server is in any mode")
    if cfg.assert_denied:
        raise SkipTest("this run asserts denial")
    resp = H.get(cfg, "/healthz")
    require_eq(resp.status, 200, "loopback must be allowed by the default list")


@test
def any_mode_does_not_break_local_access(cfg):
    data = H.version(cfg)
    if data.get("ip_mode") != "any":
        raise SkipTest("server is in allowlist mode")
    resp = H.get(cfg, "/healthz")
    require_eq(resp.status, 200, "any mode must allow localhost")


if __name__ == "__main__":
    module = sys.modules[__name__]
    raise SystemExit(harness.main(module))
