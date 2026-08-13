"""Tests for hermes_cli.runtime_provisioner.

The decision core runs against a LOCAL http server serving real archives,
so download → verify → extract → run → record is exercised end to end
without reaching the network. What is asserted is the contract: exact
digests gate everything, a tool that cannot be verified is not recorded,
one tool's failure does not stop the others, and nothing is ever adopted
from disk without verification (there is no salvage).
"""

import hashlib
import json
import tarfile
import threading
import zipfile
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from hermes_cli import runtime_provisioner as rp
from hermes_cli import runtime_registry as rr


@pytest.fixture(scope="module")
def served(tmp_path_factory):
    """Serve a directory of fixture archives over http://127.0.0.1."""
    root = tmp_path_factory.mktemp("served")
    handler = partial(SimpleHTTPRequestHandler, directory=str(root))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield root, f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


def _script(text: str = "#!/bin/sh\necho 'tool 1.2.3'\n") -> bytes:
    return text.encode()


def _make_tar(root: Path, name: str, members: dict[str, bytes]) -> str:
    """Write a .tar.gz of {relative path: bytes}, all executable."""
    staging = root / f".stage-{name}"
    staging.mkdir(parents=True, exist_ok=True)
    for rel, data in members.items():
        target = staging / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        target.chmod(0o755)

    archive = root / name
    with tarfile.open(archive, "w:gz") as tf:
        for rel in members:
            tf.add(staging / rel, arcname=rel)
    return hashlib.sha256(archive.read_bytes()).hexdigest()


def _pins_file(root: Path, tools: dict) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / rr.PINS_FILENAME).write_text(
        json.dumps({"schemaVersion": rr.PINS_SCHEMA_VERSION, "tools": tools}),
        encoding="utf-8",
    )
    return root


@pytest.fixture
def target():
    """Provision for THIS host so the run-the-binary check is exercised."""
    return rr.current_target()


class TestProvisionOneTool:
    def test_downloads_verifies_runs_and_records(self, served, tmp_path, target):
        root, base = served
        sha = _make_tar(root, "gh-ok.tar.gz", {"bin/gh": _script()})
        pins = _pins_file(
            tmp_path / "repo",
            {
                "gh": {
                    "version": "2.97.0",
                    "files": {target: {"url": f"{base}/gh-ok.tar.gz", "sha256": sha}},
                }
            },
        )

        rt = tmp_path / "rt"
        results = rp.provision_runtimes(runtime_dir=rt, install_root=pins)

        assert [(r.tool, r.action, r.version) for r in results] == [
            ("gh", "downloaded", "2.97.0")
        ]
        assert (rt / "gh" / "bin" / "gh").is_file()
        assert rr.load_facts(rt)["gh"].path == "gh/bin/gh"

    def test_second_run_keeps_an_exact_match(self, served, tmp_path, target):
        """Exact pins make this an equality check, not a range check."""
        root, base = served
        sha = _make_tar(root, "gh-keep.tar.gz", {"bin/gh": _script()})
        pins = _pins_file(
            tmp_path / "repo",
            {
                "gh": {
                    "version": "2.97.0",
                    "files": {target: {"url": f"{base}/gh-keep.tar.gz", "sha256": sha}},
                }
            },
        )
        rt = tmp_path / "rt"

        rp.provision_runtimes(runtime_dir=rt, install_root=pins)
        again = rp.provision_runtimes(runtime_dir=rt, install_root=pins)

        assert [r.action for r in again] == ["kept"]

    def test_a_version_bump_reprovisions(self, served, tmp_path, target):
        root, base = served
        sha_old = _make_tar(root, "gh-old.tar.gz", {"bin/gh": _script()})
        sha_new = _make_tar(root, "gh-new.tar.gz", {"bin/gh": _script()})
        repo = tmp_path / "repo"
        rt = tmp_path / "rt"

        _pins_file(repo, {"gh": {"version": "2.97.0", "files": {
            target: {"url": f"{base}/gh-old.tar.gz", "sha256": sha_old}}}})
        rp.provision_runtimes(runtime_dir=rt, install_root=repo)

        _pins_file(repo, {"gh": {"version": "2.98.0", "files": {
            target: {"url": f"{base}/gh-new.tar.gz", "sha256": sha_new}}}})
        results = rp.provision_runtimes(runtime_dir=rt, install_root=repo)

        assert [(r.action, r.version) for r in results] == [("downloaded", "2.98.0")]
        assert rr.load_facts(rt)["gh"].version == "2.98.0"

    def test_nested_archives_are_flattened(self, served, tmp_path, target):
        """node/gh/ripgrep nest under a versioned dir; uv nests on POSIX
        and not on Windows. Flattening keys off the archive's shape, so
        the facts path stays stable either way."""
        root, base = served
        sha = _make_tar(root, "gh-nested.tar.gz", {"gh_2.97.0_linux/bin/gh": _script()})
        pins = _pins_file(tmp_path / "repo", {"gh": {"version": "2.97.0", "files": {
            target: {"url": f"{base}/gh-nested.tar.gz", "sha256": sha}}}})

        rt = tmp_path / "rt"
        rp.provision_runtimes(runtime_dir=rt, install_root=pins)

        assert (rt / "gh" / "bin" / "gh").is_file()


