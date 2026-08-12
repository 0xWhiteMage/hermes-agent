"""Install-scoped runtime tool registry.

The single source of truth for which tool versions THIS install of Hermes
manages and where they live. Two files, one owner each:

- ``<repo>/runtime-pins.json`` — the PINS. Every tool pins an EXACT
  version plus, per target, the exact download URL and its sha256.
  Versioned in the repo, code-reviewed, updated with the code that needs
  them.
- ``<install>/.hermes-runtime/runtimes.json`` — the FACTS. What is
  actually installed: version, path relative to the runtime dir, install
  timestamp. Written ONLY by the provisioner; everything else reads.

Readers (locators, the PATH assembler, doctor, uninstall) consume facts
through this module instead of probing paths. No path literals anywhere
else — that scatter is exactly what this replaces.

**Exact pins only, by design.** There is no version-range grammar and no
"resolve latest, then check it satisfies a range": that shape needs a
GitHub API call per tool (60 requests/hour unauthenticated), makes two
builds of the same commit disagree, and lets a tool change under users
without a code review. A pin bump is a deliberate edit — new version, new
urls, new digests, verified, committed.

Design doc: ``.hermes/plans/2026-08-12_hermes-home-lifetime-split.md``.

Pure logic (pin/facts parsing, target resolution, round-trip) lives here
with no side effects beyond explicit ``save_facts`` calls, so it is fully
unit-testable without a network or a real install.
"""

from __future__ import annotations

import json
import os
import platform
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from hermes_constants import get_runtime_dir

PINS_FILENAME = "runtime-pins.json"
FACTS_FILENAME = "runtimes.json"
FACTS_SCHEMA_VERSION = 1
PINS_SCHEMA_VERSION = 2

__all__ = [
    "FACTS_FILENAME",
    "FACTS_SCHEMA_VERSION",
    "PINS_FILENAME",
    "PINS_SCHEMA_VERSION",
    "PinnedFile",
    "RuntimeFact",
    "current_target",
    "facts_path",
    "load_facts",
    "load_pins",
    "pinned_file",
    "pins_path",
    "record_fact",
    "save_facts",
    "tool_bin_dir",
    "tool_path",
]


# ─── targets ────────────────────────────────────────────────────────────────


def current_target() -> str:
    """This host as a pin-table target key: ``<platform>-<arch>``.

    Node/Python spellings (darwin|linux|win32 x arm64|x64) so one string
    works on both sides of the JS/Python boundary.
    """
    machine = platform.machine().lower()
    if machine in ("arm64", "aarch64"):
        arch = "arm64"
    elif machine in ("x86_64", "amd64", "x64"):
        arch = "x64"
    else:
        raise RuntimeError(f"unsupported architecture: {platform.machine()}")

    if sys.platform.startswith("win"):
        return f"win32-{arch}"
    if sys.platform == "darwin":
        return f"darwin-{arch}"
    return f"linux-{arch}"


# ─── pins (repo-owned, exact) ───────────────────────────────────────────────


@dataclass(frozen=True)
class PinnedFile:
    """One tool's download for one target: exactly where and exactly what."""

    version: str
    url: str
    sha256: str

    @property
    def filename(self) -> str:
        return self.url.rsplit("/", 1)[-1]

def pins_path(install_root: Path | None = None) -> Path:
    """Path to the repo's pin table.

    Pins ship WITH the code, so the default is this package's parent (the
    repo root for a checkout, the payload's repo/ dir for the desktop
    bundle) rather than ``get_install_root()`` — the install root is where
    tools get INSTALLED, and callers may point it elsewhere.
    """
    if install_root is not None:
        return install_root / PINS_FILENAME
    return Path(__file__).resolve().parent.parent / PINS_FILENAME


# Loopback http is allowed so tests can serve real archives from a local
# server and exercise the true download path. Everything a user ever
# fetches is https: a plain-http pin would let a network attacker choose
# the bytes, and the digest check alone cannot help if the attacker also
# picks which digest you compare against.
_LOOPBACK_PREFIXES = ("http://127.0.0.1:", "http://localhost:", "http://[::1]:")


def _is_allowed_url(url: str) -> bool:
    return url.startswith("https://") or url.startswith(_LOOPBACK_PREFIXES)


