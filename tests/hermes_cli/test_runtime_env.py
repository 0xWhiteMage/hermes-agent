"""Tests for installation.env — the single PATH/env assembler."""

import os
import sys

from installation import env as re_mod
from installation import registry as rr


def _provision(tmp_path, name, rel_bin, version="1.0.0", path_dirs=None,
               path_order=None):
    """Create a fake tool binary + record its fact."""
    binary = tmp_path / rel_bin
    binary.parent.mkdir(parents=True, exist_ok=True)
    binary.write_text("#!/bin/sh\n")
    facts = rr.load_facts(tmp_path)
    facts[name] = rr.RuntimeFact(version=version, path=rel_bin, path_dirs=path_dirs)
    rr.save_facts(facts, tmp_path, path_order=path_order)


class TestManagedPathDirs:
    def test_empty_when_unprovisioned(self, tmp_path):
        assert re_mod.managed_path_dirs(tmp_path) == []

    def test_the_recorded_assembly_order_wins_over_insertion_order(self, tmp_path):
        """The order is data the provisioner derived from the pin table,
        not the order facts happened to be written in."""
        order = ["node", "uv"]
        _provision(tmp_path, "uv", "uv/uv", path_order=order)
        _provision(tmp_path, "node", "node/bin/node", path_order=order)

        dirs = re_mod.managed_path_dirs(tmp_path)

        assert dirs == [tmp_path / "node" / "bin", tmp_path / "uv"]

    def test_an_extender_is_assembled_before_what_it_extends(self, tmp_path):
        """npm's dir has to precede node's, or node's bundled npm wins.
        The edge is declared once in the pin table; this asserts the
        assembler honours what was derived from it."""
        pins = {
            "node": {"version": "26.7.0", "files": {}},
            "npm": {"version": "12.0.2", "extends": ["node"], "files": {}},
        }
        order = rr.path_order(pins)
        _provision(tmp_path, "node", "node/bin/node", path_order=order)
        _provision(tmp_path, "npm", "npm/bin/npm", path_order=order)

        dirs = re_mod.managed_path_dirs(tmp_path)

        assert dirs == [tmp_path / "npm" / "bin", tmp_path / "node" / "bin"]

    def test_vanished_binary_contributes_nothing(self, tmp_path):
        _provision(tmp_path, "node", "node/bin/node")
        (tmp_path / "node" / "bin" / "node").unlink()
        assert re_mod.managed_path_dirs(tmp_path) == []

    def test_path_dirs_override_spreads_multiple_dirs(self, tmp_path):
        # PortableGit shape: cmd + bin + usr/bin, fact points at cmd/git.exe.
        for d in ("git/cmd", "git/bin", "git/usr/bin"):
            (tmp_path / d).mkdir(parents=True)
        (tmp_path / "git" / "cmd" / "git.exe").write_text("")
        facts = {
            "git": rr.RuntimeFact(
                version="2.55.0",
                path="git/cmd/git.exe",
                path_dirs=["git/cmd", "git/bin", "git/usr/bin"],
            )
        }
        rr.save_facts(facts, tmp_path)
        dirs = re_mod.managed_path_dirs(tmp_path)
        assert dirs == [
            tmp_path / "git" / "cmd",
            tmp_path / "git" / "bin",
            tmp_path / "git" / "usr" / "bin",
        ]


