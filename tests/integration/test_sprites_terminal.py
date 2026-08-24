"""Integration tests for the Sprites terminal backend.

Requires SPRITES_TOKEN to be set. Run with:
    TERMINAL_ENV=sprites pytest tests/integration/test_sprites_terminal.py -v
"""

import json
import os
import sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.integration

# Capture the token at import time. The project-wide hermetic conftest
# wipes anything ending in _TOKEN before each test runs, so we save the
# value here and re-inject it via the autouse fixture below.
_SPRITES_TOKEN = os.getenv("SPRITES_TOKEN")
if not _SPRITES_TOKEN:
    pytest.skip("SPRITES_TOKEN not set", allow_module_level=True)

# Import terminal_tool via importlib to avoid tools/__init__.py side effects
import importlib.util

parent_dir = Path(__file__).parent.parent.parent
sys.path.insert(0, str(parent_dir))

spec = importlib.util.spec_from_file_location(
    "terminal_tool", parent_dir / "tools" / "terminal_tool.py"
)
terminal_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(terminal_module)

terminal_tool = terminal_module.terminal_tool
cleanup_vm = terminal_module.cleanup_vm


@pytest.fixture(autouse=True)
def _force_sprites(monkeypatch):
    # Re-inject the token the hermetic conftest deleted.
    monkeypatch.setenv("SPRITES_TOKEN", _SPRITES_TOKEN)
    monkeypatch.setenv("TERMINAL_ENV", "sprites")
    # Match the documented "ephemeral test" default — tests clean up after themselves.
    monkeypatch.setenv("TERMINAL_CONTAINER_PERSISTENT", "false")


@pytest.fixture()
def task_id(request):
    """Unique task_id per test; environment is cleaned up afterwards.

    Cleanup must use the collapsed container key (ordinary ids map to
    "default" in `_resolve_container_task_id`) — the raw id would pop
    nothing and leak the live env across tests.
    """
    tid = f"sprites_test_{request.node.name}"
    yield tid
    from tools.terminal_tool import _resolve_container_task_id
    cleanup_vm(_resolve_container_task_id(tid))


def _run(command, task_id, **kwargs):
    result = terminal_tool(command, task_id=task_id, **kwargs)
    return json.loads(result)


class TestSpritesBasic:
    def test_echo(self, task_id):
        r = _run("echo 'Hello from a Sprite!'", task_id)
        assert r["exit_code"] == 0
        assert "Hello from a Sprite!" in r["output"]

    def test_nonzero_exit(self, task_id):
        r = _run("exit 42", task_id)
        assert r["exit_code"] == 42

    def test_os_info(self, task_id):
        r = _run("uname -a", task_id)
        assert r["exit_code"] == 0
        assert "Linux" in r["output"]

    def test_python_available(self, task_id):
        r = _run("python3 --version || python --version", task_id)
        assert r["exit_code"] == 0
        assert "Python" in r["output"]


class TestSpritesFilesystem:
    def test_write_and_read_file(self, task_id):
        _run("echo 'sprites content' > /tmp/sprites_test.txt", task_id)
        r = _run("cat /tmp/sprites_test.txt", task_id)
        assert r["exit_code"] == 0
        assert "sprites content" in r["output"]

    def test_env_var_persistence(self, task_id):
        _run("export SPRITES_TEST_VAR=heyo", task_id)
        r = _run("echo $SPRITES_TEST_VAR", task_id)
        assert r["exit_code"] == 0
        assert "heyo" in r["output"]


class TestSpritesIdentity:
    def test_runs_inside_a_sprite(self, task_id):
        """Output should confirm we're in a Sprite, not on the host."""
        r = _run("sprite-env info 2>/dev/null || echo MISSING", task_id)
        assert r["exit_code"] == 0
        if "MISSING" in r["output"]:
            pytest.skip("sprite-env CLI not present inside the Sprite")
        # Terminal-tool's `_resolve_container_task_id` collapses every
        # incoming task_id to "default", and the Sprite name is then scoped by
        # the active Hermes profile via `_resolve_sprite_name` (see the unit
        # tests in tests/tools/test_sprites_environment.py::TestSpriteNaming).
        # Assert against the resolved name for whatever profile this run is in,
        # rather than hard-coding "hermes-default".
        from tools.environments.sprites import _resolve_sprite_name
        expected_name = _resolve_sprite_name("default")
        assert expected_name in r["output"]
        # Sanity: the boot_id from inside the Sprite must differ from this
        # process's view (i.e. command did NOT run on the host).
        host_boot = open("/proc/sys/kernel/random/boot_id").read().strip()
        r2 = _run("cat /proc/sys/kernel/random/boot_id", task_id)
        assert host_boot not in r2["output"]


class TestSpritesPersistence:
    def test_filesystem_survives_session_recycle(self):
        """Write a marker, tear down the env, resume — file should still be there.

        NOTE: `_resolve_container_task_id` collapses ordinary task ids to
        "default", so `_active_environments` keys the live env under
        "default" — NOT under the raw task string. `cleanup_vm(<raw task>)`
        would pop nothing (a vacuous recycle that silently reuses the same
        in-memory env object). Tear down via the collapsed key so the second
        _run genuinely re-creates the environment and resumes the Sprite by
        name over the API.
        """
        task = "sprites_test_persist"
        from tools.terminal_tool import _resolve_container_task_id
        env_key = _resolve_container_task_id(task)
        try:
            os.environ["TERMINAL_CONTAINER_PERSISTENT"] = "true"
            _run("echo 'survive' > /tmp/sprites_persist.txt", task)

            # Prove the env actually lives under the collapsed key, then
            # recycle it. persistent=true → the Sprite itself stays alive.
            from tools.terminal_tool import _active_environments
            assert env_key in _active_environments, (
                f"env registered under {list(_active_environments)}, "
                f"expected key {env_key!r}"
            )
            first_env = _active_environments[env_key]
            cleanup_vm(env_key)
            assert env_key not in _active_environments

            r = _run("cat /tmp/sprites_persist.txt", task)
            assert r["exit_code"] == 0
            assert "survive" in r["output"]
            # And the read ran in a NEW environment object (a real resume,
            # not a lingering reference to the old one).
            assert _active_environments.get(env_key) is not first_env
        finally:
            os.environ["TERMINAL_CONTAINER_PERSISTENT"] = "false"
            cleanup_vm(env_key)  # force-delete on the way out
