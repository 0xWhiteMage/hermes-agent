"""Behavioral tests for the project-wide lint registry and runner.

Covers the contracts, not the current lint inventory (no change-detector
assertions on which lints exist):

- discovery loads modules, rejects broken/duplicate ones loudly
- the severity policy (gating rules) in ``run.py``
- fixers are bounded by their declared ``fix_touches`` globs
- review_status output matches the assembler's contract shape
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from lints import Finding, Lint, discover  # noqa: E402
from lints import run as lint_run  # noqa: E402


def _lint(**overrides) -> Lint:
    defaults = dict(
        id="demo",
        description="demo lint",
        severity="blocking",
        autofix=False,
        check=lambda: [],
    )
    defaults.update(overrides)
    return Lint(**defaults)


# ── Lint dataclass invariants ────────────────────────────────────────────


def test_autofix_requires_fix_and_globs():
    with pytest.raises(ValueError, match="requires a fix callable"):
        _lint(autofix=True, fix_touches=("*.txt",))
    with pytest.raises(ValueError, match="requires fix_touches"):
        _lint(autofix=True, fix=lambda: [])
    with pytest.raises(ValueError, match="fix provided but autofix=False"):
        _lint(fix=lambda: [])
    # Valid combination constructs fine.
    _lint(autofix=True, fix=lambda: [], fix_touches=("*.txt",))


def test_invalid_severity_rejected():
    with pytest.raises(ValueError, match="severity"):
        _lint(severity="fatal")


# ── Discovery ────────────────────────────────────────────────────────────


def _write_lint_module(directory: Path, name: str, lint_id: str) -> None:
    (directory / f"{name}.py").write_text(
        "from lints import Lint\n"
        f"LINT = Lint(id={lint_id!r}, description='x', severity='advisory',"
        " autofix=False, check=lambda: [])\n",
        encoding="utf-8",
    )


def test_discover_loads_modules_and_skips_private(tmp_path):
    _write_lint_module(tmp_path, "aaa", "aaa")
    _write_lint_module(tmp_path, "bbb", "bbb")
    _write_lint_module(tmp_path, "_helper", "never-loaded")
    (tmp_path / "__init__.py").write_text("", encoding="utf-8")
    (tmp_path / "run.py").write_text("", encoding="utf-8")

    lints = discover(tmp_path)
    assert [lint.id for lint in lints] == ["aaa", "bbb"]


def test_discover_rejects_module_without_LINT(tmp_path):
    (tmp_path / "broken.py").write_text("x = 1\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="defines no top-level LINT"):
        discover(tmp_path)


def test_discover_rejects_duplicate_ids(tmp_path):
    _write_lint_module(tmp_path, "one", "same-id")
    _write_lint_module(tmp_path, "two", "same-id")
    with pytest.raises(RuntimeError, match="duplicate lint ids"):
        discover(tmp_path)


def test_discover_propagates_import_errors(tmp_path):
    (tmp_path / "crash.py").write_text("raise RuntimeError('boom')\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="boom"):
        discover(tmp_path)


def test_real_lint_directory_discovers_cleanly():
    """The shipped lint modules must always import and register."""
    lints = discover()
    assert len(lints) >= 1
    assert len({lint.id for lint in lints}) == len(lints)


# ── Severity policy (the one rule) ───────────────────────────────────────


def _finding(fixable: bool = False) -> Finding:
    return Finding(lint_id="demo", message="m", path="f.py", fixable=fixable)


def test_blocking_unfixable_gates():
    assert lint_run.gates(_lint(severity="blocking"), _finding()) is True


def test_blocking_fixable_is_advisory_at_pr_time():
    lint = _lint(
        severity="blocking", autofix=True, fix=lambda: [], fix_touches=("*.py",)
    )
    assert lint_run.gates(lint, _finding(fixable=True)) is False
    # A finding the fixer can't resolve still gates even on an autofix lint.
    assert lint_run.gates(lint, _finding(fixable=False)) is True


def test_advisory_never_gates():
    assert lint_run.gates(_lint(severity="advisory"), _finding()) is False


def test_network_lints_never_gate_on_pr():
    lint = _lint(severity="blocking", network=True)
    assert lint_run.gates(lint, _finding()) is False


# ── Check isolation ──────────────────────────────────────────────────────


def test_crashing_lint_reports_error_without_hiding_others():
    def _boom():
        raise RuntimeError("kaput")

    ok = _lint(id="ok", check=lambda: [_finding()])
    bad = _lint(id="bad", check=_boom)
    results, errors = lint_run.run_checks([bad, ok])
    assert len(results) == 1  # the healthy lint's finding survived
    assert len(errors) == 1 and "kaput" in errors[0]


# ── Fixer bounds ─────────────────────────────────────────────────────────


def test_fix_outside_declared_globs_is_an_error():
    lint = _lint(
        id="oob",
        autofix=True,
        fix=lambda: ["etc/passwd"],
        fix_touches=("**/.npmrc",),
    )
    changed, errors = lint_run.run_fixes([lint])
    assert changed == ["etc/passwd"]
    assert any("outside its declared" in e for e in errors)


def test_fix_inside_declared_globs_is_clean():
    lint = _lint(
        id="ok-fix",
        autofix=True,
        fix=lambda: ["website/.npmrc"],
        fix_touches=("**/.npmrc",),
    )
    changed, errors = lint_run.run_fixes([lint])
    assert changed == ["website/.npmrc"]
    assert errors == []


def test_crashing_fixer_reports_error():
    def _boom():
        raise RuntimeError("fix kaput")

    lint = _lint(id="bad-fix", autofix=True, fix=_boom, fix_touches=("*.py",))
    changed, errors = lint_run.run_fixes([lint])
    assert changed == []
    assert any("fix kaput" in e for e in errors)


# ── review_status contract ───────────────────────────────────────────────


def test_review_status_shape_and_kinds():
    blocking = _lint(id="hard")
    fixable = _lint(
        id="soft", severity="blocking", autofix=True, fix=lambda: [],
        fix_touches=("*.py",),
    )
    results = [
        (blocking, _finding()),
        (fixable, _finding(fixable=True)),
    ]
    payload = lint_run.to_review_status(results, ["runner exploded"])

    assert len(payload) == 1
    entry = payload[0]
    assert entry["source"] == lint_run.REVIEW_SOURCE
    kinds = [r["kind"] for r in entry["results"]]
    # gating finding -> action_required; fixable -> warning; error -> action_required
    assert kinds == ["action_required", "warning", "action_required"]
    for result in entry["results"]:
        assert set(result) <= {"kind", "title", "summary", "detail", "how_to_fix", "link"}
        assert result["title"] and result["summary"]
    # The auto-fixed finding says so.
    assert "auto-fixed on merge" in entry["results"][1]["summary"]


def test_review_status_empty_when_clean():
    assert lint_run.to_review_status([], []) == []
