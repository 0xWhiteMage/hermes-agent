"""Every package.json dependency must be an exact version.

Same supply-chain rationale as the pyproject upper-bound policy, taken
to the stance npm's lockfile model makes cheap: a range specifier
r(``^1.2.3``, ``~1.2.3``, ``>=1``) means ``npm install`` / ``npm update``
can silently float onto a release published five minutes ago, and the
diff that admits it is a lockfile churn nobody reads. Exact versions
make every upgrade an explicit, reviewable one-line change, with
`min-release-age` and the autofix bot handling the update cadence.

Allowed values: exact semver (``1.2.3``, with optional prerelease/build
suffix) and local references (``file:``, ``link:``, ``workspace:``).
Everything else — ranges, tags (``latest``), bare ``*``, remote URLs —
is a finding.

Scans every tracked package.json except fixtures under tests/.
Not autofixable: collapsing a range to a pin changes what installs; the
right pin is the locked version, and choosing it belongs in a reviewed
change, not the bot.
"""

from __future__ import annotations

import json
import re
import subprocess

from lints import REPO_ROOT, Finding, Lint

_DEP_FIELDS = ("dependencies", "devDependencies", "optionalDependencies")
_EXACT_RE = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")
_LOCAL_PREFIXES = ("file:", "link:", "workspace:")


def _tracked_manifests() -> list[str]:
    out = subprocess.run(
        ["git", "ls-files", "package.json", "**/package.json"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
    )
    return [
        p
        for p in dict.fromkeys(out.stdout.split())
        if not p.startswith("tests/")
    ]


def non_exact_deps(manifest: dict) -> list[tuple[str, str, str]]:
    """``(field, name, spec)`` for every non-exact dependency value."""
    problems: list[tuple[str, str, str]] = []
    for field in _DEP_FIELDS:
        for name, spec in (manifest.get(field) or {}).items():
            if not isinstance(spec, str):
                problems.append((field, name, repr(spec)))
                continue
            if spec.startswith(_LOCAL_PREFIXES):
                continue
            if _EXACT_RE.match(spec):
                continue
            problems.append((field, name, spec))
    return problems


def check() -> list[Finding]:
    findings: list[Finding] = []
    for rel in _tracked_manifests():
        try:
            manifest = json.loads((REPO_ROOT / rel).read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        for field, name, spec in non_exact_deps(manifest):
            findings.append(
                Finding(
                    lint_id="packagejson-exact-versions",
                    path=rel,
                    message=(
                        f"{field}.{name} = {spec!r} is not an exact version — "
                        "ranges float onto releases published minutes ago via "
                        "unreviewable lockfile churn. Pin the locked version "
                        "exactly; min-release-age governs the update cadence."
                    ),
                )
            )
    return findings


LINT = Lint(
    id="packagejson-exact-versions",
    description=(
        "package.json dependencies must be exact versions (or file:/link:/"
        "workspace: references), never ranges or tags."
    ),
    severity="blocking",
    autofix=False,
    check=check,
)