class TestDigestIsTheGate:
    def test_a_mismatched_digest_aborts_before_extracting(
        self, served, tmp_path, target
    ):
        root, base = served
        _make_tar(root, "gh-tampered.tar.gz", {"bin/gh": _script()})
        pins = _pins_file(tmp_path / "repo", {"gh": {"version": "2.97.0", "files": {
            target: {"url": f"{base}/gh-tampered.tar.gz", "sha256": "e" * 64}}}})

        rt = tmp_path / "rt"
        results = rp.provision_runtimes(runtime_dir=rt, install_root=pins)

        assert results[0].action == "failed"
        assert "sha256 mismatch" in (results[0].detail or "")
        # Nothing unpacked, nothing recorded: the bytes were never trusted.
        assert not (rt / "gh").exists()
        assert rr.load_facts(rt) == {}

    def test_a_missing_download_fails_that_tool_only(self, served, tmp_path, target):
        root, base = served
        sha = _make_tar(root, "ok.tar.gz", {"bin/gh": _script()})
        pins = _pins_file(tmp_path / "repo", {
            "gh": {"version": "1.0.0", "files": {
                target: {"url": f"{base}/ok.tar.gz", "sha256": sha}}},
            "ripgrep": {"version": "1.0.0", "files": {
                target: {"url": f"{base}/absent.tar.gz", "sha256": "b" * 64}}},
        })

        rt = tmp_path / "rt"
        results = {r.tool: r.action for r in
                   rp.provision_runtimes(runtime_dir=rt, install_root=pins)}

        # A broken ripgrep download must not stop gh from provisioning.
        assert results == {"gh": "downloaded", "ripgrep": "failed"}
        assert "gh" in rr.load_facts(rt)
        assert "ripgrep" not in rr.load_facts(rt)


class TestScratchCleanupIsNotAFailure:
    """The scratch dir is a convenience, never a gate.

    On Windows the downloaded artifact is routinely still held open when
    cleanup runs: the PortableGit self-extractor outlives its own exit,
    and Defender cannot be disabled on the windows-11-arm image, so it
    scans the .exe. The delete then fails with WinError 5 AFTER the tool
    is already staged and verified. These tests drive the real cleanup
    with a real undeletable file (a read-only parent dir) instead of
    faking the host.
    """

    def test_discarding_an_undeletable_scratch_dir_does_not_raise(self, tmp_path):
        scratch = tmp_path / "scratch"
        scratch.mkdir()
        (scratch / "held-open.exe").write_bytes(b"still open elsewhere")
        scratch.chmod(0o500)  # unlinking a child now raises PermissionError
        try:
            rp._discard_scratch(scratch)
        finally:
            scratch.chmod(0o700)

    def test_an_undeletable_scratch_file_still_provisions(
        self, served, tmp_path, target, monkeypatch
    ):
        root, base = served
        sha = _make_tar(root, "gh-locked.tar.gz", {"bin/gh": _script()})
        pins = _pins_file(tmp_path / "repo", {"gh": {"version": "2.97.0", "files": {
            target: {"url": f"{base}/gh-locked.tar.gz", "sha256": sha}}}})

        real_stage = rp._stage
        locked: list[Path] = []

        def stage_then_lock(tool, pin, dest, tmp, tgt, rt):
            real_stage(tool, pin, dest, tmp, tgt, rt)
            (tmp / "held-open.exe").write_bytes(b"still open elsewhere")
            tmp.chmod(0o500)
            locked.append(tmp)

        monkeypatch.setattr(rp, "_stage", stage_then_lock)

        rt = tmp_path / "rt"
        try:
            results = rp.provision_runtimes(runtime_dir=rt, install_root=pins)
        finally:
            for tmp in locked:
                tmp.chmod(0o700)

        assert [(r.tool, r.action) for r in results] == [("gh", "downloaded")]
        assert (rt / "gh" / "bin" / "gh").is_file()
        assert rr.load_facts(rt)["gh"].version == "2.97.0"


