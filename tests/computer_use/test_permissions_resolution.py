"""Computer Use readiness resolves the MANAGED driver, not a PATH lookup.

This file used to assert the opposite shape: that a driver dropped in
``~/.local/bin`` (where the upstream installer put it) was found even
when a thin GUI PATH omitted that directory. cua-driver is a pinned
managed tool now, so the readiness surface and the runtime resolve the
same fact — and a fact carries an absolute path, which is what makes the
thin-PATH class of bug unrepresentable rather than merely handled.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch


def test_status_reports_the_managed_driver(managed_cua_driver, monkeypatch):
    """Readiness agrees with the runtime resolver under an empty PATH."""
    from tools.computer_use import permissions

    # The thin-GUI-PATH case, taken to its limit: nothing on PATH at all.
    monkeypatch.setenv("PATH", "")

    with patch.object(permissions, "_run", return_value=MagicMock(stdout="0.21.0")), \
         patch.object(permissions, "_doctor", return_value={"ok": True, "checks": []}):
        status = permissions.computer_use_status()

    assert status["installed"] is True


def test_status_reports_not_installed_without_a_fact(no_cua_driver):
    """An install that never provisioned the driver reports it honestly."""
    from tools.computer_use import permissions

    status = permissions.computer_use_status()

    assert status["installed"] is False
    assert status["ready"] is None
