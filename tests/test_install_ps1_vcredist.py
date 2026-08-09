"""Regression: install.ps1 must provision the VC++ runtime for the desktop build.

Field report (Aug 2026, fresh Windows VM): Electron >=40.10.3's postinstall
loads an MSVC-built native binding (``@electron-internal/extract-zip``) and
dies with ``ERR_DLOPEN_FAILED`` / "Cannot find native binding" when
``vcruntime140.dll`` is missing -- i.e. the machine has never had the
Visual C++ 2015-2022 Redistributable. The desktop stage then fails with an
opaque exit 1.

install.ps1 must (a) detect + install the redist BEFORE the desktop npm
install, (b) stay non-fatal when provisioning fails, and (c) name the manual
fix when the native-binding failure signature shows up anyway.

These tests are source-level because Linux CI cannot execute the PowerShell
installer (same convention as test_install_ps1_web_server_syntax_probe.py).
"""

from __future__ import annotations

import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
INSTALL_PS1 = REPO_ROOT / "scripts" / "install.ps1"


def _install_ps1() -> str:
    return INSTALL_PS1.read_text(encoding="utf-8")


def test_vcruntime_probe_checks_both_64bit_dlls() -> None:
    text = _install_ps1()
    assert "function Test-VCRuntimePresent" in text
    # 64-bit MSVC binaries link BOTH vcruntime140.dll and vcruntime140_1.dll;
    # probing only the first passes on machines that still fail to dlopen.
    assert "vcruntime140.dll" in text
    assert "vcruntime140_1.dll" in text
    # A 32-bit PowerShell host on 64-bit Windows gets System32 redirected to
    # SysWOW64 -- the probe must prefer Sysnative when present.
    assert "Sysnative" in text


def test_ensure_vcredist_runs_before_desktop_npm_install() -> None:
    text = _install_ps1()
    assert "function Ensure-VCRedist" in text
    install_desktop = text[text.index("function Install-Desktop") :]
    ensure_pos = install_desktop.index("Ensure-VCRedist")
    npm_ci_pos = install_desktop.index("ci 2>&1")
    assert ensure_pos < npm_ci_pos, (
        "Ensure-VCRedist must run before the desktop workspace npm install, "
        "otherwise Electron's postinstall can ERR_DLOPEN_FAILED on machines "
        "without the VC++ runtime."
    )


def test_ensure_vcredist_has_winget_and_direct_download_paths() -> None:
    text = _install_ps1()
    fn = re.search(r"function Ensure-VCRedist[\s\S]+?\nfunction ", text)
    assert fn is not None
    body = fn.group(0)
    assert "Microsoft.VCRedist.2015+" in body
    assert "https://aka.ms/vs/17/release/vc_redist." in body
    # Exit 3010 (reboot pending) and 1638 (newer already installed) are
    # success shapes for the redist exe -- treating them as failure would
    # warn on perfectly healthy machines.
    assert "3010" in body and "1638" in body


def test_ensure_vcredist_is_non_fatal() -> None:
    text = _install_ps1()
    fn = re.search(r"function Ensure-VCRedist[\s\S]+?\nfunction ", text)
    assert fn is not None
    body = fn.group(0)
    assert "throw" not in body, (
        "Ensure-VCRedist must be best-effort: a redist download hiccup must "
        "not fail an otherwise-good install (most machines already have the "
        "runtime)."
    )
    # The call site must swallow the boolean, not gate the stage on it.
    assert re.search(r"Ensure-VCRedist \| Out-Null", text)


def test_native_binding_failure_gets_vcredist_hint() -> None:
    text = _install_ps1()
    assert "function Test-NativeBindingFailure" in text
    assert "Cannot find native binding" in text
    assert "ERR_DLOPEN_FAILED" in text
    # The desktop npm failure path must surface the manual fix.
    hint = re.search(
        r"Test-NativeBindingFailure[\s\S]{0,600}?vc_redist", text
    )
    assert hint is not None, (
        "the desktop npm failure path must name the VC++ redist manual fix "
        "when the native-binding failure signature is present"
    )
