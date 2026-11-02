#!/usr/bin/env python3
"""Shared harness for the ptygate v1 conformance suite.

Python 3 standard library only. No third-party packages, no root, no
files outside the current process's temp dir.
"""

from __future__ import annotations

import argparse
import os
import signal
import time
import traceback


class SkipTest(Exception):
    """Raised by a test that cannot be exercised in this environment."""


class Failure(AssertionError):
    """Raised when a contract MUST is violated."""


# --------------------------------------------------------------------------
# registry
# --------------------------------------------------------------------------

def test(fn):
    """Mark a function as a conformance test."""
    fn.__ptytest__ = True
    return fn


def collect(module):
    """Return the module's tests in definition order."""
    out = []
    for name, value in vars(module).items():
        if callable(value) and getattr(value, "__ptytest__", False):
            out.append(value)
    return out


# --------------------------------------------------------------------------
# assertions
# --------------------------------------------------------------------------

def require(condition, message):
    if not condition:
        raise Failure(message)


def require_eq(actual, expected, what):
    if actual != expected:
        raise Failure(f"{what}: expected {expected!r}, got {actual!r}")


def require_in(value, allowed, what):
    if value not in allowed:
        raise Failure(f"{what}: expected one of {allowed!r}, got {value!r}")


def require_isinstance(value, types, what):
    if not isinstance(value, types):
        raise Failure(f"{what}: expected {types!r}, got {value!r}")


def wait_until(predicate, timeout=5.0, interval=0.05, what="condition"):
    """Poll predicate until truthy or raise Failure."""
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = predicate()
        if last:
            return last
        time.sleep(interval)
    raise Failure(f"timed out after {timeout:g}s waiting for {what} (last={last!r})")


# --------------------------------------------------------------------------
# configuration
# --------------------------------------------------------------------------

class Config:
    def __init__(
        self,
        base="http://127.0.0.1:8080",
        token="",
        ssh_port=None,
        expect_impl=None,
        expect_ip_mode=None,
        slow=False,
        assert_denied=False,
        source_ip="127.0.0.1",
        timeout=10.0,
        test_timeout=90.0,
        verbose=False,
        grace_ms=None,
    ):
        if "://" not in base:
            base = "http://" + base
        from urllib.parse import urlsplit

        parts = urlsplit(base)
        if parts.scheme not in ("http", "https"):
            raise SystemExit(f"--base must be http:// or https://, got {base!r}")
        host = parts.hostname or "127.0.0.1"
        port = parts.port or (443 if parts.scheme == "https" else 80)
        self.scheme = parts.scheme
        self.host = host
        self.port = port
        self.base = f"{parts.scheme}://{parts.netloc}"
        self.token = token
        self.ssh_port = int(ssh_port) if ssh_port else port
        self.expect_impl = expect_impl
        self.expect_ip_mode = expect_ip_mode
        self.slow = slow
        self.assert_denied = assert_denied
        self.source_ip = source_ip
        self.timeout = float(timeout)
        self.test_timeout = float(test_timeout)
        self.verbose = verbose
        self.grace_ms = int(grace_ms) if grace_ms is not None else None

    @property
    def tls(self):
        return self.scheme == "https"

    @property
    def host_header(self):
        host = self.host
        if ":" in host and not host.startswith("["):
            host = f"[{host}]"
        return f"{host}:{self.port}"

    @property
    def origin(self):
        return f"{self.scheme}://{self.host_header}"

    def __repr__(self):
        return (
            f"Config(base={self.base!r}, ssh_port={self.ssh_port}, "
            f"tls={self.tls}, token=<redacted>)"
        )


# --------------------------------------------------------------------------
# result reporting
# --------------------------------------------------------------------------

class Outcome:
    __slots__ = ("module", "name", "status", "detail", "seconds")

    def __init__(self, module, name, status, detail="", seconds=0.0):
        self.module = module
        self.name = name
        self.status = status
        self.detail = detail
        self.seconds = seconds


class _Alarm:
    """Wall-clock guard so a wedged server produces FAIL, not a hung suite."""

    def __init__(self, seconds):
        self.seconds = seconds
        self.previous = None
        self.armed = False

    def __enter__(self):
        if hasattr(signal, "SIGALRM"):
            def handler(_signum, _frame):
                raise TimeoutError(f"test exceeded {self.seconds:g}s")

            self.previous = signal.signal(signal.SIGALRM, handler)
            signal.setitimer(signal.ITIMER_REAL, self.seconds)
            self.armed = True
        return self

    def __exit__(self, *exc):
        if self.armed:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, self.previous)
        return False


def _one_line(text, limit=500):
    text = " ".join(str(text).split())
    if len(text) > limit:
        return text[: limit - 3] + "..."
    return text


