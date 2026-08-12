"""Provision managed runtime tools into <install>/.hermes-runtime/.

THE one dep engine: `hermes update` (post-update MACHINE_STEPS), the
installers (`--install-phase`, after venv + uv sync), and the desktop
payload staging all run this same code.

Per tool: read the EXACT pin for this target (url + sha256) → download →
verify the digest BEFORE extracting → stage into the tool's directory →
verify by RUNNING the binary → record the fact. A tool that cannot be
verified is not recorded: readers see it as unprovisioned and fall back
to system PATH, and the next run retries.

There is no salvage and no "reuse whatever is lying around". A tool is
either the exact pinned artifact, verified by digest, or it is absent.
Adopting an unverified tree from a previous install would defeat the
point of pinning digests at all.

Progress streams as installer stage-JSON lines when --json is on, so the
GUI install driver renders provisioning natively.
"""

from __future__ import annotations

import hashlib
import json
import logging
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

from hermes_constants import get_runtime_dir
from hermes_cli.runtime_registry import (
    PinnedFile,
    RuntimeFact,
    current_target,
    load_facts,
    load_pins,
    pinned_file,
    save_facts,
)

logger = logging.getLogger(__name__)

_UA = {"User-Agent": "hermes-agent-provisioner"}


def _is_windows() -> bool:
    return sys.platform.startswith("win")


# ─── download + verify + extract ────────────────────────────────────────────


