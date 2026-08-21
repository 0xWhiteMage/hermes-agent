"""The Windows version-probe fallback: PE VERSIONINFO, not stdout.

chrome.exe is a GUI-subsystem binary: `chrome.exe --version` starts,
prints NOTHING to stdout, and exits 0. The exec probe alone therefore
reported "provisioned binary does not run" for a chromium payload that
was perfectly healthy, and the desktop build failed on every Windows
leg. The fallback reads the PE VERSIONINFO resource through PowerShell
instead — no execution, works for GUI binaries.

Everything here is windows_only: the fallback only fires on win32, and
faking the host is banned. cmd.exe stands in for chrome.exe — `cmd /c
rem` is the same shape (runs fine, stdout empty) and its PE carries a
VERSIONINFO resource on every Windows install.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

import pytest

from installation.provisioner import _probe_version, _windows_file_version

VERSION_SHAPE = re.compile(r"^\d+(?:\.\d+)+$")


def _system32(exe: str) -> Path:
    return Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / exe


@pytest.mark.windows_only
def test_versioninfo_read_without_execution() -> None:
    version = _windows_file_version(_system32("notepad.exe"))
    assert version is not None and VERSION_SHAPE.match(version)


@pytest.mark.windows_only
def test_silent_gui_shaped_binary_falls_back_to_versioninfo() -> None:
    """The chrome.exe shape end to end: exec succeeds with empty stdout,
    the probe still returns a version — from the PE resource."""
    version = _probe_version(_system32("cmd.exe"), args=["/c", "rem"])
    assert version is not None and VERSION_SHAPE.match(version)


@pytest.mark.windows_only
def test_missing_binary_is_still_a_failure() -> None:
    """The fallback must not resurrect a binary that cannot even spawn."""
    assert _probe_version(_system32("hermes-does-not-exist.exe")) is None


@pytest.mark.windows_only
def test_resourceless_binary_is_still_a_failure(tmp_path: Path) -> None:
    """Runs-but-no-VERSIONINFO: both rungs miss, the probe stays None.
    A .cmd shim is exactly that shape."""
    shim = tmp_path / "silent.cmd"
    shim.write_text("@rem nothing\r\n", encoding="ascii")
    assert _probe_version(shim) is None
