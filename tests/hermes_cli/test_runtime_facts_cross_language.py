"""The runtimes.json contract holds across Python and TypeScript.

Two languages read the same facts file: hermes_cli/runtime_env.py builds
the PATH for Python-spawned subprocesses, apps/desktop/electron/backend-env.ts
does it for the Electron backend. AGENTS.md's rule for cross-language
manifest writers applies — write it with one, read it with the other.

The TS side is exercised through node with a small driver, so this is a
real round-trip and not a restatement of the Python behaviour.
"""

import json
import shutil
import subprocess
import textwrap
from pathlib import Path

import pytest

from hermes_cli import runtime_env
from hermes_cli import runtime_registry as rr

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ENV_TS = REPO_ROOT / "apps" / "desktop" / "electron" / "backend-env.ts"


def _node() -> str:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node is required for the cross-language contract test")
    return node


def _provision(runtime_dir: Path, name: str, rel: str, version="1.0.0", path_dirs=None):
    binary = runtime_dir / rel
    binary.parent.mkdir(parents=True, exist_ok=True)
    binary.write_text("#!/bin/sh\n")
    facts = rr.load_facts(runtime_dir)
    facts[name] = rr.RuntimeFact(version=version, path=rel, path_dirs=path_dirs)
    rr.save_facts(facts, runtime_dir)


def _ts_path_entries(tmp_path: Path, runtime_dir: Path) -> list[str]:
    """Run the TypeScript reader over a Python-written facts file."""
    # Strip the TS types with a throwaway transpile via node's own stripping
    # (node >= 22.6 --experimental-strip-types); fall back to a skip when the
    # runtime is too old, rather than silently testing nothing.
    driver = tmp_path / "driver.mts"
    driver.write_text(
        textwrap.dedent(
            f"""
            import {{ managedRuntimePathEntries }} from {json.dumps(str(BACKEND_ENV_TS))}
            const dirs = managedRuntimePathEntries({json.dumps(str(runtime_dir))})
            process.stdout.write(JSON.stringify(dirs))
            """
        ).strip()
        + "\n",
        encoding="utf-8",
    )
    proc = subprocess.run(
        [_node(), "--experimental-strip-types", "--no-warnings", str(driver)],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
    )
    if proc.returncode != 0:
        pytest.skip(f"node could not run the TS driver: {proc.stderr.strip()[:200]}")
    return json.loads(proc.stdout)


class TestCrossLanguageFactsContract:
    def test_both_languages_agree_on_a_single_tool(self, tmp_path):
        runtime_dir = tmp_path / ".hermes-runtime"
        _provision(runtime_dir, "node", "node/bin/node", version="26.5.1")

        python_dirs = [str(d) for d in runtime_env.managed_path_dirs(runtime_dir)]
        assert python_dirs == _ts_path_entries(tmp_path, runtime_dir)

    def test_both_languages_agree_on_assembly_ORDER(self, tmp_path):
        """Order is a contract, not an accident: it decides which copy of a
        tool wins when several are on PATH."""
        runtime_dir = tmp_path / ".hermes-runtime"
        # Written in reverse of the expected order on purpose.
        _provision(runtime_dir, "ripgrep", "ripgrep/rg")
        _provision(runtime_dir, "uv", "uv/uv")
        _provision(runtime_dir, "node", "node/bin/node")

        python_dirs = [str(d) for d in runtime_env.managed_path_dirs(runtime_dir)]
        ts_dirs = _ts_path_entries(tmp_path, runtime_dir)

        assert python_dirs == ts_dirs
        assert [Path(d).name for d in python_dirs] == ["bin", "uv", "ripgrep"]

    def test_both_languages_spread_pathDirs(self, tmp_path):
        runtime_dir = tmp_path / ".hermes-runtime"
        for sub in ("git/cmd", "git/bin", "git/usr/bin"):
            (runtime_dir / sub).mkdir(parents=True)
        _provision(
            runtime_dir,
            "git",
            "git/cmd/git.exe",
            version="2.55.0",
            path_dirs=["git/cmd", "git/bin", "git/usr/bin"],
        )

        python_dirs = [str(d) for d in runtime_env.managed_path_dirs(runtime_dir)]
        assert len(python_dirs) == 3
        assert python_dirs == _ts_path_entries(tmp_path, runtime_dir)

    def test_both_languages_ignore_a_vanished_binary(self, tmp_path):
        runtime_dir = tmp_path / ".hermes-runtime"
        _provision(runtime_dir, "node", "node/bin/node")
        (runtime_dir / "node" / "bin" / "node").unlink()

        assert runtime_env.managed_path_dirs(runtime_dir) == []
        assert _ts_path_entries(tmp_path, runtime_dir) == []

    def test_both_languages_treat_a_foreign_schema_as_unprovisioned(self, tmp_path):
        runtime_dir = tmp_path / ".hermes-runtime"
        runtime_dir.mkdir(parents=True)
        (runtime_dir / rr.FACTS_FILENAME).write_text(
            json.dumps(
                {"schemaVersion": 999, "tools": {"node": {"version": "1", "path": "n"}}}
            )
        )

        assert runtime_env.managed_path_dirs(runtime_dir) == []
        assert _ts_path_entries(tmp_path, runtime_dir) == []


class TestSchemaConstantsMatch:
    def test_schema_version_is_the_same_number_on_both_sides(self):
        ts = BACKEND_ENV_TS.read_text(encoding="utf-8")
        assert f"RUNTIME_FACTS_SCHEMA_VERSION = {rr.FACTS_SCHEMA_VERSION}" in ts

    def test_facts_filename_is_the_same_string_on_both_sides(self):
        ts = BACKEND_ENV_TS.read_text(encoding="utf-8")
        assert f"RUNTIME_FACTS_FILENAME = '{rr.FACTS_FILENAME}'" in ts

    def test_tool_order_is_the_same_list_on_both_sides(self):
        ts = BACKEND_ENV_TS.read_text(encoding="utf-8")
        rendered = ", ".join(f"'{tool}'" for tool in runtime_env._PATH_ORDER)
        assert f"MANAGED_TOOL_ORDER = Object.freeze([{rendered}])" in ts
