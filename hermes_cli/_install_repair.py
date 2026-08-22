"""Dependency install execution shared between early recovery and full recovery.

Both callers need to run the same core ``.[all]`` reinstall:

- ``hermes_cli._early_recovery.recover_if_needed`` — stdlib-only, runs BEFORE
  ``hermes_cli.main``'s third-party imports, so it can complete a pending
  update while no native extension is mapped yet (#83569).
- ``hermes_cli.main._recover_core_update_marker_locked`` — the historical
  post-import recovery path. Kept as a fallback for installs the early pass
  could not complete (marker left in place on failure).

This module is deliberately **stdlib-only** so importing it can never fail in
the corrupted-venv state it exists to repair. ``hermes_cli.main`` imports
``managed_uv``, ``hermes_constants``, and friends only in its late path; the
early path must not. Where the late path uses ``managed_uv.ensure_uv`` to
bootstrap uv if missing, the early path uses the stdlib
:func:`hermes_cli._early_recovery._find_uv_binary` lookup and falls back to
plain pip when uv is absent — a degraded but working installer (the late
recovery will bootstrap uv on the next launch if it ever matters).
"""

from __future__ import annotations

import contextlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

# Single source of truth for the recovery-lock lifecycle and uv lookup —
# _early_recovery already owns both, and importing it is free (stdlib-only).
from hermes_cli import _early_recovery as _er


def _is_windows() -> bool:
    return sys.platform == "win32"


def _is_termux_env(env: dict | None = None) -> bool:
    """Stdlib Termux probe (hermes_cli.main's version lives behind imports)."""
    env = env if env is not None else os.environ
    try:
        if env.get("TERMUX_VERSION"):
            return True
        prefix = env.get("PREFIX", "")
        return "com.termux" in prefix
    except Exception:
        return False


@contextlib.contextmanager
def _stdout_to_stderr():
    """Route fd 1 (and sys.stdout) to stderr for the duration of an install.

    ``hermes acp`` speaks JSON-RPC on stdout; an inherited-fd install child
    writing there would corrupt the protocol. Mirrors
    ``main.py::_recover_from_interrupted_install``.
    """
    saved_fd = None
    saved_sys_stdout = sys.stdout
    try:
        saved_fd = os.dup(1)
        os.dup2(2, 1)
    except OSError:
        saved_fd = None
    sys.stdout = sys.stderr
    try:
        yield
    finally:
        sys.stdout = saved_sys_stdout
        if saved_fd is not None:
            try:
                os.dup2(saved_fd, 1)
            except OSError:
                pass
            try:
                os.close(saved_fd)
            except OSError:
                pass


def _resolve_install_target(root: Path) -> tuple[list[str], dict | None]:
    """(install_cmd_prefix, env) for the project venv — stdlib uv lookup.

    Mirrors ``main.py::_default_venv_install_target`` but without
    ``managed_uv``. ``VIRTUAL_ENV`` steers ``uv pip`` at the project venv even
    when invoked from the base interpreter (the early-recovery case).
    Termux strips leaked interpreter-path env vars so uv resolves the venv
    correctly.
    """
    uv_bin = _er._find_uv_binary()
    if uv_bin:
        from hermes_constants import project_venv_dir

        env = {**os.environ, "VIRTUAL_ENV": str(project_venv_dir(root) or root / "venv")}
        if _is_termux_env(env):
            env.pop("PYTHONPATH", None)
            env.pop("PYTHONHOME", None)
        return [uv_bin, "pip"], env
    return [sys.executable, "-m", "pip"], None


def _venv_scripts_dir(root: Path) -> Path | None:
    """Project venv Scripts/bin dir, when present. stdlib-only."""
    # hermes_constants is stdlib-only, so the canonical layout helpers are safe
    # to use from this corrupted-venv repair path (#76105: never open-code
    # the Scripts/bin split).
    from hermes_constants import project_venv_dir, venv_bin_dir

    venv_dir = project_venv_dir(root)
    if venv_dir is None:
        return None

    scripts = venv_bin_dir(venv_dir, windows=_is_windows())
    return scripts if scripts.is_dir() else None


