"""Shared fixtures for the cua-driver (Computer Use) tests.

cua-driver is a PINNED MANAGED TOOL (``installation/runtime-pins.json``),
so ``resolve_cua_driver_cmd`` answers from the provisioner's facts file —
not from PATH, not from ``~/.local/bin``, not from a Homebrew prefix. A
test that wants "a driver is installed" therefore has to stage a fact,
which is what :func:`managed_cua_driver` does.

These tests used to fake the driver with ``patch("shutil.which",
return_value="/fake/cua-driver")``. That is now a fake of a rung that no
longer exists: it made the tests pass while the real resolver returned
None, which is the exact shape of a test that cannot fail for the right
reason.
"""

from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest


def _write_fact(runtime_dir: Path, binary_rel: str, version: str = "0.21.0") -> None:
    """Record a cua-driver fact using the provisioner's OWN writer.

    Going through ``save_facts`` rather than hand-rolling the JSON keeps
    the fixture honest: the facts file has a schema version that
    ``load_facts`` checks, and a hand-written shape that drifts from it
    is silently read as "nothing provisioned" — a fixture that fakes the
    absence it is supposed to fake the presence of.
    """
    from installation.registry import RuntimeFact, save_facts

    save_facts(
        {"cua-driver": RuntimeFact(version=version, path=binary_rel)},
        runtime_dir,
        path_order=["cua-driver"],
    )


@pytest.fixture
def managed_cua_driver(tmp_path, monkeypatch):
    """Stage a fake PROVISIONED cua-driver and return its absolute path.

    Points ``HERMES_RUNTIME_DIR`` at a self-contained runtime dir (facts
    and bytes together — the shape the Nix bundle and desktop payload
    use), drops an executable stub in the store entry, and records the
    fact that names it. ``resolve_cua_driver_cmd()`` then resolves it for
    real, through ``installation.registry.tool_path``.

    Any ``HERMES_CUA_DRIVER_CMD`` override is cleared: it outranks the
    managed fact, so a stray one in the developer's environment would
    silently invalidate the test.
    """
    monkeypatch.delenv("HERMES_CUA_DRIVER_CMD", raising=False)

    runtime = tmp_path / "runtime"
    entry = runtime / "cua-driver-0.21.0-linux-x64"
    entry.mkdir(parents=True)
    name = "cua-driver.exe" if os.name == "nt" else "cua-driver"
    binary = entry / name
    binary.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    binary.chmod(binary.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)

    _write_fact(runtime, f"{entry.name}/{name}")
    monkeypatch.setenv("HERMES_RUNTIME_DIR", str(runtime))
    return str(binary)


@pytest.fixture
def no_cua_driver(tmp_path, monkeypatch):
    """An install where the driver was never provisioned.

    An empty runtime dir, so the facts lookup misses. This is the honest
    "not installed" state now: optional tools are staged on demand, and
    nothing on PATH can stand in for one.
    """
    monkeypatch.delenv("HERMES_CUA_DRIVER_CMD", raising=False)
    runtime = tmp_path / "empty-runtime"
    runtime.mkdir()
    monkeypatch.setenv("HERMES_RUNTIME_DIR", str(runtime))
    return runtime