def load_pins(install_root: Path | None = None) -> dict[str, dict]:
    """Load the repo's pin table: tool name → entry with version + files.

    Raises on missing/malformed: the pins ship with the code, so absence
    means a broken install, not a fresh one. Validation is eager and
    total — a typo in a digest should fail at load, not halfway through a
    user's first launch.
    """
    path = pins_path(install_root)
    data = json.loads(path.read_text(encoding="utf-8"))

    schema = data.get("schemaVersion")
    if schema != PINS_SCHEMA_VERSION:
        raise ValueError(
            f"{path}: pins schemaVersion {schema!r}, expected {PINS_SCHEMA_VERSION}"
        )

    tools = data.get("tools")
    if not isinstance(tools, dict) or not tools:
        raise ValueError(f"{path}: no 'tools' table")

    for name, entry in tools.items():
        if not isinstance(entry, dict):
            raise ValueError(f"{path}: tool {name!r} is not an object")
        version = entry.get("version")
        if not isinstance(version, str) or not version:
            raise ValueError(f"{path}: tool {name!r} has no exact version")
        files = entry.get("files")
        if not isinstance(files, dict) or not files:
            raise ValueError(f"{path}: tool {name!r} has no 'files' table")
        for target, spec in files.items():
            if not isinstance(spec, dict):
                raise ValueError(f"{path}: {name}/{target} is not an object")
            url = spec.get("url")
            sha256 = spec.get("sha256")
            if not isinstance(url, str) or not _is_allowed_url(url):
                raise ValueError(f"{path}: {name}/{target} needs an https url")
            if not isinstance(sha256, str) or len(sha256) != 64:
                raise ValueError(
                    f"{path}: {name}/{target} sha256 must be 64 hex chars"
                )
    return tools


def pinned_file(
    tool: str,
    target: str | None = None,
    install_root: Path | None = None,
    pins: dict[str, dict] | None = None,
) -> PinnedFile:
    """The exact download for *tool* on *target* (default: this host).

    Raises when the tool or target is not pinned — an unpinned platform is
    a gap in the table to fill, not something to guess a URL for.
    """
    table = pins if pins is not None else load_pins(install_root)
    entry = table.get(tool)
    if entry is None:
        raise KeyError(f"{tool!r} is not in the pin table")

    key = target or current_target()
    spec = entry["files"].get(key)
    if spec is None:
        raise KeyError(f"{tool!r} has no pinned download for {key}")

    return PinnedFile(version=entry["version"], url=spec["url"], sha256=spec["sha256"])


# ─── facts (install-owned, provisioner-written) ─────────────────────────────


@dataclass
class RuntimeFact:
    """One installed tool as recorded in runtimes.json."""

    version: str
    path: str  # RELATIVE to the runtime dir (relocatable artifact)
    installed_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    # Optional override: PATH dirs (relative to the runtime dir) for tools
    # whose surface spans several bin dirs (PortableGit: cmd, bin,
    # usr/bin). When None, the assembler derives the single dir containing
    # `path`.
    path_dirs: Optional[list[str]] = None

    def to_json(self) -> dict:
        data: dict[str, object] = {
            "version": self.version,
            "path": self.path,
            "installedAt": self.installed_at,
        }
        if self.path_dirs is not None:
            data["pathDirs"] = self.path_dirs
        return data

    @classmethod
    def from_json(cls, data: dict) -> "RuntimeFact":
        return cls(
            version=data["version"],
            path=data["path"],
            installed_at=data.get("installedAt", ""),
            path_dirs=data.get("pathDirs"),
        )


def facts_path(runtime_dir: Path | None = None) -> Path:
    base = runtime_dir if runtime_dir is not None else get_runtime_dir()
    return base / FACTS_FILENAME


def load_facts(runtime_dir: Path | None = None) -> dict[str, RuntimeFact]:
    """Load installed-tool facts. Missing file → empty dict (nothing
    provisioned yet — a normal state, unlike missing pins)."""
    path = facts_path(runtime_dir)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    if raw.get("schemaVersion") != FACTS_SCHEMA_VERSION:
        # A foreign/older facts file: treat as unprovisioned. The
        # provisioner rewrites it wholesale; readers never limp along on
        # a shape they don't understand.
        return {}
    return {
        name: RuntimeFact.from_json(entry)
        for name, entry in raw.get("tools", {}).items()
    }


def save_facts(facts: dict[str, RuntimeFact], runtime_dir: Path | None = None) -> Path:
    """Write the facts file atomically (tmp + rename). Provisioner-only."""
    path = facts_path(runtime_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schemaVersion": FACTS_SCHEMA_VERSION,
        "tools": {name: fact.to_json() for name, fact in sorted(facts.items())},
    }
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)
    return path


def record_fact(
    name: str,
    version: str,
    rel_path: str,
    runtime_dir: Path | None = None,
) -> dict[str, RuntimeFact]:
    """Read-modify-write one tool's fact. Returns the updated table."""
    facts = load_facts(runtime_dir)
    facts[name] = RuntimeFact(version=version, path=rel_path)
    save_facts(facts, runtime_dir)
    return facts


# ─── lookups (what locators/assemblers consume) ─────────────────────────────


def tool_path(name: str, runtime_dir: Path | None = None) -> Optional[Path]:
    """Absolute path to a managed tool's binary, or None when not
    provisioned (or recorded but vanished — treat as unprovisioned; the
    provisioner heals on next update)."""
    base = runtime_dir if runtime_dir is not None else get_runtime_dir()
    fact = load_facts(base).get(name)
    if fact is None:
        return None
    candidate = base / fact.path
    if not candidate.is_file():
        return None
    return candidate


def tool_bin_dir(name: str, runtime_dir: Path | None = None) -> Optional[Path]:
    """Directory containing a managed tool's binary — the PATH-assembler
    unit. None when the tool is not provisioned."""
    resolved = tool_path(name, runtime_dir)
    return resolved.parent if resolved is not None else None