#: Launcher exes install.ps1's Set-PathVariable stages into ``<root>\bin`` —
#: the only directory the Windows installer puts on the user PATH. Keep in
#: lockstep with the launcher list in scripts/install.ps1.
_WINDOWS_BIN_LAUNCHERS = ("hermes.exe", "hermes-acp.exe")


def _normalize_windows_path(value) -> str:
    """Windows path equality key: backslashes, no trailing separator, lowered.

    Lowercase via ``.lower()`` (what ``ntpath.normcase`` does) rather than
    ``os.path.normcase`` — that is an identity function on POSIX, and this
    comparison must behave Windows-correct even when tests exercise the
    Windows branch from another host (same rationale as
    ``venv_bin_dir(windows=...)``).
    """
    return str(value).replace("/", "\\").rstrip("\\").lower()


def _windows_user_path_entries() -> list[str]:
    """User PATH entries from the registry — the value install.ps1 writes.

    Falls back to the process PATH when the registry is unreadable. Only
    called on Windows.
    """
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
            raw, _kind = winreg.QueryValueEx(key, "Path")
        value = os.path.expandvars(str(raw))
    except (OSError, ImportError):
        value = os.environ.get("PATH", "")
    return [entry for entry in value.split(";") if entry.strip()]


def ensure_windows_bin_launchers(
    root,
    *,
    windows: bool | None = None,
    user_path_entries: list[str] | None = None,
) -> list[str]:
    """Re-stage the ``<root>\\bin`` launcher exes when they vanish.

    On Windows, ``hermes`` resolves through COPIES of the venv console
    scripts that install.ps1 stages into a dedicated ``<root>\\bin`` and puts
    on the user PATH — never ``venv\\Scripts`` itself, which would shadow the
    user's ``python`` (#83797). Those copies are untracked files inside the
    git checkout, so ``hermes update``'s pre-update autostash (``git stash
    push --include-untracked``) swept them off disk; once the desktop updater
    stopped re-applying stashes (``--keep-stash``) nothing ever restored
    them, and ``hermes`` stopped resolving in every new terminal.

    Heals only installs that opted into the bin layout: ``<root>\\bin`` must
    already be on the user PATH (registry value, process PATH as fallback).
    Source checkouts that never ran install.ps1 are left untouched. Copies go
    through a staging name + ``os.replace`` so concurrent process starts
    cannot tear a launcher. Never raises; returns the names it restored.

    *windows* and *user_path_entries* are injectable for tests, same pattern
    as ``hermes_constants.venv_bin_dir``.
    """
    if windows is None:
        windows = _is_windows()
    if not windows:
        return []

    root = Path(root)
    bin_dir = root / "bin"

    # Cheap gate first — this runs at every hermes_cli.main process start
    # (right after the profile override), so the healthy path must stay at a
    # couple of stat calls.
    missing = [name for name in _WINDOWS_BIN_LAUNCHERS if not (bin_dir / name).exists()]
    if not missing:
        return []

    # Consent gate before touching anything else: only installs whose bin
    # dir is already on the user PATH opted into the install.ps1 layout.
    # Compared as normalized literal strings — the installer writes the long
    # literal path, and realpath'ing arbitrary PATH entries here could hang
    # on dead network shares. A registry entry stored some other way (8.3
    # short path, subst drive) misses the heal, which fails safe: no-op.
    if user_path_entries is None:
        user_path_entries = _windows_user_path_entries()
    configured = {_normalize_windows_path(entry) for entry in user_path_entries}
    if _normalize_windows_path(bin_dir) not in configured:
        return []

    from hermes_constants import project_venv_dir, venv_bin_dir

    venv_dir = project_venv_dir(root)
    if venv_dir is None:
        return []
    scripts_dir = venv_bin_dir(venv_dir, windows=windows)
    sources = [(name, scripts_dir / name) for name in missing if (scripts_dir / name).is_file()]
    if not sources:
        return []

    try:
        bin_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        return []

    import shutil

    restored: list[str] = []
    for name, source in sources:
        staging = bin_dir / f"{name}.heal.{os.getpid()}"
        try:
            shutil.copy2(source, staging)
            os.replace(staging, bin_dir / name)
            restored.append(name)
        except OSError:
            with contextlib.suppress(OSError):
                staging.unlink()
    if restored:
        # Guarded like everything else in this never-raises helper: a
        # closed/broken stderr must not turn a successful heal into a crash.
        with contextlib.suppress(OSError, ValueError):
            print(
                f"  ✓ Restored hermes launcher(s) in {bin_dir}: " + ", ".join(restored),
                file=sys.stderr,
            )
    return restored