def run_suite(modules, cfg, only=None, quiet=False):
    """Run every test in every module. Returns the list of Outcomes."""
    outcomes = []
    started = time.monotonic()

    for module in modules:
        module_name = module.__name__.replace("test_", "")
        tests = collect(module)
        if only:
            tests = [t for t in tests if t.__name__ in only]
        for fn in tests:
            name = fn.__name__
            t0 = time.monotonic()
            status = "PASS"
            detail = ""
            try:
                with _Alarm(cfg.test_timeout):
                    fn(cfg)
            except SkipTest as exc:
                status, detail = "SKIP", _one_line(exc)
            except Failure as exc:
                status, detail = "FAIL", _one_line(exc)
            except TimeoutError as exc:
                status, detail = "FAIL", _one_line(exc or "timed out")
            except Exception as exc:  # noqa: BLE001 - report, never abort suite
                status = "FAIL"
                detail = _one_line(f"{type(exc).__name__}: {exc}")
                if cfg.verbose:
                    detail += "\n" + traceback.format_exc()
            seconds = time.monotonic() - t0
            outcome = Outcome(module_name, name, status, detail, seconds)
            outcomes.append(outcome)
            if not quiet:
                label = f"{module_name}::{name}"
                line = f"{status:<4} {label}"
                if detail:
                    line += f"  ({detail})"
                if status != "PASS" or cfg.verbose:
                    line += f"  [{seconds:.2f}s]"
                print(line, flush=True)

    if not quiet:
        elapsed = time.monotonic() - started
        passed = sum(1 for o in outcomes if o.status == "PASS")
        failed = sum(1 for o in outcomes if o.status == "FAIL")
        skipped = sum(1 for o in outcomes if o.status == "SKIP")
        print(
            f"\n{passed} passed, {failed} failed, {skipped} skipped "
            f"in {elapsed:.1f}s",
            flush=True,
        )
        if failed:
            print("\nfailures:", flush=True)
            for o in outcomes:
                if o.status == "FAIL":
                    print(f"  {o.module}::{o.name}: {o.detail}", flush=True)
    return outcomes


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def add_common_args(parser):
    parser.add_argument(
        "--base",
        default=os.environ.get("PTYGATE_TEST_BASE", "http://127.0.0.1:8080"),
        help="base URL of the gateway (default: %(default)s)",
    )
    parser.add_argument(
        "--token",
        default=os.environ.get("PTYGATE_TEST_TOKEN", ""),
        help="gateway token (or PTYGATE_TEST_TOKEN)",
    )
    parser.add_argument(
        "--ssh-port",
        type=int,
        default=os.environ.get("PTYGATE_TEST_SSH_PORT") or None,
        help="SSH door port (default: the --base port)",
    )
    parser.add_argument("--expect-impl", choices=["node", "go"])
    parser.add_argument("--expect-ip-mode", choices=["allowlist", "any"])
    parser.add_argument(
        "--assert-denied",
        action="store_true",
        help="assert that the current source IP is denied by the IP policy",
    )
    parser.add_argument(
        "--source-ip",
        default="127.0.0.1",
        help="local source address for lockout tests (default: %(default)s)",
    )
    parser.add_argument("--timeout", type=float, default=10.0)
    parser.add_argument("--test-timeout", type=float, default=90.0)
    parser.add_argument("--grace-ms", type=int, default=None,
                        help="RESUME_GRACE_MS the server was started with")
    parser.add_argument("--slow", action="store_true",
                        help="enable tests that need long waits")
    parser.add_argument("--verbose", action="store_true")
    return parser


def config_from_args(args):
    if not args.token:
        raise SystemExit("--token (or PTYGATE_TEST_TOKEN) is required")
    if len(args.token) < 16:
        raise SystemExit(
            "--token must be at least 16 characters (the protocol's minimum); "
            f"got {len(args.token)}"
        )
    return Config(
        base=args.base,
        token=args.token,
        ssh_port=args.ssh_port,
        expect_impl=args.expect_impl,
        expect_ip_mode=args.expect_ip_mode,
        slow=args.slow,
        assert_denied=args.assert_denied,
        source_ip=args.source_ip,
        timeout=args.timeout,
        test_timeout=args.test_timeout,
        verbose=args.verbose,
        grace_ms=args.grace_ms,
    )


def main(module):
    """Entry point for `python3 test_xxx.py ...`."""
    parser = argparse.ArgumentParser(description=module.__doc__ or module.__name__)
    add_common_args(parser)
    args = parser.parse_args()
    cfg = config_from_args(args)
    outcomes = run_suite([module], cfg)
    return 0 if not any(o.status == "FAIL" for o in outcomes) else 1


if __name__ == "__main__":
    raise SystemExit("harness.py is a library; run run_all.py or a test module")
