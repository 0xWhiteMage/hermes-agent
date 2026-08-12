"""Tests for hermes_cli.runtime_registry — pins, facts, version specs.

Pure-logic coverage: no network, no real install. The provisioner
(post_update.step_provision_runtimes, phase 1) gets its own tests; here we
prove the vocabulary it speaks.
"""

import json

import pytest

from hermes_cli import runtime_registry as rr


# ─── version spec parsing ───────────────────────────────────────────────────


class TestParseSpec:
    def test_exact(self):
        spec = rr.parse_spec("2.97.0")
        assert spec.exact and spec.floor == (2, 97, 0)

    def test_minor_floor_wildcard(self):
        spec = rr.parse_spec("2.55.x")
        assert not spec.exact
        assert spec.floor == (2, 55) and spec.ceiling == (2, 56)

    def test_major_floor_wildcard(self):
        spec = rr.parse_spec("26.x")
        assert spec.floor == (26,) and spec.ceiling == (27,)

    def test_floor_only(self):
        spec = rr.parse_spec(">=0.12")
        assert spec.floor == (0, 12) and spec.ceiling is None and not spec.exact

    @pytest.mark.parametrize("bad", ["", "abc", "1.2.3-beta", ">=1.x", "^1.2", "~2.3", "*"])
    def test_rejects_unsupported_grammar(self, bad):
        with pytest.raises(ValueError):
            rr.parse_spec(bad)


class TestParseVersion:
    def test_plain(self):
        assert rr.parse_version("26.5.1") == (26, 5, 1)

    def test_leading_v(self):
        assert rr.parse_version("v2.97.0") == (2, 97, 0)

    def test_messy_banner_tail(self):
        # dugite-native tags look like 2.53.0-4098283; PortableGit like
        # 2.55.0.windows.3 — numeric prefix wins, junk tail is dropped.
        assert rr.parse_version("2.53.0-4098283") == (2, 53, 0)
        assert rr.parse_version("2.55.0.windows.3") == (2, 55, 0)

    def test_unparseable_raises(self):
        with pytest.raises(ValueError):
            rr.parse_version("nope")


class TestSatisfies:
    @pytest.mark.parametrize(
        ("version", "spec", "expected"),
        [
            # exact
            ("2.97.0", "2.97.0", True),
            ("2.97.1", "2.97.0", False),
            # minor-floor: >=2.55, <2.56
            ("2.55.0", "2.55.x", True),
            ("2.55.9", "2.55.x", True),
            ("2.56.0", "2.55.x", False),
            ("2.54.9", "2.55.x", False),
            # major-floor: >=26, <27
            ("26.0.0", "26.x", True),
            ("26.5.1", "26.x", True),
            ("27.0.0", "26.x", False),
            ("25.9.0", "26.x", False),
            # floor-only
            ("0.12.0", ">=0.12", True),
            ("0.12", ">=0.12", True),
            ("1.0.0", ">=0.12", True),
            ("0.11.9", ">=0.12", False),
            # zero-padding: 2.55 == 2.55.0
            ("2.55", "2.55.x", True),
        ],
    )
    def test_matrix(self, version, spec, expected):
        assert rr.satisfies(version, spec) is expected


# ─── pins ───────────────────────────────────────────────────────────────────