def _load_console_script_names(root: Path) -> list[str]:
    """``[project.scripts]`` names from pyproject.toml (tomllib, 3.11+)."""
    try:
        import tomllib
    except ImportError:  # pragma: no cover
        return []
    pyproject = root / "pyproject.toml"
    if not pyproject.is_file():
        return []
    try:
        with open(pyproject, "rb") as f:
            data = tomllib.load(f)
        scripts = data.get("project", {}).get("scripts", {}) or {}
        return [str(name) for name in scripts if name]
    except Exception:
        return []


def _quarantine_running_hermes_exe(scripts_dir: Path) -> list[tuple[Path, Path]]:
    """Rename live hermes*.exe shims aside so the installer can rewrite them.

    Windows blocks REPLACE on a running .exe but allows RENAME. Best-effort:
    silently skips anything that cannot be renamed. Returns (original,
    quarantined) pairs. stdlib-only — the console-script set comes from
    pyproject ``[project.scripts]`` (fallback: the well-known trio).
    """
    if not _is_windows():
        return []
    names = set(_load_console_script_names(scripts_dir.parent.parent)) or {
        "hermes",
        "hermes-agent",
        "hermes-acp",
    }
    names.add("hermes-gateway")
    moved: list[tuple[Path, Path]] = []
    for name in sorted(names):
        shim = scripts_dir / f"{name}.exe"
        if not shim.exists():
            continue
        quarantined = shim.with_name(f"{name}.exe.old.{int(time.time() * 1000)}")
        try:
            os.rename(shim, quarantined)
            moved.append((shim, quarantined))
        except OSError:
            pass
    return moved


def _restore_quarantined_exes(moved: list[tuple[Path, Path]]) -> None:
    """Put quarantined shims back when the installer did not replace them."""
    for original, quarantined in moved:
        if original.exists():
            continue  # installer wrote a fresh shim — the .old one is garbage
        try:
            os.rename(quarantined, original)
        except OSError:
            pass


def _run_install_cmd(cmd: list[str], *, env: dict | None, root: Path) -> None:
    """Run an install command with quarantine protection for venv shims.

    Raises CalledProcessError on install failure (callers implement the
    per-extra fallback ladder).
    """
    scripts_dir = _venv_scripts_dir(root) if _is_windows() else None
    moved = _quarantine_running_hermes_exe(scripts_dir) if scripts_dir else []
    try:
        subprocess.run(cmd, cwd=root, check=True, env=env)
    finally:
        # Restore runs on success AND failure: a SUCCESSFUL install can still
        # skip the entry-points step entirely (uv audits an already-satisfied
        # editable install as a no-op and rewrites nothing), which would leave
        # the quarantined shims renamed aside and `hermes` gone from PATH
        # (#75584). _restore_quarantined_exes only renames back when the
        # installer did NOT write a fresh shim, so this is safe in both cases.
        if scripts_dir is not None:
            _restore_quarantined_exes(moved)


