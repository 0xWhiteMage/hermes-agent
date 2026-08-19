"""#89556 (gateway half) — multiplex default profile must not capture a poisoned home.

``_make_default_profile_message_handler`` runs at adapter-setup time, in the
same startup pass that configures secondary profile adapters. It used to
capture ``get_hermes_home()`` at handler-construction time; if a secondary
profile's context-local override happened to be active at that instant, the
DEFAULT profile served every turn from that other profile's home (config,
skills, SOUL, terminal.cwd) until the next gateway restart.

The fix resolves the home per event via ``get_process_hermes_home()``, which
by definition ignores the context-local override.
"""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from gateway.config import GatewayConfig


class TestDefaultProfileHandlerHomeResolution:
    @pytest.mark.asyncio
    async def test_construction_under_secondary_override_still_scopes_to_process_home(
        self, tmp_path, monkeypatch
    ):
        """Reproduce the poisoned instant: a secondary profile's contextvar
        override is active while the default-profile handler factory runs.
        The handler must still scope events to the PROCESS home."""
        from hermes_constants import (
            reset_hermes_home_override,
            set_hermes_home_override,
        )
        from gateway.run import GatewayRunner

        process_home = tmp_path / "hermes-root"
        process_home.mkdir()
        secondary_home = tmp_path / "profiles" / "medicina"
        secondary_home.mkdir(parents=True)
        monkeypatch.setenv("HERMES_HOME", str(process_home))

        runner = GatewayRunner.__new__(GatewayRunner)
        runner.config = GatewayConfig(multiplex_profiles=True)

        seen_homes = []

        async def _handle_message(_event):
            from hermes_constants import get_hermes_home

            seen_homes.append(Path(get_hermes_home()))
            return "ok"

        runner._handle_message = _handle_message  # type: ignore[method-assign]

        # The poisoned instant: factory runs while another profile's
        # context-local override is active (startup ordering hazard).
        token = set_hermes_home_override(str(secondary_home))
        try:
            handler = runner._primary_message_handler()
        finally:
            reset_hermes_home_override(token)

        result = await handler(SimpleNamespace(source=SimpleNamespace(profile=None)))

        assert result == "ok"
        assert seen_homes == [process_home], (
            "default-profile turns must run under the process home, not the "
            "profile scope that happened to be active when the handler was "
            "constructed (#89556)"
        )

    @pytest.mark.asyncio
    async def test_handler_scopes_each_event_from_process_env(
        self, tmp_path, monkeypatch
    ):
        """Even with a clean construction, the home must be re-resolved per
        event from the process env — never frozen at factory time."""
        from gateway.run import GatewayRunner

        home_a = tmp_path / "home-a"
        home_a.mkdir()
        home_b = tmp_path / "home-b"
        home_b.mkdir()
        monkeypatch.setenv("HERMES_HOME", str(home_a))

        runner = GatewayRunner.__new__(GatewayRunner)
        runner.config = GatewayConfig(multiplex_profiles=True)

        seen_homes = []

        async def _handle_message(_event):
            from hermes_constants import get_hermes_home

            seen_homes.append(Path(get_hermes_home()))
            return "ok"

        runner._handle_message = _handle_message  # type: ignore[method-assign]
        handler = runner._primary_message_handler()

        event = SimpleNamespace(source=SimpleNamespace(profile=None))
        await handler(event)
        # A profile switch that re-points the process env (hard re-home) must
        # be honored by the very next event.
        monkeypatch.setenv("HERMES_HOME", str(home_b))
        await handler(event)

        assert seen_homes == [home_a, home_b]