class TestLoadPins:
    def test_real_repo_pins_load_and_validate(self):
        # The shipped runtime-pins.json must always parse: every entry has
        # a version whose spec is inside the supported grammar. Invariant,
        # not a snapshot — no tool names or versions asserted.
        pins = rr.load_pins()
        assert len(pins) >= 1
        for entry in pins.values():
            rr.parse_spec(entry["version"])

    def test_missing_pins_is_an_error(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            rr.load_pins(tmp_path)

    def test_malformed_pins_raise(self, tmp_path):
        (tmp_path / rr.PINS_FILENAME).write_text('{"tools": {}}')
        with pytest.raises(ValueError, match="no 'tools' table"):
            rr.load_pins(tmp_path)

    def test_pin_without_version_raises(self, tmp_path):
        (tmp_path / rr.PINS_FILENAME).write_text(json.dumps({"tools": {"node": {}}}))
        with pytest.raises(ValueError, match="no version pin"):
            rr.load_pins(tmp_path)

    def test_pin_with_bad_spec_fails_at_load(self, tmp_path):
        (tmp_path / rr.PINS_FILENAME).write_text(
            json.dumps({"tools": {"node": {"version": "^26"}}})
        )
        with pytest.raises(ValueError, match="unsupported version spec"):
            rr.load_pins(tmp_path)


# ─── facts round-trip ───────────────────────────────────────────────────────


class TestFacts:
    def test_missing_facts_is_empty_not_error(self, tmp_path):
        assert rr.load_facts(tmp_path) == {}

    def test_round_trip(self, tmp_path):
        rr.record_fact("node", "26.5.1", "node/bin/node", runtime_dir=tmp_path)
        rr.record_fact("uv", "0.12.1", "uv/uv", runtime_dir=tmp_path)
        facts = rr.load_facts(tmp_path)
        assert set(facts) == {"node", "uv"}
        assert facts["node"].version == "26.5.1"
        assert facts["node"].path == "node/bin/node"
        assert facts["node"].installed_at  # stamped

    def test_record_updates_in_place(self, tmp_path):
        rr.record_fact("node", "26.5.1", "node/bin/node", runtime_dir=tmp_path)
        rr.record_fact("node", "26.6.0", "node/bin/node", runtime_dir=tmp_path)
        facts = rr.load_facts(tmp_path)
        assert facts["node"].version == "26.6.0"
        assert len(facts) == 1

    def test_foreign_schema_reads_as_unprovisioned(self, tmp_path):
        (tmp_path / rr.FACTS_FILENAME).write_text(
            json.dumps({"schemaVersion": 999, "tools": {"node": {"version": "1", "path": "x"}}})
        )
        assert rr.load_facts(tmp_path) == {}

    def test_save_is_atomic_no_tmp_residue(self, tmp_path):
        rr.save_facts(
            {"rg": rr.RuntimeFact(version="14.1.0", path="ripgrep/rg")},
            runtime_dir=tmp_path,
        )
        # The invariant is NO temp residue — not sole ownership of the
        # dir (the autouse _isolate_hermes_home fixture plants its own
        # entries inside tmp_path).
        names = [p.name for p in tmp_path.iterdir()]
        assert rr.FACTS_FILENAME in names
        assert not [n for n in names if n.endswith(".tmp")]

    def test_facts_file_shape_matches_design_doc(self, tmp_path):
        # Cross-language contract: backend-env.ts (phase 11) reads this
        # exact shape. Keys are stable API, not incidental.
        rr.record_fact("node", "26.5.1", "node/bin/node", runtime_dir=tmp_path)
        raw = json.loads((tmp_path / rr.FACTS_FILENAME).read_text())
        assert raw["schemaVersion"] == rr.FACTS_SCHEMA_VERSION
        entry = raw["tools"]["node"]
        assert set(entry) == {"version", "path", "installedAt"}


# ─── lookups ────────────────────────────────────────────────────────────────


class TestLookups:
    def test_tool_path_none_when_unprovisioned(self, tmp_path):
        assert rr.tool_path("node", tmp_path) is None
        assert rr.tool_bin_dir("node", tmp_path) is None

    def test_tool_path_resolves_relative_to_runtime_dir(self, tmp_path):
        bin_dir = tmp_path / "node" / "bin"
        bin_dir.mkdir(parents=True)
        (bin_dir / "node").write_text("#!/bin/sh\n")
        rr.record_fact("node", "26.5.1", "node/bin/node", runtime_dir=tmp_path)
        assert rr.tool_path("node", tmp_path) == bin_dir / "node"
        assert rr.tool_bin_dir("node", tmp_path) == bin_dir

    def test_recorded_but_vanished_binary_reads_as_unprovisioned(self, tmp_path):
        # Fact says installed, file is gone (half-deleted runtime dir):
        # readers see None and the provisioner heals on next update —
        # never a path to a nonexistent binary.
        rr.record_fact("node", "26.5.1", "node/bin/node", runtime_dir=tmp_path)
        assert rr.tool_path("node", tmp_path) is None
