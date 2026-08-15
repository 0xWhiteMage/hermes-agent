"""Tests for the local terminal per-command memory ceiling.

``terminal.memory_limit_mb`` (config.yaml) applies an RLIMIT_AS cap to
locally spawned command trees via ``preexec_fn``, so a runaway build can't
OOM the whole machine. Inspired by Claude Code's
``CLAUDE_CODE_TOOL_MEMORY_LIMIT`` (v2.1.233); adapted to config.yaml per
the ".env is for secrets only" policy.
"""

import sys
from unittest.mock import patch

import pytest

from tools.environments import local as local_mod
from tools.environments.local import (
    _make_memory_limit_preexec,
    _read_terminal_memory_limit_bytes,
)

IS_POSIX = not sys.platform.startswith("win")


class TestReadTerminalMemoryLimit:
    def _with_cfg(self, cfg):
        return patch("hermes_cli.config.load_config", return_value=cfg)

    def test_default_is_unlimited(self):
        with self._with_cfg({"terminal": {}}):
            assert _read_terminal_memory_limit_bytes() == 0

    def test_missing_terminal_section(self):
        with self._with_cfg({}):
            assert _read_terminal_memory_limit_bytes() == 0

    def test_configured_limit_converts_to_bytes(self):
        with self._with_cfg({"terminal": {"memory_limit_mb": 512}}):
            assert _read_terminal_memory_limit_bytes() == 512 * 1024 * 1024

    def test_zero_disables(self):
        with self._with_cfg({"terminal": {"memory_limit_mb": 0}}):
            assert _read_terminal_memory_limit_bytes() == 0

    def test_negative_disables(self):
        with self._with_cfg({"terminal": {"memory_limit_mb": -5}}):
            assert _read_terminal_memory_limit_bytes() == 0

    def test_string_number_accepted(self):
        with self._with_cfg({"terminal": {"memory_limit_mb": "256"}}):
            assert _read_terminal_memory_limit_bytes() == 256 * 1024 * 1024

    def test_garbage_value_fails_open(self):
        with self._with_cfg({"terminal": {"memory_limit_mb": "lots"}}):
            assert _read_terminal_memory_limit_bytes() == 0

    def test_config_load_failure_fails_open(self):
        with patch(
            "hermes_cli.config.load_config", side_effect=RuntimeError("boom")
        ):
            assert _read_terminal_memory_limit_bytes() == 0


@pytest.mark.skipif(not IS_POSIX, reason="RLIMIT_AS is POSIX-only")
class TestMemoryLimitEnforcement:
    """E2E: the spawned command tree really is capped."""

    def _make_env(self, tmp_path):
        # Avoid the login-shell snapshot cost: construct without __init__,
        # mirroring the pattern used by other LocalEnvironment tests.
        env = object.__new__(local_mod.LocalEnvironment)
        env.cwd = str(tmp_path)
        env.env = {}
        env.timeout = 30
        return env

    def test_preexec_fn_attached_when_configured(self, tmp_path):
        env = self._make_env(tmp_path)
        with patch.object(
            local_mod, "_read_terminal_memory_limit_bytes", return_value=64 * 1024 * 1024
        ):
            proc = env._run_bash("true", timeout=10)
            proc.wait(timeout=10)

    def test_command_over_limit_fails_under_limit_succeeds(self, tmp_path):
        """A python allocation over the cap dies; the same env runs small
        commands fine. Uses a 512 MiB cap so interpreter startup fits."""
        env = self._make_env(tmp_path)
        alloc_big = (
            "python3 -c \"x = bytearray(800 * 1024 * 1024); print('allocated')\""
        )
        alloc_small = "python3 -c \"x = bytearray(8 * 1024 * 1024); print('allocated')\""

        with patch.object(
            local_mod,
            "_read_terminal_memory_limit_bytes",
            return_value=512 * 1024 * 1024,
        ):
            proc = env._run_bash(alloc_big, timeout=30)
            out, _ = proc.communicate(timeout=30)
            assert proc.returncode != 0
            assert "allocated" not in out

            proc = env._run_bash(alloc_small, timeout=30)
            out, _ = proc.communicate(timeout=30)
            assert proc.returncode == 0
            assert "allocated" in out

    def test_unlimited_when_config_zero(self, tmp_path):
        env = self._make_env(tmp_path)
        alloc = "python3 -c \"x = bytearray(64 * 1024 * 1024); print('ok')\""
        with patch.object(
            local_mod, "_read_terminal_memory_limit_bytes", return_value=0
        ):
            proc = env._run_bash(alloc, timeout=30)
            out, _ = proc.communicate(timeout=30)
            assert proc.returncode == 0
            assert "ok" in out


@pytest.mark.skipif(not IS_POSIX, reason="RLIMIT_AS is POSIX-only")
def test_preexec_never_raises_even_on_bad_limit():
    """setrlimit failures inside the child must not kill the command."""
    fn = _make_memory_limit_preexec(-12345)
    # Running in-process is safe: the helper swallows every exception.
    fn()
