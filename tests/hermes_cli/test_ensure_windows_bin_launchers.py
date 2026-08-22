"""``hermes`` must survive the update autostash on Windows (bin launcher heal).

install.ps1 stages COPIES of the venv console scripts into ``<root>\\bin`` and
puts only THAT directory on the user PATH (#83797 — ``venv\\Scripts`` on PATH
shadows the user's ``python``). Those copies are untracked files inside the
git checkout, so ``hermes update``'s autostash (``git stash push
--include-untracked``) swept them off disk; with the desktop updater's
``--keep-stash`` nothing restored them and ``hermes`` stopped resolving in
every new terminal.

``ensure_windows_bin_launchers`` is the self-heal. The platform verdict and
the user-PATH value are injected parameters (same pattern as
``hermes_constants.venv_bin_dir(windows=...)``), so these tests are
host-independent input→output checks, not host fakes.
"""

from pathlib import Path

from hermes_cli._install_repair import (
    _WINDOWS_BIN_LAUNCHERS,
    _normalize_windows_path,
    ensure_windows_bin_launchers,
)


def _make_install(tmp_path: Path, *, launchers: bool = True) -> Path:
    """Fake install.ps1 layout: <root>/venv/Scripts with console scripts."""
    root = tmp_path / "hermes-agent"
    scripts = root / "venv" / "Scripts"
    scripts.mkdir(parents=True)
    if launchers:
        for name in _WINDOWS_BIN_LAUNCHERS:
            (scripts / name).write_bytes(b"MZ console script: " + name.encode())
    return root


def _bin_on_path(root: Path) -> list[str]:
    return [str(root / "bin"), r"C:\Windows\system32"]


def test_restores_all_missing_launchers(tmp_path):
    root = _make_install(tmp_path)

    restored = ensure_windows_bin_launchers(
        root, windows=True, user_path_entries=_bin_on_path(root)
    )

    assert sorted(restored) == sorted(_WINDOWS_BIN_LAUNCHERS)
    for name in _WINDOWS_BIN_LAUNCHERS:
        assert (root / "bin" / name).read_bytes() == (
            root / "venv" / "Scripts" / name
        ).read_bytes()


def test_restores_only_the_missing_launcher(tmp_path):
    root = _make_install(tmp_path)
    bin_dir = root / "bin"
    bin_dir.mkdir()
    keeper = bin_dir / "hermes.exe"
    keeper.write_bytes(b"existing copy, not rewritten")

    restored = ensure_windows_bin_launchers(
        root, windows=True, user_path_entries=_bin_on_path(root)
    )

    assert restored == ["hermes-acp.exe"]
    assert keeper.read_bytes() == b"existing copy, not rewritten"


def test_noop_when_all_launchers_present(tmp_path):
    root = _make_install(tmp_path)
    bin_dir = root / "bin"
    bin_dir.mkdir()
    for name in _WINDOWS_BIN_LAUNCHERS:
        (bin_dir / name).write_bytes(b"present")

    assert (
        ensure_windows_bin_launchers(
            root, windows=True, user_path_entries=_bin_on_path(root)
        )
        == []
    )


def test_noop_when_bin_dir_not_on_user_path(tmp_path):
    """A source checkout never ran install.ps1 — leave it alone."""
    root = _make_install(tmp_path)

    restored = ensure_windows_bin_launchers(
        root, windows=True, user_path_entries=[r"C:\Windows\system32"]
    )

    assert restored == []
    assert not (root / "bin").exists()


def test_path_match_tolerates_case_slashes_and_trailing_separator(tmp_path):
    root = _make_install(tmp_path)
    entry = str(root / "bin").upper().replace("\\", "/") + "/"

    restored = ensure_windows_bin_launchers(
        root, windows=True, user_path_entries=[entry]
    )

    assert sorted(restored) == sorted(_WINDOWS_BIN_LAUNCHERS)


def test_noop_without_a_venv(tmp_path):
    root = tmp_path / "hermes-agent"
    root.mkdir()

    assert (
        ensure_windows_bin_launchers(
            root, windows=True, user_path_entries=_bin_on_path(root)
        )
        == []
    )


def test_noop_when_console_scripts_missing(tmp_path):
    """A venv mid-repair has no console scripts — nothing to copy, no error."""
    root = _make_install(tmp_path, launchers=False)

    assert (
        ensure_windows_bin_launchers(
            root, windows=True, user_path_entries=_bin_on_path(root)
        )
        == []
    )


def test_noop_on_posix(tmp_path):
    root = _make_install(tmp_path)

    assert (
        ensure_windows_bin_launchers(
            root, windows=False, user_path_entries=_bin_on_path(root)
        )
        == []
    )


def test_recreates_a_deleted_bin_dir(tmp_path):
    """The autostash sweep removes the whole directory, not just the files."""
    root = _make_install(tmp_path)
    assert not (root / "bin").exists()

    restored = ensure_windows_bin_launchers(
        root, windows=True, user_path_entries=_bin_on_path(root)
    )

    assert sorted(restored) == sorted(_WINDOWS_BIN_LAUNCHERS)
    assert (root / "bin").is_dir()


def test_no_staging_litter_left_behind(tmp_path):
    root = _make_install(tmp_path)

    ensure_windows_bin_launchers(
        root, windows=True, user_path_entries=_bin_on_path(root)
    )

    leftovers = [p.name for p in (root / "bin").iterdir() if ".heal." in p.name]
    assert leftovers == []


def test_normalize_windows_path_equivalences():
    assert (
        _normalize_windows_path(r"C:\Users\Me\AppData\Local\hermes\hermes-agent\bin")
        == _normalize_windows_path("c:/users/me/appdata/local/HERMES/hermes-agent/BIN/")
    )


def test_repo_gitignores_the_bin_launcher_dir():
    """The staged launchers must never be stash-sweepable again.

    ``hermes update`` autostashes with ``git stash push --include-untracked``;
    anything untracked and NOT ignored inside the checkout gets swept off
    disk. Exercises git's real ignore machinery rather than reading
    .gitignore text.
    """
    import subprocess

    repo_root = Path(__file__).resolve().parents[2]
    if not (repo_root / ".git").exists():
        import pytest

        pytest.skip("not running from a git checkout")

    result = subprocess.run(
        ["git", "-C", str(repo_root), "check-ignore", "-q", "bin/hermes.exe"],
        capture_output=True,
    )
    assert result.returncode == 0, (
        "bin/hermes.exe is not gitignored — hermes update's autostash "
        "(--include-untracked) will sweep the Windows PATH launchers off disk"
    )