def _load_installable_optional_extras(root: Path, group: str) -> list[str]:
    """Optional extras referenced by a dependency group (all / termux-all)."""
    try:
        import tomllib

        with (root / "pyproject.toml").open("rb") as handle:
            project = tomllib.load(handle).get("project", {})
    except Exception:
        return []
    optional_deps = project.get("optional-dependencies", {})
    if not isinstance(optional_deps, dict):
        return []
    refs = optional_deps.get(group, [])
    referenced: list[str] = []
    for ref in refs:
        if "[" in ref and "]" in ref:
            name = ref.split("[", 1)[1].split("]", 1)[0]
            if name in optional_deps:
                referenced.append(name)
    return referenced


def run_core_install(root: Path) -> None:
    """Full core ``.[all]`` editable reinstall — the recovery install.

    Equal in behavior to the install half of
    ``main.py::_recover_core_update_marker_locked``:

    - bootstrap pip via ensurepip (a killed install can leave the venv with no
      pip module at all)
    - prefer ``uv pip`` with VIRTUAL_ENV pointed at the project venv; fall back
      to ``python -m pip`` when no uv binary is available
    - target ``.[all]`` (or ``.[termux-all]`` on Termux) with the per-extra
      fallback ladder when the combined extras resolve fails
    - quarantine live ``hermes*.exe`` shims on Windows so they can be replaced
    - route ALL install output to stderr (acp/JSON-RPC safety)
    - Termux strips leaked PYTHONPATH/PYTHONHOME from the uv env

    Raises ``subprocess.CalledProcessError`` when even the base install fails;
    callers own marker lifecycle (clear on success, keep on failure).
    """
    prefix, env = _resolve_install_target(root)
    group = "termux-all" if _is_termux_env(env) else "all"

    with _stdout_to_stderr():
        try:
            subprocess.run(
                [sys.executable, "-m", "ensurepip", "--upgrade", "--default-pip"],
                cwd=root,
                capture_output=True,
            )
        except Exception:
            pass

        try:
            _run_install_cmd(
                prefix + ["install", "-e", f".[{group}]"], env=env, root=root
            )
            return
        except subprocess.CalledProcessError:
            print(
                "  ⚠ Optional extras failed, reinstalling base dependencies "
                "and retrying extras individually..."
            )

        _run_install_cmd(prefix + ["install", "-e", "."], env=env, root=root)

        failed_extras: list[str] = []
        installed_extras: list[str] = []
        for extra in _load_installable_optional_extras(root, group):
            try:
                _run_install_cmd(
                    prefix + ["install", "-e", f".[{extra}]"], env=env, root=root
                )
                installed_extras.append(extra)
            except subprocess.CalledProcessError:
                failed_extras.append(extra)
        if installed_extras:
            print(
                "  ✓ Reinstalled optional extras individually: "
                + ", ".join(installed_extras)
            )
        if failed_extras:
            print(
                "  ⚠ Skipped optional extras that still failed: "
                + ", ".join(failed_extras)
            )


# ---------------------------------------------------------------------------
# Marker metadata (attempt counter for early-pass retry backoff)
# ---------------------------------------------------------------------------


def bump_marker_attempts(marker_path: Path) -> int:
    """Increment an attempts counter stored inside the marker file.

    The marker's existence is the signal; opportunistic JSON body carries the
    retry count so a persistently failing install can back off instead of
    reinstall-hammering every launch. Corrupt/missing bodies restart at 1.
    Returns the new attempt count. Never raises.
    """
    attempts = 0
    try:
        raw = marker_path.read_text(encoding="utf-8", errors="replace").strip()
        if raw:
            try:
                attempts = int(json.loads(raw).get("attempts", 0))
            except (ValueError, AttributeError):
                attempts = 0
    except OSError:
        attempts = 0
    attempts += 1
    try:
        marker_path.write_text(json.dumps({"attempts": attempts}), encoding="utf-8")
    except OSError:
        pass
    return attempts
