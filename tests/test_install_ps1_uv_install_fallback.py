"""Regression: Install-Uv stages the pinned uv and surfaces real errors.

History of this contract:

- Issue #69216: the old astral.sh-based Install-Uv swallowed installer
  output (``2>&1 | Out-Null``) and had one install source, so users only
  ever saw a generic post-condition failure. A three-rung fallback ladder
  (astral.sh, GitHub installer mirror, PATH salvage) fixed that era's
  design (3af56c220).
- The managed-runtime restack (779686046, c9febdde5) replaced the ladder
  entirely: Hermes owns its uv. Install-Uv now downloads the EXACT
  artifact pinned in installation/runtime-pins.json (URL + sha256 via the
  generated fragment), verifies the digest before extraction, and stages
  the binary at $InstallDir\\.hermes-runtime\\uv\\uv.exe -- the same
  location managed_uv.managed_uv_path() resolves. PATH probing and
  non-pinned install sources are deliberately gone: a salvaged or
  latest-channel uv is a binary nobody reviewed.

These tests pin the NEW design's safety and UX properties:

1. No PATH-probing salvage rung comes back (managed-only invariant).
2. The download digest is checked BEFORE the archive is extracted.
3. The failure path still reaches the user: the caught error is printed
   (successor of the #69366 output-swallowing pin) and the manual-install
   docs pointer survives.
4. A staged binary whose version does not match the pin is replaced.

install.ps1 only runs on Windows, so these tests lock the contract at the
source-text level (same style as the other tests/test_install_ps1_*.py).
"""

import re
from pathlib import Path

import pytest

_INSTALL_PS1 = Path(__file__).resolve().parents[1] / "scripts" / "install.ps1"


@pytest.fixture(scope="module")
def source() -> str:
    return _INSTALL_PS1.read_text(encoding="utf-8")


def _install_uv_body(source: str) -> str:
    """Extract the text of Install-Uv up to the next top-level function."""
    start = source.index("function Install-Uv")
    tail = source[start + 1 :]
    match = re.search(r"^function ", tail, flags=re.MULTILINE)
    end = start + 1 + (match.start() if match else len(tail))
    return source[start:end]


def test_install_uv_is_pin_table_driven(source: str):
    """The pinned artifact table is the only install source (779686046)."""
    body = _install_uv_body(source)
    assert "$script:UvPinFiles" in body, (
        "Install-Uv must select its download from the generated pin table "
        "($script:UvPinFiles), not resolve a version at run time"
    )
    assert "$script:UvPinVersion" in body, (
        "Install-Uv must compare against the pinned version "
        "($script:UvPinVersion) so a pin bump propagates"
    )


def test_install_uv_has_no_path_salvage_rung(source: str):
    """The managed-runtime restack removed PATH probing on purpose.

    A uv salvaged from PATH or from %USERPROFILE%\\.local\\bin is an
    unpinned, unverified binary. The managed-only invariant says Hermes
    runs only the uv it staged and digest-checked itself.
    """
    body = _install_uv_body(source)
    assert "Get-Command uv" not in body, (
        "Install-Uv must not probe PATH for a system uv -- the managed "
        "runtime design (779686046 / c9febdde5) forbids adopting an "
        "unverified binary"
    )
    assert ".local\\bin\\uv.exe" not in body, (
        "Install-Uv must not salvage the astral default install location "
        "-- that binary is not the pinned artifact"
    )


def test_uv_digest_is_checked_before_extraction(source: str):
    """A mismatched archive must be rejected before it is unpacked."""
    body = _install_uv_body(source)
    hash_pos = body.index("Get-FileHash")
    extract_pos = body.index("Expand-Archive")
    assert hash_pos < extract_pos, (
        "the sha256 check must run BEFORE Expand-Archive -- an unverified "
        "archive must never be unpacked"
    )
    assert "$pin.Sha256" in body, (
        "the digest must be compared against the pin table's sha256"
    )


def test_uv_staged_at_managed_runtime_location(source: str):
    """The staged binary must be where managed_uv_path() resolves."""
    body = _install_uv_body(source)
    assert ".hermes-runtime\\uv" in body, (
        "Install-Uv must stage uv under $InstallDir\\.hermes-runtime\\uv -- "
        "the location managed_uv.managed_uv_path() reads -- so the binary "
        "the installer stages is the one ensure_uv() finds (c9febdde5)"
    )


def test_failure_path_shows_error_and_manual_install_pointer(source: str):
    """Successor of the #69366 pin: real failures must reach the user.

    The old bug piped installer output to Out-Null so download errors,
    proxy blocks, and AV quarantines vanished. The new design has no
    child installer process, so the equivalent contract is: the catch
    block prints the caught error itself, and the manual-install docs
    pointer survives.
    """
    body = _install_uv_body(source)
    assert "https://docs.astral.sh/uv/getting-started/installation/" in body, (
        "the manual-install pointer must survive in the failure path"
    )
    assert re.search(r"catch\s*\{[^}]*\$_", body), (
        "the catch block must include the caught error ($_) in its output "
        "so the real cause (download error, proxy block, AV quarantine) "
        "reaches the user instead of a generic message"
    )
    download_lines = [
        ln for ln in body.splitlines() if "Invoke-WebRequest" in ln
    ]
    assert download_lines, "Install-Uv must download via Invoke-WebRequest"
    for ln in download_lines:
        assert "Out-Null" not in ln, (
            "the uv download must not silence its errors with Out-Null: "
            f"{ln.strip()!r}"
        )


def test_stale_managed_uv_is_replaced_on_pin_mismatch(source: str):
    """A binary predating the pin is unverified and must be replaced."""
    body = _install_uv_body(source)
    keep_check = re.search(
        r"-match\s+\[regex\]::Escape\(\$script:UvPinVersion\)", body
    )
    assert keep_check, (
        "an existing managed uv must be kept only when its version matches "
        "the pin -- otherwise it must be replaced"
    )
