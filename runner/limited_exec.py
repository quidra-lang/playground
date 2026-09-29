#!/usr/bin/env python3
"""Apply per-request process limits, then replace this process with the command."""
from __future__ import annotations

import os
import resource
import sys


def drop_privileges() -> None:
    """Optionally drop from a sandbox control user to the untrusted-code uid/gid."""
    raw_uid = os.environ.get("QUIDRA_RUNNER_UID")
    raw_gid = os.environ.get("QUIDRA_RUNNER_GID")
    if raw_uid is None and raw_gid is None:
        return
    if raw_uid is None or raw_gid is None:
        raise ValueError("QUIDRA_RUNNER_UID and QUIDRA_RUNNER_GID must be set together")

    uid = int(raw_uid)
    gid = int(raw_gid)
    if uid <= 0 or gid <= 0:
        raise ValueError("runner uid/gid must be non-root positive integers")

    if os.geteuid() == 0:
        os.setgroups([])
        os.setgid(gid)
        os.setuid(uid)
        return

    if os.geteuid() != uid or os.getegid() != gid:
        raise PermissionError("cannot switch runner identity without root privileges")


def main() -> int:
    if len(sys.argv) < 2:
        print("limited_exec: missing command", file=sys.stderr)
        return 64

    os.setsid()
    resource.setrlimit(resource.RLIMIT_CPU, (6, 6))
    resource.setrlimit(resource.RLIMIT_AS, (1024 * 1024 * 1024, 1024 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024 * 1024, 64 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    if hasattr(resource, "RLIMIT_NPROC"):
        resource.setrlimit(resource.RLIMIT_NPROC, (32, 32))

    drop_privileges()
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)
    return 127


if __name__ == "__main__":
    raise SystemExit(main())
