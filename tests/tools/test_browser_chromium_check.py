"""Tests for Chromium-presence detection in browser_tool.

Regression guard for the "browser tool advertised but Chromium missing"
class of bug — where ``agent-browser`` CLI is discoverable but no
Chromium build is on disk, causing every browser_* tool call to hang
for the full command timeout before surfacing a useless error.

The engine is a pinned tool now, so presence is a question about the
pin table and one explicit override. The directory-name scan of
``~/.cache/ms-playwright`` that used to answer here is gone: it
accepted any ``chromium-*`` name, so whatever revision an unrelated
``npx playwright install`` happened to leave behind decided which
browser Hermes drove.
"""

import pytest

from installation import browser as ib
from tools import browser_tool as bt


@pytest.fixture(autouse=True)
def _reset_chromium_cache():
    bt._cached_chromium_installed = None
    yield
    bt._cached_chromium_installed = None


@pytest.fixture
def no_managed_engine(monkeypatch):
    """No staged pin, and no override, unless a test adds one."""
    monkeypatch.setattr(ib, "_managed", lambda tool: None)
    monkeypatch.delenv(ib.ENGINE_OVERRIDE_ENV, raising=False)


class TestChromiumInstalled:
    def test_plain_chromium_on_path_is_not_an_engine(self, no_managed_engine, monkeypatch, tmp_path):
        """A PATH Chrome is not the pinned engine, so it does not answer.

        It is an unpinned build behind a driver pinned to one revision,
        and that pair is what the pin table corrects.
        """
        for name in ("google-chrome", "chromium", "chromium-browser", "chrome"):
            binary = tmp_path / name
            binary.write_text("#!/bin/sh\n")
            binary.chmod(0o755)
        monkeypatch.setenv("PATH", str(tmp_path))

        assert bt._chromium_installed() is False

    def test_stray_playwright_cache_is_not_an_engine(
        self, no_managed_engine, monkeypatch, tmp_path
    ):
        """An unpinned cache directory does not answer either.

        This is the rung that made the suite depend on host state: a
        developer machine with ``~/.cache/ms-playwright/chromium-1208``
        reported an engine that no fact backed.
        """
        cache = tmp_path / "ms-playwright"
        (cache / "chromium-1187").mkdir(parents=True)
        (cache / "chromium_headless_shell-1187").mkdir()
        monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(cache))

        assert bt._chromium_installed() is False

    def test_staged_pin_is_an_engine(self, monkeypatch, tmp_path):
        staged = tmp_path / "chrome"
        staged.write_text("#!/bin/sh\n")
        monkeypatch.delenv(ib.ENGINE_OVERRIDE_ENV, raising=False)
        monkeypatch.setattr(
            ib, "_managed", lambda tool: staged if tool == "chromium" else None
        )

        assert bt._chromium_installed() is True

    def test_explicit_override_is_an_engine(self, no_managed_engine, monkeypatch, tmp_path):
        """The one honored override. Docker resolves its own Chromium into
        this variable at boot, and a user who sets it has named the browser
        they mean."""
        override = tmp_path / "chrome"
        override.write_text("#!/bin/sh\n")
        monkeypatch.setenv(ib.ENGINE_OVERRIDE_ENV, str(override))

        assert bt._chromium_installed() is True

    def test_result_cached(self, no_managed_engine, monkeypatch, tmp_path):
        override = tmp_path / "chrome"
        override.write_text("#!/bin/sh\n")
        monkeypatch.setenv(ib.ENGINE_OVERRIDE_ENV, str(override))
        assert bt._chromium_installed() is True
        # Delete after the first call — the cached True still answers.
        override.unlink()
        assert bt._chromium_installed() is True


class TestCheckBrowserRequirementsChromium:

    def test_local_mode_with_chromium_returns_true(self, monkeypatch, tmp_path):
        monkeypatch.setattr(bt, "_is_camofox_mode", lambda: False)
        monkeypatch.setattr(bt, "_find_agent_browser", lambda **_kw: "/usr/local/bin/agent-browser")
        monkeypatch.setattr(bt, "_get_cloud_provider", lambda: None)
        staged = tmp_path / "chrome"
        staged.write_text("#!/bin/sh\n")
        monkeypatch.setenv(ib.ENGINE_OVERRIDE_ENV, str(staged))

        assert bt.check_browser_requirements() is True

    def test_camofox_mode_does_not_require_chromium(self, no_managed_engine, monkeypatch):
        monkeypatch.setattr(bt, "_is_camofox_mode", lambda: True)
        # Even with no chromium on disk, camofox drives its own backend.
        assert bt.check_browser_requirements() is True
