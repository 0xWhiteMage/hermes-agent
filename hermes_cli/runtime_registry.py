"""Install-scoped runtime tool registry.

The single source of truth for which tool versions THIS install of Hermes
manages and where they live. Two files, one owner each:

- ``<repo>/runtime-pins.json`` — the PINS. What versions the code wants.
  Versioned in the repo, code-reviewed, updated with the code that needs
  them.
- ``<install>/.hermes-runtime/runtimes.json`` — the FACTS. What is
  actually installed: resolved version, path relative to the runtime dir,
  install timestamp. Written ONLY by the provisioner
  (``post_update.step_provision_runtimes``); everything else reads.

Readers (locators, the PATH assembler, doctor, uninstall) consume facts
through this module instead of probing paths. No path literals anywhere
else — that scatter is exactly what this replaces.

Design doc: ``.hermes/plans/2026-08-12_hermes-home-lifetime-split.md``.

Pure logic (spec parsing, satisfaction checks, facts round-trip) lives in
this module with no side effects beyond explicit ``save_facts`` calls, so
it is fully unit-testable without a network or a real install.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from hermes_constants import get_install_root, get_runtime_dir

PINS_FILENAME = "runtime-pins.json"
FACTS_FILENAME = "runtimes.json"
FACTS_SCHEMA_VERSION = 1

__all__ = [
    "FACTS_FILENAME",
    "FACTS_SCHEMA_VERSION",
    "PINS_FILENAME",
    "RuntimeFact",
    "VersionSpec",
    "facts_path",
    "load_facts",
    "load_pins",
    "parse_version",
    "record_fact",
    "save_facts",
    "satisfies",
    "tool_bin_dir",
    "tool_path",
]


# ─── version specs ──────────────────────────────────────────────────────────


@dataclass(frozen=True)
class VersionSpec:
    """A parsed pin spec.

    Shapes (the full supported grammar — anything else raises):
      - exact:        ``2.97.0``   → ==2.97.0
      - minor-floor:  ``2.55.x``   → >=2.55, <2.56
      - major-floor:  ``26.x``     → >=26, <27
      - floor-only:   ``>=0.12``   → >=0.12
    """

    raw: str
    floor: tuple[int, ...]
    ceiling: Optional[tuple[int, ...]]  # exclusive; None = unbounded
    exact: bool = False


_SPEC_RE = re.compile(r"^(?P<floor>>=)?(?P<nums>\d+(?:\.\d+)*)(?P<wild>\.x)?$")


def _bump_last(nums: tuple[int, ...]) -> tuple[int, ...]:
    return nums[:-1] + (nums[-1] + 1,)


def parse_spec(spec: str) -> VersionSpec:
    """Parse a pin spec string. Raises ``ValueError`` on anything outside
    the supported grammar — an unreadable pin is a build/config bug, never
    something to guess around."""
    m = _SPEC_RE.match(spec.strip())
    if not m:
        raise ValueError(f"unsupported version spec: {spec!r}")
    nums = tuple(int(n) for n in m.group("nums").split("."))
    if m.group("wild"):
        if m.group("floor"):
            raise ValueError(f"unsupported version spec (>= with .x): {spec!r}")
        return VersionSpec(raw=spec, floor=nums, ceiling=_bump_last(nums))
    if m.group("floor"):
        return VersionSpec(raw=spec, floor=nums, ceiling=None)
    return VersionSpec(raw=spec, floor=nums, ceiling=None, exact=True)


def parse_version(version: str) -> tuple[int, ...]:
    """Parse a resolved version string ('2.55.0.3', 'v26.5.1') to a tuple.

    Tolerates a leading ``v`` and trailing non-numeric segments
    ('2.53.0-4098283' → (2, 53, 0)); tool banners are messy, pins are not.
    """
    cleaned = version.strip().lstrip("vV")
    parts: list[int] = []
    for chunk in cleaned.split("."):
        m = re.match(r"^\d+", chunk)
        if not m:
            break
        parts.append(int(m.group(0)))
    if not parts:
        raise ValueError(f"unparseable version: {version!r}")
    return tuple(parts)


def _cmp(a: tuple[int, ...], b: tuple[int, ...]) -> int:
    # Tuple compare with zero-padding: 2.55 == 2.55.0.
    width = max(len(a), len(b))
    pa = a + (0,) * (width - len(a))
    pb = b + (0,) * (width - len(b))
    return (pa > pb) - (pa < pb)


def satisfies(version: str, spec: str | VersionSpec) -> bool:
    """Does a resolved version satisfy a pin spec?"""
    parsed_spec = parse_spec(spec) if isinstance(spec, str) else spec
    v = parse_version(version)
    if parsed_spec.exact:
        return _cmp(v, parsed_spec.floor) == 0
    if _cmp(v, parsed_spec.floor) < 0:
        return False
    if parsed_spec.ceiling is not None and _cmp(v, parsed_spec.ceiling) >= 0:
        return False
    return True


# ─── pins (repo-owned, read-only here) ──────────────────────────────────────


def pins_path(install_root: Path | None = None) -> Path:
    root = install_root if install_root is not None else get_install_root()
    return root / PINS_FILENAME


def load_pins(install_root: Path | None = None) -> dict[str, dict]:
    """Load the repo's pin table: tool name → pin entry (with 'version').

    Raises on missing/malformed file: the pins ship with the code, so
    absence means a broken install, not a fresh one.
    """
    path = pins_path(install_root)
    data = json.loads(path.read_text(encoding="utf-8"))
    tools = data.get("tools")
    if not isinstance(tools, dict) or not tools:
        raise ValueError(f"{path}: no 'tools' table")
    for name, entry in tools.items():
        if not isinstance(entry, dict) or "version" not in entry:
            raise ValueError(f"{path}: tool {name!r} has no version pin")
        parse_spec(entry["version"])  # validate eagerly — fail at load, not use
    return tools


# ─── facts (install-owned, provisioner-written) ─────────────────────────────


@dataclass
class RuntimeFact:
    """One installed tool as recorded in runtimes.json."""

    version: str
    path: str  # RELATIVE to the runtime dir (relocatable artifact)
    installed_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )

    def to_json(self) -> dict:
        return {"version": self.version, "path": self.path, "installedAt": self.installed_at}

    @classmethod
    def from_json(cls, data: dict) -> "RuntimeFact":
        return cls(
            version=data["version"],
            path=data["path"],
            installed_at=data.get("installedAt", ""),
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
