"""Lazy dependency bootstrapper for non-Python runtime deps.

Detection and prompting live here in Python — not in install.sh — because:
  1. shutil.which() works on every platform; install.sh needs bash.
  2. Detection is instant; spawning bash for a "is node installed?" check is waste.
  3. Python controls the UX (rich prompts, non-interactive fallback, TTY detection).

install.sh is still the *installation* backend for deps whose install is
OS package-manager work, because it has 1900 lines of battle-tested OS
detection (apt/brew/pacman/dnf/zypper/…).  Reimplementing that in Python
would be huge duplication.  A dep that is a PINNED tool never reaches a
shell at all: the provisioner stages it digest-verified and records it.

Deps that degrade gracefully (ripgrep → grep fallback, ffmpeg → skip conversion)
don't need ensure_dependency wired in — only hard-fail sites do (TUI needs node,
browser tool needs agent-browser).
"""
from __future__ import annotations

import platform
import shutil
import subprocess
import sys
from pathlib import Path

from tools.environments.local import hermes_subprocess_env

_IS_WINDOWS = platform.system() == "Windows"


def _node_present() -> bool:
    """The pinned node is provisioned at install time; this reports on it."""
    from installation import registry

    return registry.tool_path("node") is not None


_DEP_CHECKS = {
    # The recorded fact rather than a bare which(): the managed tree is not on
    # PATH, so which() would report Node missing on an install that has one and
    # trigger a redundant re-install.
    "node": _node_present,
    "browser": lambda: _agent_browser_resolves() or _has_system_browser(),
    "ripgrep": lambda: shutil.which("rg") is not None,
    "ffmpeg": lambda: shutil.which("ffmpeg") is not None,
}

# Deps whose whole install is "stage this pinned tool". The provisioner
# downloads the exact pinned artifact, verifies its digest before
# extraction, brings up whatever it extends and requires, and records it
# in the install's runtimes.json — so a second ensure_dependency() call
# is a no-op and `hermes update`'s sweep keeps it at the pin from then
# on. Deps NOT listed here still shell out to install.sh/install.ps1,
# which owns the OS package-manager work Python has no business
# restating.
# "browser" maps to the driver, not to a browser engine: the pin table
# records agent-browser as requiring the Chromium pair, so the closure
# walk stages the engine with it.
_PINNED_DEPS = {
    "node": "node",
    "ripgrep": "ripgrep",
    "browser": "agent-browser",
}

_DEP_DESCRIPTIONS = {
    "node": "Node.js (required for browser tools and TUI)",
    "browser": "Browser engine (Chromium, for web browsing tools)",
    "ripgrep": "ripgrep (fast file search)",
    "ffmpeg": "ffmpeg (TTS voice messages)",
}


def _agent_browser_resolves() -> bool:
    """True when the browser driver resolves to anything runnable.

    ONE call into ``tools.browser_tool._find_agent_browser``, which owns
    the whole cascade: the pinned copy from the runtime registry, PATH,
    the managed Node tree, the repo node_modules, and the npx sentinel.
    A check that restates any of those rungs here answers differently
    from the tool it gates — the pinned copy is the proof. Its recorded
    name carries the host target (``agent-browser-linux-x64``), so a
    probe that looks for a file called ``agent-browser`` misses a staged
    driver and reports a successful provision as a failure.

    ``validate=False`` keeps this a cheap existence check: no subprocess
    spawn, and no lazy install (only ``validate=True`` calls back into
    ``ensure_dependency``, so the recursion stays bounded).
    """
    try:
        from tools.browser_tool import _find_agent_browser

        return bool(_find_agent_browser(validate=False))
    except Exception:
        return False


def _has_system_browser() -> bool:
    if _IS_WINDOWS:
        names = ("chrome", "msedge", "chromium")
    else:
        names = ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome")
    for name in names:
        if shutil.which(name):
            return True
    return False


def _find_install_script(
    package_dir: Path | None = None,
    repo_root: Path | None = None,
) -> tuple[Path | None, str | None]:
    """Locate the install script — bundled in wheel or in git checkout.

    On Windows, prefers install.ps1; on POSIX, prefers install.sh.
    Returns a (path, shell) tuple, or (None, None) if neither is found.
    """
    if package_dir is None:
        package_dir = Path(__file__).parent
    if repo_root is None:
        repo_root = package_dir.parent

    if _IS_WINDOWS:
        preferred = ("install.ps1", "powershell")
        fallback = ("install.sh", "bash")
    else:
        preferred = ("install.sh", "bash")
        fallback = ("install.ps1", "powershell")

    for script_name, shell in (preferred, fallback):
        bundled = package_dir / "scripts" / script_name
        if bundled.is_file():
            return bundled, shell
        repo = repo_root / "scripts" / script_name
        if repo.is_file():
            return repo, shell

    return None, None


def ensure_dependency(
    dep: str,
    interactive: bool = True,
) -> bool:
    """Ensure a non-Python dependency is available. Returns True if available."""
    check = _DEP_CHECKS.get(dep)
    if check is None:
        # Unknown dep — don't silently forward to install script.
        return False
    if check():
        return True

    desc = _DEP_DESCRIPTIONS.get(dep, dep)
    if interactive and sys.stdin.isatty():
        try:
            reply = input(f"{desc} is not installed. Install now? [Y/n] ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            return False
        if reply not in ("", "y", "yes"):
            return False

    # A pinned tool needs no shell: the provisioner IS the installer, and
    # it is the same engine the installers and `hermes update` run, so the
    # tool arrives digest-verified and recorded rather than at whatever
    # version a package manager happened to offer. install.sh and
    # install.ps1 reject these names outright, so the shell-out below can
    # never install them.
    pinned = _PINNED_DEPS.get(dep)
    if pinned is not None:
        try:
            from installation.provisioner import provision_tool

            result = provision_tool(pinned)
        except Exception as exc:
            if interactive:
                print(f"  Could not provision {pinned}: {exc}")
            return False
        if not result.provisioned:
            if interactive:
                print(f"  Could not provision {pinned}: {result.detail}")
            return False
        return check()

    script, shell = _find_install_script()
    if script is None:
        if interactive:
            print(f"  {desc} is not installed and no install script was found.")
            print(f"  Install {dep} manually and try again.")
        return False

    if shell == "powershell":
        from hermes_constants import get_hermes_home
        ps_bin = shutil.which("powershell") or shutil.which("pwsh")
        if not ps_bin:
            if interactive:
                print("  PowerShell not found. Install PowerShell or run install.ps1 manually.")
            return False
        cmd = [
            ps_bin,
            "-ExecutionPolicy", "Bypass",
            "-File", str(script),
            "-Ensure", dep,
            "-HermesHome", str(get_hermes_home()),
        ]
    else:
        cmd = ["bash", str(script), "--ensure", dep]

    run_env = hermes_subprocess_env(inherit_credentials=False)
    run_env["IS_INTERACTIVE"] = "false"
    result = subprocess.run(
        cmd,
        env=run_env,
    )
    if result.returncode != 0:
        return False

    return check()
