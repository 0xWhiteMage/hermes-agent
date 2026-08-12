"""Tests for hermes_cli.runtime_provisioner — the decision core.

No network: downloads are faked by monkeypatching the per-tool installers
and the salvage probe. What we prove is the CONTRACT: keep/salvage/
download/fail decisions, per-tool failure isolation, fact recording, and
the post_update step registration.
"""

import json
from pathlib import Path

import pytest

from hermes_cli import runtime_provisioner as rp
from hermes_cli import runtime_registry as rr


@pytest.fixture
def pins(tmp_path, monkeypatch):
    """A minimal pins file + runtime dir, node-only by default."""

    def _write(tools: dict) -> Path:
        (tmp_path / "runtime-pins.json").write_text(
            json.dumps({"schemaVersion": 1, "tools": tools})
        )
        return tmp_path

    return _write


def _fake_installer(runtime_dir: Path, version: str, rel: str):
    binary = runtime_dir / rel
    binary.parent.mkdir(parents=True, exist_ok=True)
    binary.write_text("#!/bin/sh\n")
    return version


class TestProvisionDecisions:
    def test_fresh_install_downloads_and_records(self, pins, tmp_path, monkeypatch):
        root = pins({"node": {"version": "26.x"}})
        monkeypatch.setitem(
            rp._INSTALLERS, "node", lambda rt, spec: _fake_installer(rt, "26.5.1", "node/bin/node")
        )
        monkeypatch.setattr(rp, "_probe_version", lambda b, a=None: "26.5.1")
        results = rp.provision_runtimes(runtime_dir=tmp_path / "rt", install_root=root)
        assert [(r.tool, r.action) for r in results] == [("node", "downloaded")]
        facts = rr.load_facts(tmp_path / "rt")
        assert facts["node"].version == "26.5.1"

    def test_satisfied_fact_is_kept_no_installer_call(self, pins, tmp_path, monkeypatch):
        root = pins({"node": {"version": "26.x"}})
        rt = tmp_path / "rt"
        _fake_installer(rt, "26.5.1", "node/bin/node")
        rr.record_fact("node", "26.5.1", "node/bin/node", runtime_dir=rt)

        def _boom(*a, **kw):
            raise AssertionError("installer must not run for a satisfied pin")

        monkeypatch.setitem(rp._INSTALLERS, "node", _boom)
        results = rp.provision_runtimes(runtime_dir=rt, install_root=root)
        assert [(r.tool, r.action) for r in results] == [("node", "kept")]

    def test_stale_version_reprovisions(self, pins, tmp_path, monkeypatch):
        root = pins({"node": {"version": "26.x"}})
        rt = tmp_path / "rt"
        _fake_installer(rt, "25.0.0", "node/bin/node")
        rr.record_fact("node", "25.0.0", "node/bin/node", runtime_dir=rt)
        monkeypatch.setitem(
            rp._INSTALLERS, "node", lambda r, s: _fake_installer(r, "26.5.1", "node/bin/node")
        )
        monkeypatch.setattr(rp, "_probe_version", lambda b, a=None: "26.5.1")
        results = rp.provision_runtimes(runtime_dir=rt, install_root=root)
        assert results[0].action == "downloaded"
        assert rr.load_facts(rt)["node"].version == "26.5.1"

    def test_one_failure_does_not_stop_others(self, pins, tmp_path, monkeypatch):
        root = pins({"node": {"version": "26.x"}, "ripgrep": {"version": "14.x"}})

        def _fail(rt, spec):
            raise RuntimeError("download exploded")

        monkeypatch.setitem(rp._INSTALLERS, "node", _fail)
        monkeypatch.setitem(
            rp._INSTALLERS, "ripgrep", lambda r, s: _fake_installer(r, "14.1.0", "ripgrep/rg")
        )
        monkeypatch.setattr(rp, "_probe_version", lambda b, a=None: "14.1.0")
        results = rp.provision_runtimes(runtime_dir=tmp_path / "rt", install_root=root)
        by_tool = {r.tool: r for r in results}
        assert not by_tool["node"].ok and "exploded" in by_tool["node"].detail
        assert by_tool["ripgrep"].action == "downloaded"
        # Failed tool is NOT recorded; healthy one is.
        facts = rr.load_facts(tmp_path / "rt")
        assert set(facts) == {"ripgrep"}

    def test_unrunnable_binary_never_recorded(self, pins, tmp_path, monkeypatch):
        root = pins({"node": {"version": "26.x"}})
        monkeypatch.setitem(
            rp._INSTALLERS, "node", lambda r, s: _fake_installer(r, "26.5.1", "node/bin/node")
        )
        monkeypatch.setattr(rp, "_probe_version", lambda b, a=None: None)
        results = rp.provision_runtimes(runtime_dir=tmp_path / "rt", install_root=root)
        assert results[0].action == "failed"
        assert rr.load_facts(tmp_path / "rt") == {}

    def test_git_skipped_off_windows(self, pins, tmp_path, monkeypatch):
        root = pins({"git": {"version": "2.55.x"}})
        monkeypatch.setattr(rp, "_is_windows", lambda: False)
        results = rp.provision_runtimes(runtime_dir=tmp_path / "rt", install_root=root)
        assert [(r.tool, r.action) for r in results] == [("git", "skipped")]

    def test_salvage_moves_legacy_tree(self, pins, tmp_path, monkeypatch):
        root = pins({"node": {"version": "26.x"}})
        legacy_home = tmp_path / "home"
        legacy_node = legacy_home / "node"
        (legacy_node / "bin").mkdir(parents=True)
        (legacy_node / "bin" / "node").write_text("#!/bin/sh\n")
        monkeypatch.setattr(rp, "get_hermes_home", lambda: legacy_home)
        monkeypatch.setattr(rp, "_probe_version", lambda b, a=None: "26.4.0")

        def _boom(*a, **kw):
            raise AssertionError("must salvage, not download")

        monkeypatch.setitem(rp._INSTALLERS, "node", _boom)
        rt = tmp_path / "rt"
        results = rp.provision_runtimes(runtime_dir=rt, install_root=root)
        assert results[0].action == "salvaged"
        assert (rt / "node" / "bin" / "node").is_file()
        assert not legacy_node.exists()  # moved, not copied

    def test_unsatisfying_legacy_tree_left_alone(self, pins, tmp_path, monkeypatch):
        root = pins({"node": {"version": "26.x"}})
        legacy_home = tmp_path / "home"
        legacy_node = legacy_home / "node"
        (legacy_node / "bin").mkdir(parents=True)
        (legacy_node / "bin" / "node").write_text("#!/bin/sh\n")
        monkeypatch.setattr(rp, "get_hermes_home", lambda: legacy_home)
        # Legacy probes at 22 (unsatisfying); download provides 26.
        probes = {"first": True}

        def _probe(binary, args=None):
            if "home" in str(binary):
                return "22.0.0"
            return "26.5.1"

        monkeypatch.setattr(rp, "_probe_version", _probe)
        monkeypatch.setitem(
            rp._INSTALLERS, "node", lambda r, s: _fake_installer(r, "26.5.1", "node/bin/node")
        )
        results = rp.provision_runtimes(runtime_dir=tmp_path / "rt", install_root=root)
        assert results[0].action == "downloaded"
        assert legacy_node.exists()  # untouched for doctor/uninstall

    def test_emit_streams_stage_json_events(self, pins, tmp_path, monkeypatch):
        root = pins({"node": {"version": "26.x"}})
        monkeypatch.setitem(
            rp._INSTALLERS, "node", lambda r, s: _fake_installer(r, "26.5.1", "node/bin/node")
        )
        monkeypatch.setattr(rp, "_probe_version", lambda b, a=None: "26.5.1")
        events = []
        rp.provision_runtimes(
            runtime_dir=tmp_path / "rt", install_root=root, emit=events.append
        )
        assert events and events[0]["type"] == "runtime-tool"
        assert events[0]["tool"] == "node" and events[0]["action"] == "downloaded"


class TestStepRegistration:
    def test_step_is_registered_in_machine_steps(self):
        from hermes_cli import post_update

        names = [name for name, _fn in post_update.MACHINE_STEPS]
        assert "provision_runtimes" in names

    def test_step_result_shape(self, pins, tmp_path, monkeypatch):
        root = pins({"node": {"version": "26.x"}})
        monkeypatch.setattr(rp, "get_runtime_dir", lambda: tmp_path / "rt")
        monkeypatch.setattr(
            rp, "load_pins", lambda install_root=None: rr.load_pins(root)
        )
        monkeypatch.setitem(
            rp._INSTALLERS, "node", lambda r, s: _fake_installer(r, "26.5.1", "node/bin/node")
        )
        monkeypatch.setattr(rp, "_probe_version", lambda b, a=None: "26.5.1")
        result = rp.step_provision_runtimes()
        assert result["ok"] is True
        assert result["tools"] == {"node": "downloaded"}
