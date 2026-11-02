#!/usr/bin/env python3
"""ptygate v1 conformance suite runner.

Runs every module against a live gateway and prints one PASS/FAIL/SKIP line per
test. Exits 1 if any test failed (SKIP is not a failure).

    python3 run_all.py --base http://127.0.0.1:8080 --token TOKEN \
        [--ssh-port N] [--expect-impl node|go]
"""

from __future__ import annotations

import argparse
import importlib
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import harness  # noqa: E402

MODULE_NAMES = [
    "test_http",
    "test_auth",
    "test_ws",
    "test_resume",
    "test_regression",
    "test_ip_policy",
    "test_ssh",
]


def load_modules(selected):
    names = MODULE_NAMES
    if selected:
        unknown = sorted(set(selected) - set(MODULE_NAMES))
        if unknown:
            raise SystemExit(
                f"unknown module(s): {', '.join(unknown)}; "
                f"choose from {', '.join(MODULE_NAMES)}"
            )
        names = [n for n in MODULE_NAMES if n in selected]
    modules = []
    for name in names:
        try:
            modules.append(importlib.import_module(name))
        except Exception as exc:  # noqa: BLE001
            raise SystemExit(f"could not import {name}: {type(exc).__name__}: {exc}")
    return modules


def preflight(cfg, modules):
    """Print a short, non-fatal summary of the server under test."""
    try:
        import httpclient as H

        data = H.version(cfg)
        transports = data.get("transports") or {}
        print(
            "target: "
            f"{cfg.base} impl={data.get('impl')} version={data.get('version')} "
            f"protocol={data.get('protocol')} ip_mode={data.get('ip_mode')} "
            f"tls={transports.get('tls')} ssh={transports.get('ssh')} "
            f"ssh_port={cfg.ssh_port}",
            flush=True,
        )
        if data.get("protocol") != 1:
            print(
                "WARN: /version.protocol is not 1; this suite targets protocol 1",
                flush=True,
            )
    except Exception as exc:  # noqa: BLE001
        print(f"WARN: preflight GET /version failed: {exc}", flush=True)

    if not cfg.assert_denied:
        print(
            "note: IP-denial checks will SKIP; re-run with --assert-denied after "
            "starting the server with ALLOWED_IPS that excludes this source",
            flush=True,
        )
    if not cfg.slow:
        print(
            "note: timing-dependent checks (grace expiry, 30 s heartbeat) are "
            "skipped; add --slow (and --grace-ms) to enable them",
            flush=True,
        )
    print(flush=True)


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="ptygate protocol-v1 conformance suite",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    harness.add_common_args(parser)
    parser.add_argument(
        "--module",
        action="append",
        default=None,
        help="run only this module (repeatable); default: all",
    )
    parser.add_argument("--list", action="store_true", help="list tests and exit")
    args = parser.parse_args(argv)

    modules = load_modules(args.module)

    if args.list:
        for module in modules:
            for fn in harness.collect(module):
                print(f"{module.__name__}::{fn.__name__}  {fn.__doc__ or ''}".rstrip())
        return 0

    cfg = harness.config_from_args(args)
    preflight(cfg, modules)
    outcomes = harness.run_suite(modules, cfg)
    return 0 if not any(o.status == "FAIL" for o in outcomes) else 1


if __name__ == "__main__":
    raise SystemExit(main())