class TestVerificationBeforeRecording:
    def test_an_unrunnable_binary_is_not_recorded(self, served, tmp_path, target):
        """Recording it would tell every reader a broken tool is ready."""
        root, base = served
        sha = _make_tar(root, "gh-broken.tar.gz", {"bin/gh": b"\x00\x01not a program"})
        pins = _pins_file(tmp_path / "repo", {"gh": {"version": "2.97.0", "files": {
            target: {"url": f"{base}/gh-broken.tar.gz", "sha256": sha}}}})

        rt = tmp_path / "rt"
        results = rp.provision_runtimes(runtime_dir=rt, install_root=pins)

        assert results[0].action == "failed"
        assert "does not run" in (results[0].detail or "")
        assert rr.load_facts(rt) == {}

    def test_an_archive_without_the_expected_binary_fails(
        self, served, tmp_path, target
    ):
        root, base = served
        sha = _make_tar(root, "gh-empty.tar.gz", {"README": b"nothing here"})
        pins = _pins_file(tmp_path / "repo", {"gh": {"version": "2.97.0", "files": {
            target: {"url": f"{base}/gh-empty.tar.gz", "sha256": sha}}}})

        rt = tmp_path / "rt"
        results = rp.provision_runtimes(runtime_dir=rt, install_root=pins)

        assert results[0].action == "failed"
        assert "missing after staging" in (results[0].detail or "")


class TestNoSalvage:
    def test_an_unverified_tree_on_disk_is_replaced_not_adopted(
        self, served, tmp_path, target
    ):
        """There is no salvage: adopting bytes nobody verified would
        defeat pinning digests at all."""
        root, base = served
        sha = _make_tar(root, "gh-fresh.tar.gz", {"bin/gh": _script()})
        pins = _pins_file(tmp_path / "repo", {"gh": {"version": "2.97.0", "files": {
            target: {"url": f"{base}/gh-fresh.tar.gz", "sha256": sha}}}})

        rt = tmp_path / "rt"
        squatter = rt / "gh" / "bin" / "gh"
        squatter.parent.mkdir(parents=True)
        squatter.write_text("#!/bin/sh\necho 'impostor 9.9.9'\n")
        squatter.chmod(0o755)

        results = rp.provision_runtimes(runtime_dir=rt, install_root=pins)

        assert results[0].action == "downloaded"
        assert "impostor" not in squatter.read_text()

    def test_the_provisioner_exposes_no_salvage_surface(self):
        for name in dir(rp):
            assert "salvage" not in name.lower()


class TestSelectiveProvisioning:
    def test_only_provisions_the_named_tool(self, served, tmp_path, target):
        root, base = served
        sha = _make_tar(root, "sel.tar.gz", {"bin/gh": _script()})
        pins = _pins_file(tmp_path / "repo", {
            "gh": {"version": "1.0.0", "files": {
                target: {"url": f"{base}/sel.tar.gz", "sha256": sha}}},
            "ripgrep": {"version": "1.0.0", "files": {
                target: {"url": f"{base}/absent.tar.gz", "sha256": "c" * 64}}},
        })

        results = rp.provision_runtimes(
            runtime_dir=tmp_path / "rt", install_root=pins, only=["gh"]
        )

        assert [r.tool for r in results] == ["gh"]


