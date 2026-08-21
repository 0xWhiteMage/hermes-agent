"""hermes_subprocess_env must apply the managed runtime tool env.

The bug class: _apply_managed_runtime_tool_env (PLAYWRIGHT_BROWSERS_PATH,
the portable-git GIT_EXEC_PATH contract, npm cache redirection) ran only in
_make_run_env — the TERMINAL tool's env builder. The browser worker builds
its env through hermes_subprocess_env instead, so a chromium staged in the
tool store was invisible to it and _maybe_autoinstall_chromium re-downloaded
~170MB already on disk. The two spawn surfaces must agree.
"""

import os
from unittest.mock import patch

import pytest

from installation import registry as rr
from tools.environments.local import hermes_subprocess_env


def _provision(runtime_dir, name, rel_bin, version="1.0.0"):
    """Create a fake tool binary + record its fact (self-contained dir)."""
    binary = runtime_dir / rel_bin
    binary.parent.mkdir(parents=True, exist_ok=True)
    binary.write_text("#!/bin/sh\n")
    facts = rr.load_facts(runtime_dir)
    facts[name] = rr.RuntimeFact(version=version, path=rel_bin)
    rr.save_facts(facts, runtime_dir)


@pytest.fixture
def runtime_dir(tmp_path, monkeypatch):
    """A self-contained runtime dir the spawned-env builders resolve."""
    rt = tmp_path / "runtime"
    rt.mkdir()
    monkeypatch.setenv("HERMES_RUNTIME_DIR", str(rt))
    return rt


class TestManagedToolEnvApplied:
    def test_playwright_browsers_path_reaches_browser_children(self, runtime_dir):
        _provision(
            runtime_dir, "chromium", "chromium-1208/chrome-linux64/chrome",
            version="1208",
        )

        env = hermes_subprocess_env()

        assert env.get("PLAYWRIGHT_BROWSERS_PATH") == str(runtime_dir)

    def test_no_browser_fact_means_no_export(self, runtime_dir):
        env = hermes_subprocess_env()

        assert "PLAYWRIGHT_BROWSERS_PATH" not in env

    def test_caller_value_wins(self, runtime_dir):
        """setdefault semantics: an explicit user/caller value is never
        clobbered by the managed-tools application."""
        _provision(
            runtime_dir, "chromium", "chromium-1208/chrome-linux64/chrome",
            version="1208",
        )

        with patch.dict(os.environ, {"PLAYWRIGHT_BROWSERS_PATH": "/user/own"}):
            env = hermes_subprocess_env()

        assert env["PLAYWRIGHT_BROWSERS_PATH"] == "/user/own"

    def test_matches_terminal_surface(self, runtime_dir):
        """The invariant, not a snapshot: whatever managed_tool_env emits is
        present in BOTH spawn surfaces' output. New keys added to
        managed_tool_env are covered without editing this test."""
        from installation.env import managed_tool_env
        from tools.environments.local import _make_run_env

        _provision(
            runtime_dir, "chromium", "chromium-1208/chrome-linux64/chrome",
            version="1208",
        )
        expected = managed_tool_env()
        assert expected, "fixture must produce at least one managed env key"

        subprocess_surface = hermes_subprocess_env()
        terminal_surface = _make_run_env({})

        for key, value in expected.items():
            assert subprocess_surface.get(key) == value
            assert terminal_surface.get(key) == value
