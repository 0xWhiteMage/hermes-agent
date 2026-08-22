"""Tests for gated Chromium staging on local cold start.

The install is a provisioner call now, not an ``agent-browser install``
shell-out: the pin table records the engine pair as agent-browser's
``requires``, so one provision walks the closure and stages both,
digest-verified, at a revision the pinned driver is known to drive.
"""

import pytest

import tools.browser_tool as bt


@pytest.fixture(autouse=True)
def _reset_state():
    bt._chromium_autoinstall_attempted = False
    bt._cached_chromium_installed = None
    yield
    bt._chromium_autoinstall_attempted = False
    bt._cached_chromium_installed = None


def _no_provision(monkeypatch):
    """Record provision attempts, and make a shell-out impossible to miss."""
    calls = []
    monkeypatch.setattr(
        "installation.browser.provision_driver",
        lambda: calls.append("provision") or False,
    )
    monkeypatch.setattr(
        bt.subprocess, "run",
        lambda *a, **k: calls.append(("subprocess", a, k)),
    )
    return calls


class TestGating:
    def test_disabled_lazy_installs_skips(self, monkeypatch):
        monkeypatch.setattr(bt, "_running_in_docker", lambda: False)
        monkeypatch.setattr(bt, "_allow_browser_lazy_install", lambda: False)
        calls = _no_provision(monkeypatch)
        assert bt._maybe_autoinstall_chromium() is False
        assert calls == []

    def test_docker_skips(self, monkeypatch):
        monkeypatch.setattr(bt, "_running_in_docker", lambda: True)
        calls = _no_provision(monkeypatch)
        assert bt._maybe_autoinstall_chromium() is False
        assert calls == []

    def test_env_kill_switch_is_honoured_even_with_a_lazy_target(self, monkeypatch):
        """The env switch is unconditional for a pinned artifact.

        ``lazy_deps._allow_lazy_installs`` lets a sealed tree through when
        a durable lazy-install target exists, because its subject is a pip
        package no image could have baked. A pinned binary is different: a
        writable package dir says nothing about whether this process may
        pull ~170MB. The test fixture's temp HERMES_HOME reads as sealed,
        so deferring to that helper downloaded a real browser here.
        """
        monkeypatch.setattr(bt, "_running_in_docker", lambda: False)
        monkeypatch.setenv("HERMES_DISABLE_LAZY_INSTALLS", "1")
        monkeypatch.setattr(
            "tools.lazy_deps._lazy_install_target", lambda: "/tmp/lazy-packages"
        )
        calls = _no_provision(monkeypatch)
        assert bt._allow_browser_lazy_install() is False
        assert bt._maybe_autoinstall_chromium() is False
        assert calls == []


class TestInstall:
    def test_success_provisions_the_pinned_pair_and_rechecks(self, monkeypatch):
        monkeypatch.setattr(bt, "_allow_browser_lazy_install", lambda: True)
        monkeypatch.setattr(bt, "_chromium_installed", lambda: True)

        calls = []
        monkeypatch.setattr(
            "installation.browser.provision_driver",
            lambda: calls.append("provision") or True,
        )
        monkeypatch.setattr(
            bt.subprocess, "run",
            lambda *a, **k: calls.append("subprocess"),
        )

        assert bt._maybe_autoinstall_chromium() is True
        # The provisioner, and no shell.
        assert calls == ["provision"]

    def test_failed_provision_returns_false(self, monkeypatch):
        monkeypatch.setattr(bt, "_allow_browser_lazy_install", lambda: True)
        monkeypatch.setattr("installation.browser.provision_driver", lambda: False)
        assert bt._maybe_autoinstall_chromium() is False

    def test_provision_that_lands_nothing_returns_false(self, monkeypatch):
        """A provision reporting success still has to produce an engine."""
        monkeypatch.setattr(bt, "_allow_browser_lazy_install", lambda: True)
        monkeypatch.setattr("installation.browser.provision_driver", lambda: True)
        monkeypatch.setattr(bt, "_chromium_installed", lambda: False)
        assert bt._maybe_autoinstall_chromium() is False


class TestOneShot:
    def test_second_call_does_not_reinstall(self, monkeypatch):
        monkeypatch.setattr(bt, "_allow_browser_lazy_install", lambda: True)
        monkeypatch.setattr(bt, "_chromium_installed", lambda: True)

        runs = []
        monkeypatch.setattr(
            "installation.browser.provision_driver",
            lambda: runs.append(1) or True,
        )

        assert bt._maybe_autoinstall_chromium() is True
        assert bt._maybe_autoinstall_chromium() is True
        assert len(runs) == 1