class TestLayout:
    def test_windows_and_posix_binaries_land_where_readers_expect(self):
        assert rp._binary_rel("node", "win32-x64") == "node/node.exe"
        assert rp._binary_rel("node", "linux-x64") == "node/bin/node"
        # Two git suppliers, two layouts.
        assert rp._binary_rel("git", "win32-x64") == "git/cmd/git.exe"
        assert rp._binary_rel("git", "darwin-arm64") == "git/bin/git"
        # npm is installed by npm, which writes .cmd shims in the prefix
        # root on Windows and POSIX shims in bin/.
        assert rp._binary_rel("npm", "win32-x64") == "npm/npm.cmd"
        assert rp._binary_rel("npm", "darwin-arm64") == "npm/bin/npm"

    def test_only_portablegit_needs_extra_path_dirs(self):
        """bash.exe and the coreutils live outside cmd/; every other tool
        is covered by its binary's own directory."""
        assert rp._path_dirs("git", "win32-x64") == [
            "git/cmd",
            "git/bin",
            "git/usr/bin",
        ]
        assert rp._path_dirs("git", "darwin-arm64") is None
        assert rp._path_dirs("node", "win32-x64") is None


class TestExtendsOrdering:
    """`extends` in the pin table drives provisioning order and the
    recorded PATH order — the provisioner never restates either.

    These use gh/ripgrep rather than the real npm/node pair: the edge is
    generic machinery, and naming npm would drag in its bespoke staging
    (which needs a real node) and test two things at once.
    """

    def test_a_tool_is_provisioned_after_what_it_extends(self, served, tmp_path, target):
        """Declared in the wrong order on purpose: the edge decides, not
        the order someone happened to type the entries in."""
        root, base = served
        sha = _make_tar(root, "ordering.tar.gz", {"bin/gh": _script()})
        rg_sha = _make_tar(root, "ordering-rg.tar.gz", {"rg": _script()})
        pins = _pins_file(tmp_path / "repo", {
            "gh": {"version": "1.0.0", "extends": ["ripgrep"], "files": {
                target: {"url": f"{base}/ordering.tar.gz", "sha256": sha}}},
            "ripgrep": {"version": "1.0.0", "files": {
                target: {"url": f"{base}/ordering-rg.tar.gz", "sha256": rg_sha}}},
        })

        results = rp.provision_runtimes(runtime_dir=tmp_path / "rt", install_root=pins)

        assert [r.tool for r in results] == ["ripgrep", "gh"]

    def test_the_recorded_path_order_puts_the_extender_first(
        self, served, tmp_path, target
    ):
        """An extender has to be FOUND before what it extends (npm before
        node, or node's bundled npm wins); readers get that from the
        facts file, not from a list of their own."""
        root, base = served
        sha = _make_tar(root, "recorded.tar.gz", {"bin/gh": _script()})
        rg_sha = _make_tar(root, "recorded-rg.tar.gz", {"rg": _script()})
        pins = _pins_file(tmp_path / "repo", {
            "ripgrep": {"version": "1.0.0", "files": {
                target: {"url": f"{base}/recorded-rg.tar.gz", "sha256": rg_sha}}},
            "gh": {"version": "1.0.0", "extends": ["ripgrep"], "files": {
                target: {"url": f"{base}/recorded.tar.gz", "sha256": sha}}},
        })

        rt = tmp_path / "rt"
        rp.provision_runtimes(runtime_dir=rt, install_root=pins)

        order = rr.load_path_order(rt)
        assert order.index("gh") < order.index("ripgrep")

    def test_an_extender_fails_cleanly_when_what_it_extends_is_absent(
        self, served, tmp_path, target
    ):
        """node failing must not produce a half-installed npm recorded as
        ready — the reader would then put a broken shim on PATH."""
        root, base = served
        pins = _pins_file(tmp_path / "repo", {
            "node": {"version": "1.0.0", "files": {
                target: {"url": f"{base}/absent.tar.gz", "sha256": "d" * 64}}},
            "npm": {"version": "1.0.0", "extends": ["node"], "files": {
                target: {"url": f"{base}/absent.tar.gz", "sha256": "e" * 64}}},
        })

        rt = tmp_path / "rt"
        results = {r.tool: r.action for r in
                   rp.provision_runtimes(runtime_dir=rt, install_root=pins)}

        assert results == {"node": "failed", "npm": "failed"}
        assert rr.load_facts(rt) == {}
