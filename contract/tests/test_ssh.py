#!/usr/bin/env python3
"""SSH door conformance: banner, password auth, exec, PTY request.

Skips cleanly when the machine has no `ssh` client or the door is disabled.
"""

from __future__ import annotations

import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile

import harness
import httpclient as H
from harness import Failure, SkipTest, require, require_eq, test

BANNER_PREFIX = b"SSH-2.0-ptygate_"
ASKPASS_ENV = "PTYGATE_TEST_SSH_PASSWORD"


def _require_ssh_door(cfg):
    data = H.version(cfg)
    transports = data.get("transports")
    if not isinstance(transports, dict) or transports.get("ssh") is not True:
        raise SkipTest(
            "SSH door disabled (/version transports.ssh is not true)"
        )


def _read_banner(cfg, timeout=5.0):
    sock = socket.create_connection((cfg.host, cfg.ssh_port), timeout=timeout)
    try:
        sock.settimeout(timeout)
        data = b""
        while b"\n" not in data and len(data) < 1024:
            chunk = sock.recv(256)
            if not chunk:
                break
            data += chunk
        return data
    finally:
        try:
            sock.close()
        except OSError:
            pass


@test
def ssh_banner(cfg):
    """The SSH door speaks SSH-2.0 with the ptygate identification string."""
    _require_ssh_door(cfg)
    data = _read_banner(cfg)
    require(data, "SSH door sent no banner (expected an identification string)")
    line = data.split(b"\r\n", 1)[0].split(b"\n", 1)[0]
    require(
        line.startswith(BANNER_PREFIX),
        f"SSH banner: expected {BANNER_PREFIX!r}..., got {line[:80]!r}",
    )
    require(
        b"0.1.0" in line,
        f"SSH banner must carry the gateway version: {line!r}",
    )
    if cfg.ssh_port == cfg.port:
        # Reaching the banner on the HTTP port is the one-port multiplex proof.
        require(b"SSH-" in line, "SSH banner must arrive on the shared port")


class _SshRunner:
    def __init__(self, cfg):
        self.cfg = cfg
        self.ssh = shutil.which("ssh")
        if not self.ssh:
            raise SkipTest("no `ssh` client on this machine")
        self.tmp = tempfile.mkdtemp(prefix="ptygate-ssh-")
        self.askpass = os.path.join(self.tmp, "askpass.sh")
        with open(self.askpass, "w", encoding="utf-8") as handle:
            handle.write("#!/bin/sh\nprintf '%s\\n' \"$" + ASKPASS_ENV + "\"\n")
        os.chmod(self.askpass, 0o700)

    def close(self):
        try:
            shutil.rmtree(self.tmp, ignore_errors=True)
        except Exception:  # noqa: BLE001
            pass

    def run(self, command, password, tty=False, timeout=30):
        args = [
            self.ssh,
            "-l", "ptygate",
            "-p", str(self.cfg.ssh_port),
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "GlobalKnownHostsFile=/dev/null",
            "-o", "PreferredAuthentications=password",
            "-o", "PubkeyAuthentication=no",
            "-o", "NumberOfPasswordPrompts=1",
            "-o", "ConnectTimeout=10",
            "-o", "LogLevel=ERROR",
        ]
        if tty:
            args.append("-tt")
        args.extend([self.cfg.host, "--", command])
        env = os.environ.copy()
        env.update({
            "SSH_ASKPASS": self.askpass,
            "SSH_ASKPASS_REQUIRE": "force",
            "DISPLAY": env.get("DISPLAY", ":0"),
            ASKPASS_ENV: password,
        })
        try:
            return subprocess.run(
                args,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                errors="replace",
                timeout=timeout,
                env=env,
            )
        except subprocess.TimeoutExpired:
            raise Failure(f"ssh command timed out after {timeout}s: {command!r}")

    def assert_password_transport(self):
        """Prove password auth is actually being driven, or SKIP.

        A wrong password must be rejected by the server. If even that does not
        produce an authentication failure, the local ssh/askpass combination is
        not working, so the password tests are unrunnable here.
        """
        proc = self.run("true", "definitely-the-wrong-token-" + os.urandom(6).hex())
        combined = (proc.stdout or "") + (proc.stderr or "")
        if proc.returncode == 0:
            raise Failure("SSH accepted a wrong password (exit 0)")
        if "permission denied" not in combined.lower():
            raise SkipTest(
                "cannot drive ssh password auth non-interactively "
                f"(OpenSSH too old for SSH_ASKPASS_REQUIRE=force?): "
                f"{combined.strip()[:200]}"
            )


@test
def ssh_wrong_password_is_rejected(cfg):
    _require_ssh_door(cfg)
    runner = _SshRunner(cfg)
    try:
        runner.assert_password_transport()
    finally:
        runner.close()


@test
def ssh_password_exec(cfg):
    """Password == gateway token, any username; exec runs and returns output."""
    _require_ssh_door(cfg)
    runner = _SshRunner(cfg)
    try:
        runner.assert_password_transport()
        proc = runner.run("printf 'SSH%s\\n' _OK", cfg.token)
        combined = (proc.stdout or "") + (proc.stderr or "")
        require_eq(
            proc.returncode, 0,
            f"ssh exec with the correct password failed (stderr={proc.stderr!r})",
        )
        require("SSH_OK" in combined, f"remote command output missing: {combined!r}")
    finally:
        runner.close()


@test
def ssh_exec_exit_status(cfg):
    """The remote command's exit status is returned to the ssh client."""
    _require_ssh_door(cfg)
    runner = _SshRunner(cfg)
    try:
        runner.assert_password_transport()
        proc = runner.run("exit 7", cfg.token)
        require_eq(proc.returncode, 7,
                   f"ssh exit status for `exit 7` (stderr={proc.stderr!r})")
    finally:
        runner.close()


@test
def ssh_pty_request(cfg):
    """`ssh -tt` allocates a PTY; stty size proves the window exists."""
    _require_ssh_door(cfg)
    runner = _SshRunner(cfg)
    try:
        runner.assert_password_transport()
        proc = runner.run("stty size", cfg.token, tty=True)
        combined = (proc.stdout or "") + (proc.stderr or "")
        require_eq(proc.returncode, 0, f"ssh -tt stty size failed: {combined!r}")
        match = re.search(r"^\s*(\d+)\s+(\d+)\s*$", proc.stdout or "", re.M)
        require(
            match is not None,
            f"stty size produced no '<rows> <cols>' line: {proc.stdout!r}",
        )
        rows, cols = int(match.group(1)), int(match.group(2))
        require(5 <= rows <= 200, f"PTY rows out of range: {rows}")
        require(20 <= cols <= 500, f"PTY cols out of range: {cols}")
    finally:
        runner.close()


@test
def ssh_denied_before_banner(cfg):
    """A denied source is closed before the SSH banner (no prompt)."""
    if not cfg.assert_denied:
        raise SkipTest(
            "set --assert-denied and restrict ALLOWED_IPS to exercise SSH denial"
        )
    sock = socket.create_connection((cfg.host, cfg.ssh_port), timeout=5)
    try:
        sock.settimeout(5)
        try:
            data = sock.recv(256)
        except ConnectionResetError:
            data = b""
        except socket.timeout:
            raise Failure(
                "denied SSH connection was neither closed nor reset before "
                "the banner"
            )
        require(
            not data.startswith(b"SSH-"),
            f"denied SSH client received a banner: {data[:80]!r}",
        )
    finally:
        try:
            sock.close()
        except OSError:
            pass


if __name__ == "__main__":
    module = sys.modules[__name__]
    raise SystemExit(harness.main(module))