def _download(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(
        urllib.request.Request(url, headers=_UA), timeout=600
    ) as resp, open(dest, "wb") as out:
        shutil.copyfileobj(resp, out)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _fetch_verified(pin: PinnedFile, into: Path) -> Path:
    """Download a pinned artifact and prove it is the pinned bytes.

    The digest check happens BEFORE anything is unpacked or executed: a
    mismatched archive is deleted, never extracted. This is the only
    thing standing between a compromised CDN and a user's machine.
    """
    archive = into / pin.filename
    _download(pin.url, archive)

    actual = _sha256(archive)
    if actual != pin.sha256:
        archive.unlink(missing_ok=True)
        raise RuntimeError(
            f"sha256 mismatch for {pin.filename}: "
            f"pinned {pin.sha256}, downloaded {actual}"
        )
    return archive


def _extract(archive: Path, dest: Path) -> None:
    """Extract tar.gz/tar.xz/zip into a freshly emptied *dest*."""
    shutil.rmtree(dest, ignore_errors=True)
    dest.mkdir(parents=True, exist_ok=True)
    name = archive.name.lower()
    if name.endswith((".tar.gz", ".tgz", ".tar.xz")):
        with tarfile.open(archive) as tf:
            tf.extractall(dest, filter="data")
    elif name.endswith(".zip"):
        with zipfile.ZipFile(archive) as zf:
            zf.extractall(dest)
            # ZipInfo drops the executable bit on extract; restore it from
            # the archived mode so an extracted `uv`/`gh` is runnable.
            for info in zf.infolist():
                mode = info.external_attr >> 16
                if mode & 0o111:
                    (dest / info.filename).chmod(mode & 0o777)
    else:
        raise ValueError(f"unsupported archive: {archive.name}")


# Directory names that are part of a tool's OWN layout. An archive whose
# single top-level entry is one of these is already unwrapped — hoisting
# it would destroy the layout (a lone `bin/` became `gh` and `gh/bin/gh`
# vanished).
_LAYOUT_DIRS = frozenset({"bin", "cmd", "lib", "libexec", "share", "etc", "usr"})


def _flatten_single_dir(dest: Path) -> None:
    """Hoist a lone VERSIONED wrapper dir's contents up one level.

    Most projects nest everything under one dir named for the release
    (``gh_2.97.0_linux_amd64/``, ``node-v26.7.0-linux-x64/``), which would
    otherwise leak the version into every facts path and break on the
    next bump. Some archives unpack flat instead — same tool, different
    platform, in uv's case — so this keys off what is actually there.
    """
    entries = [p for p in dest.iterdir() if not p.name.startswith(".")]
    if len(entries) != 1 or not entries[0].is_dir():
        return

    inner = entries[0]
    if inner.name.lower() in _LAYOUT_DIRS:
        return

    for child in inner.iterdir():
        shutil.move(str(child), dest / child.name)
    inner.rmdir()


def _probe_version(binary: Path, args: list[str] | None = None) -> Optional[str]:
    """Run `<binary> --version` and return the first version-shaped token.

    None when the binary does not run — callers treat that as
    unprovisioned, never as fatal.
    """
    try:
        out = subprocess.run(
            [str(binary)] + (args or ["--version"]),
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    import re as _re

    m = _re.search(r"\d+(?:\.\d+)+", out or "")
    return m.group(0) if m else None


# ─── per-tool layout + staging ──────────────────────────────────────────────


@dataclass
class ToolResult:
    tool: str
    action: str  # kept | downloaded | failed
    version: Optional[str] = None
    detail: Optional[str] = None

    @property
    def ok(self) -> bool:
        return self.action != "failed"


def _binary_rel(tool: str, target: str) -> str:
    """Where each tool's binary lands, relative to the runtime dir."""
    win = target.startswith("win32")
    ext = ".exe" if win else ""
    return {
        # The Windows node zip has node.exe at the root; POSIX has bin/node.
        "node": "node/node.exe" if win else "node/bin/node",
        "uv": f"uv/uv{ext}",
        # PortableGit exposes cmd/git.exe; dugite-native uses bin/git.
        "git": "git/cmd/git.exe" if win else "git/bin/git",
        "gh": f"gh/bin/gh{ext}",
        "ripgrep": f"ripgrep/rg{ext}",
    }[tool]


def _path_dirs(tool: str, target: str) -> Optional[list[str]]:
    """PATH dirs for tools whose surface is more than the binary's dir.

    PortableGit needs three: bash.exe and the coreutils live outside
    cmd/. Everything else is covered by the binary's own directory.
    """
    if tool == "git" and target.startswith("win32"):
        return ["git/cmd", "git/bin", "git/usr/bin"]
    return None


def _stage_archive(pin: PinnedFile, dest: Path, tmp: Path) -> None:
    """The common case: fetch, verify, extract, un-nest.

    Flattening is decided by what the archive actually CONTAINS, not by a
    per-tool list: several projects nest under a versioned top-level dir
    on one platform and unpack flat on another (uv's POSIX tarball nests,
    its Windows zip does not — a hardcoded list got that wrong).
    ``_flatten_single_dir`` no-ops unless there is exactly one top-level
    directory, so applying it unconditionally is safe.
    """
    archive = _fetch_verified(pin, tmp)
    _extract(archive, dest)
    _flatten_single_dir(dest)


def _stage_portable_git(pin: PinnedFile, dest: Path, tmp: Path) -> None:
    """PortableGit is a self-extracting 7z, not an archive we can read.

    It is the one asset that must be EXECUTED to unpack, so the digest
    check matters more here than anywhere else — ``_fetch_verified`` has
    already proven the bytes before this runs it.
    """
    sfx = _fetch_verified(pin, tmp)
    shutil.rmtree(dest, ignore_errors=True)
    dest.mkdir(parents=True, exist_ok=True)
    sfx.chmod(0o755)
    proc = subprocess.run(
        [str(sfx), f"-o{dest}", "-y"], capture_output=True, timeout=900
    )
    if proc.returncode != 0:
        raise RuntimeError(f"PortableGit self-extractor exited {proc.returncode}")


def _stage(tool: str, pin: PinnedFile, dest: Path, tmp: Path, target: str) -> None:
    """Unpack one tool into its runtime-dir home.

    Branching lives here and nowhere else: every tool arrives through the
    same fetch-and-verify, and differs only in how its artifact unpacks.
    """
    if tool == "git" and target.startswith("win32"):
        _stage_portable_git(pin, dest, tmp)
        return

    _stage_archive(pin, dest, tmp)


# ─── the provisioning loop ──────────────────────────────────────────────────


def _provision_one(
    tool: str,
    entry: dict,
    rt: Path,
    facts: dict[str, RuntimeFact],
    target: str,
    verify_runs: bool = True,
) -> ToolResult:
    """Bring ONE tool to the pinned state. Never raises."""
    rel = _binary_rel(tool, target)

    # Already exactly right? The pin is exact, so this is an equality
    # check, not a range check.
    fact = facts.get(tool)
    if fact is not None and fact.version == entry["version"] and (rt / rel).is_file():
        return ToolResult(tool, "kept", version=fact.version)

    try:
        pin = pinned_file(tool, target, pins={tool: entry})
    except KeyError as exc:
        return ToolResult(tool, "failed", detail=str(exc))

    try:
        with tempfile.TemporaryDirectory() as td:
            _stage(tool, pin, rt / tool, Path(td), target)

        binary = rt / rel
        if not binary.is_file():
            return ToolResult(tool, "failed", detail=f"{rel} missing after staging")
        binary.chmod(binary.stat().st_mode | 0o755)

        # Verify by RUNNING it, not by trusting the archive: a cross-arch
        # or half-extracted binary fails here rather than at first use.
        # Skipped when staging FOR another target, where the binary
        # cannot run on this host by definition.
        if verify_runs and _probe_version(binary) is None:
            return ToolResult(tool, "failed", detail="provisioned binary does not run")

        facts[tool] = RuntimeFact(
            version=pin.version, path=rel, path_dirs=_path_dirs(tool, target)
        )
        save_facts(facts, rt)
        return ToolResult(tool, "downloaded", version=pin.version)
    except Exception as exc:  # noqa: BLE001 — per-tool isolation is the contract
        logger.warning("provisioning %s failed: %s", tool, exc)
        return ToolResult(tool, "failed", detail=str(exc))


def provision_tool(
    tool: str,
    runtime_dir: Path | None = None,
    install_root: Path | None = None,
    target: str | None = None,
) -> ToolResult:
    """Provision a single pinned tool.

    Used by the self-heal paths that need exactly one runtime (the
    managed-Node bootstrap) without paying for a full sweep.
    """
    rt = runtime_dir if runtime_dir is not None else get_runtime_dir()
    rt.mkdir(parents=True, exist_ok=True)
    entry = load_pins(install_root).get(tool)
    if entry is None:
        return ToolResult(tool, "failed", detail=f"{tool} is not pinned")
    return _provision_one(tool, entry, rt, load_facts(rt), target or current_target())


def provision_runtimes(
    runtime_dir: Path | None = None,
    install_root: Path | None = None,
    emit: Callable[[dict], None] | None = None,
    target: str | None = None,
    only: list[str] | None = None,
) -> list[ToolResult]:
    """Bring every pinned tool to its pinned version.

    Never raises for a single tool — each failure is recorded and the
    rest proceed (a broken ripgrep download must not kill node).

    When *target* names a platform other than this host, the staged
    binaries cannot be executed here, so the run-the-binary check is
    skipped. That is the desktop cross-build path.
    """
    rt = runtime_dir if runtime_dir is not None else get_runtime_dir()
    rt.mkdir(parents=True, exist_ok=True)
    host = current_target()
    resolved_target = target or host
    pins = load_pins(install_root)
    facts = load_facts(rt)
    results: list[ToolResult] = []

    for tool, entry in pins.items():
        if only and tool not in only:
            continue
        result = _provision_one(
            tool, entry, rt, facts, resolved_target, verify_runs=resolved_target == host
        )
        results.append(result)
        if emit:
            emit(
                {
                    "type": "runtime-tool",
                    "tool": result.tool,
                    "action": result.action,
                    "version": result.version,
                    "detail": result.detail,
                }
            )

    return results


def step_provision_runtimes() -> dict:
    """post_update MACHINE_STEPS entry."""
    results = provision_runtimes()
    failed = [r for r in results if not r.ok]
    return {
        "ok": not failed,
        "tools": {r.tool: r.action for r in results},
        **(
            {"error": "; ".join(f"{r.tool}: {r.detail}" for r in failed)}
            if failed
            else {}
        ),
    }


def main(argv: list[str] | None = None) -> int:
    """``python -m hermes_cli.runtime_provisioner`` — provision into a dir.

    The desktop payload staging shells out to this rather than carrying a
    second implementation of download-and-verify in JavaScript.
    """
    import argparse

    parser = argparse.ArgumentParser(prog="python -m hermes_cli.runtime_provisioner")
    parser.add_argument(
        "--runtime-dir",
        type=Path,
        help="Where to install (default: this install's .hermes-runtime).",
    )
    parser.add_argument(
        "--target",
        help="Pin target to provision, e.g. darwin-arm64 (default: this host). "
        "Cross-target staging skips the run-the-binary check.",
    )
    parser.add_argument(
        "--only", action="append", help="Provision just this tool (repeatable)."
    )
    parser.add_argument("--json", action="store_true", help="Emit JSON lines.")
    ns = parser.parse_args(argv)

    def emit(event: dict) -> None:
        if ns.json:
            print(json.dumps(event), flush=True)
        else:
            version = f" {event['version']}" if event.get("version") else ""
            detail = f" — {event['detail']}" if event.get("detail") else ""
            print(f"  {event['tool']}: {event['action']}{version}{detail}", flush=True)

    results = provision_runtimes(
        runtime_dir=ns.runtime_dir, emit=emit, target=ns.target, only=ns.only
    )
    return 0 if all(r.ok for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
