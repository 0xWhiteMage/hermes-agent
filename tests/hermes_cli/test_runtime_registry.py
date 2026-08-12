"""Tests for hermes_cli.runtime_registry — exact pins, targets, facts.

Pure logic: no network, no real install. The pin table is EXACT by
design (no ranges, no "resolve latest"), so these assert the shape of
that contract and the eager validation that enforces it.
"""

import json

import pytest

from hermes_cli import runtime_registry as rr


def _pins(tools, schema=rr.PINS_SCHEMA_VERSION):
    return {"schemaVersion": schema, "tools": tools}


def _entry(version="1.2.3", targets=("linux-x64",), sha=None):
    return {
        "version": version,
        "files": {
            t: {
                "url": f"https://example.invalid/{t}/tool-{version}.tar.gz",
                "sha256": sha or ("a" * 64),
            }
            for t in targets
        },
    }


@pytest.fixture
def pin_root(tmp_path):
    """Write a pin table and return the root it lives in."""

    def _write(tools, schema=rr.PINS_SCHEMA_VERSION):
        (tmp_path / rr.PINS_FILENAME).write_text(
            json.dumps(_pins(tools, schema)), encoding="utf-8"
        )
        return tmp_path

    return _write


class TestCurrentTarget:
    def test_reports_a_pin_table_key_for_this_host(self):
        target = rr.current_target()

        platform, _, arch = target.partition("-")
        assert platform in ("darwin", "linux", "win32")
        assert arch in ("arm64", "x64")

    def test_the_host_target_is_pinned_for_every_tool(self):
        """A platform Hermes runs on must have a download for every tool,
        or provisioning silently degrades to system PATH there."""
        target = rr.current_target()

        for tool, entry in rr.load_pins().items():
            assert target in entry["files"], f"{tool} has no {target} download"


class TestPinValidation:
    def test_loads_a_well_formed_table(self, pin_root):
        pins = rr.load_pins(pin_root({"node": _entry("26.7.0")}))

        assert pins["node"]["version"] == "26.7.0"

    def test_rejects_a_foreign_schema_version(self, pin_root):
        with pytest.raises(ValueError, match="schemaVersion"):
            rr.load_pins(pin_root({"node": _entry()}, schema=99))

    def test_rejects_a_missing_version(self, pin_root):
        entry = _entry()
        del entry["version"]

        with pytest.raises(ValueError, match="no exact version"):
            rr.load_pins(pin_root({"node": entry}))

    def test_rejects_a_tool_with_no_files(self, pin_root):
        with pytest.raises(ValueError, match="no 'files' table"):
            rr.load_pins(pin_root({"node": {"version": "1.0.0", "files": {}}}))

    def test_rejects_a_non_https_url(self, pin_root):
        entry = _entry()
        entry["files"]["linux-x64"]["url"] = "http://example.invalid/x.tar.gz"

        with pytest.raises(ValueError, match="https url"):
            rr.load_pins(pin_root({"node": entry}))

    def test_rejects_a_malformed_digest(self, pin_root):
        """A truncated sha256 must fail at LOAD, not halfway through a
        user's first launch."""
        with pytest.raises(ValueError, match="64 hex chars"):
            rr.load_pins(pin_root({"node": _entry(sha="abc123")}))


class TestPinnedFile:
    def test_resolves_url_version_and_digest_for_a_target(self, pin_root):
        root = pin_root({"gh": _entry("2.97.0", ("linux-x64", "darwin-arm64"))})

        pin = rr.pinned_file("gh", "darwin-arm64", install_root=root)

        assert pin.version == "2.97.0"
        assert pin.url.endswith("darwin-arm64/tool-2.97.0.tar.gz")
        assert pin.sha256 == "a" * 64

    def test_filename_comes_from_the_url(self, pin_root):
        root = pin_root({"gh": _entry("2.97.0")})

        assert rr.pinned_file("gh", "linux-x64", install_root=root).filename == (
            "tool-2.97.0.tar.gz"
        )

    def test_unknown_tool_raises(self, pin_root):
        with pytest.raises(KeyError, match="not in the pin table"):
            rr.pinned_file("nope", "linux-x64", install_root=pin_root({"gh": _entry()}))

    def test_unpinned_target_raises_rather_than_guessing(self, pin_root):
        """An unpinned platform is a gap in the table to fill, not a URL
        to construct hopefully."""
        root = pin_root({"gh": _entry(targets=("linux-x64",))})

        with pytest.raises(KeyError, match="no pinned download for darwin-arm64"):
            rr.pinned_file("gh", "darwin-arm64", install_root=root)


class TestRealPinTable:
    """The shipped table, as a contract rather than a snapshot."""

    def test_every_tool_pins_every_supported_target(self):
        expected = {
            "darwin-arm64",
            "darwin-x64",
            "linux-x64",
            "linux-arm64",
            "win32-x64",
            "win32-arm64",
        }

        for tool, entry in rr.load_pins().items():
            assert set(entry["files"]) == expected, tool

    def test_every_download_is_https_with_a_full_digest(self):
        for tool, entry in rr.load_pins().items():
            for target, spec in entry["files"].items():
                assert spec["url"].startswith("https://"), f"{tool}/{target}"
                assert len(spec["sha256"]) == 64, f"{tool}/{target}"
                int(spec["sha256"], 16)  # raises unless it is hex

    def test_no_version_ranges_survive_anywhere(self):
        """Exact pins only: a range would make two builds of one commit
        disagree and need a GitHub API call to resolve."""
        for tool, entry in rr.load_pins().items():
            version = entry["version"]
            assert not version.endswith(".x"), tool
            assert not version.startswith(">="), tool

    def test_digests_are_unique_per_target(self):
        """Copy-paste is the likely failure when hand-editing 30 digests,
        and a duplicated digest means one target downloads the wrong
        file and fails verification."""
        for tool, entry in rr.load_pins().items():
            digests = [spec["sha256"] for spec in entry["files"].values()]
            assert len(digests) == len(set(digests)), tool

    def test_git_ships_the_same_version_from_both_suppliers(self):
        """dugite-native (POSIX) and PortableGit (Windows) are different
        builds of the same git. Letting them drift apart would make git
        behaviour depend on the user's platform."""
        git = rr.load_pins()["git"]

        assert "dugite-native" in git["files"]["darwin-arm64"]["url"]
        assert "PortableGit" in git["files"]["win32-x64"]["url"]
        # One version field covers both — the table cannot express a skew.
        assert git["version"] == "2.53.0"

    def test_windows_git_is_portablegit_not_mingit(self):
        """MinGit omits bash.exe, which the desktop needs
        (find-git-bash.ts). dugite's own windows build omits it too."""
        for target in ("win32-x64", "win32-arm64"):
            url = rr.load_pins()["git"]["files"][target]["url"]
            assert "PortableGit" in url
            assert "MinGit" not in url