class TestManagedToolEnv:
    def test_npm_cache_only_when_node_managed(self, tmp_path):
        assert re_mod.managed_tool_env(tmp_path) == {}
        _provision(tmp_path, "node", "node/bin/node")
        env = re_mod.managed_tool_env(tmp_path)
        assert env["npm_config_cache"] == str(tmp_path / "cache" / "npm")

    def test_a_managed_git_exports_the_portable_contract(self, tmp_path):
        # A relocated git resolves helpers/templates/config against its
        # BUILD-time prefix, so the env must point every one of these
        # INSIDE the store entry. Layout is synthetic: the contract is
        # env-assembly behaviour, not the artifact (win32's PortableGit
        # is the one real managed git; POSIX uses the system lane).
        _provision(tmp_path, "git", "git/bin/git")
        root = tmp_path / "git"
        (root / "libexec" / "git-core").mkdir(parents=True)
        (root / "share" / "git-core" / "templates").mkdir(parents=True)
        (root / "etc").mkdir()
        (root / "etc" / "gitconfig").write_text("")
        (root / "ssl").mkdir()
        (root / "ssl" / "cacert.pem").write_text("")

        env = re_mod.managed_tool_env(tmp_path)

        assert env["GIT_EXEC_PATH"] == str(root / "libexec" / "git-core")
        assert env["GIT_TEMPLATE_DIR"] == str(root / "share" / "git-core" / "templates")
        assert env["GIT_CONFIG_SYSTEM"] == str(root / "etc" / "gitconfig")
        assert env["GIT_SSL_CAINFO"] == str(root / "ssl" / "cacert.pem")
        # dugite exports PREFIX on linux only; elsewhere the name is
        # generic enough to collide with unrelated build tooling.
        if sys.platform.startswith("linux"):
            assert env["PREFIX"] == str(root)
        else:
            assert "PREFIX" not in env

    def test_only_the_pieces_that_exist_are_exported(self, tmp_path):
        # Existence-probed per key: a layout without templates must not
        # export a GIT_TEMPLATE_DIR pointing at nothing.
        _provision(tmp_path, "git", "git/bin/git")
        (tmp_path / "git" / "libexec" / "git-core").mkdir(parents=True)

        env = re_mod.managed_tool_env(tmp_path)

        assert env["GIT_EXEC_PATH"] == str(tmp_path / "git" / "libexec" / "git-core")
        assert "GIT_TEMPLATE_DIR" not in env
        assert "GIT_CONFIG_SYSTEM" not in env
        assert "GIT_SSL_CAINFO" not in env

    def test_a_system_git_fact_gets_no_git_env(self, tmp_path):
        # That env is the RELOCATED-git contract. Exporting GIT_EXEC_PATH
        # at a git we do not own breaks it.
        system_git = tmp_path / "usr-bin-git"
        system_git.write_text("#!/bin/sh\n")
        facts = rr.load_facts(tmp_path)
        facts["git"] = rr.RuntimeFact(
            version="2.44.1", path=str(system_git), source="system"
        )
        rr.save_facts(facts, tmp_path)

        env = re_mod.managed_tool_env(tmp_path)

        assert "GIT_EXEC_PATH" not in env
        assert "GIT_SSL_CAINFO" not in env


class TestWithManagedRuntimes:
    def test_prepends_to_path_front(self, tmp_path):
        _provision(tmp_path, "node", "node/bin/node")
        env = re_mod.with_managed_runtimes({"PATH": "/usr/bin"}, tmp_path)
        parts = env["PATH"].split(os.pathsep)
        assert parts[0] == str(tmp_path / "node" / "bin")
        assert parts[-1] == "/usr/bin"

    def test_no_tools_means_untouched_env(self, tmp_path):
        base = {"PATH": "/usr/bin", "FOO": "bar"}
        assert re_mod.with_managed_runtimes(base, tmp_path) == base

    def test_caller_env_not_mutated(self, tmp_path):
        _provision(tmp_path, "node", "node/bin/node")
        base = {"PATH": "/usr/bin"}
        re_mod.with_managed_runtimes(base, tmp_path)
        assert base == {"PATH": "/usr/bin"}

    def test_respects_lowercase_path_key(self, tmp_path):
        # POSIX env vars are case-sensitive but some Windows-shaped
        # callers carry 'Path' — the assembler must extend THAT key, not
        # add a second one.
        _provision(tmp_path, "node", "node/bin/node")
        env = re_mod.with_managed_runtimes({"Path": "C:\\Windows"}, tmp_path)
        assert "PATH" not in env or env.get("Path") is not None
        assert env["Path"].startswith(str(tmp_path / "node" / "bin"))

    def test_tool_env_defaults_do_not_clobber_caller(self, tmp_path):
        _provision(tmp_path, "node", "node/bin/node")
        env = re_mod.with_managed_runtimes(
            {"PATH": "/usr/bin", "npm_config_cache": "/custom"}, tmp_path
        )
        assert env["npm_config_cache"] == "/custom"

    def test_default_env_is_os_environ_copy(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HERMES_RT_SENTINEL", "yes")
        env = re_mod.with_managed_runtimes(None, tmp_path)
        assert env["HERMES_RT_SENTINEL"] == "yes"
