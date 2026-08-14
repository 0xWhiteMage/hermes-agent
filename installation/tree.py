"""Derive who owns the running tree — no stored mode flags.

The install model has two axes (design:
.hermes/plans/2026-08-07_183000-two-axis-install-model.md):

* A tree with ``.git`` is a **git checkout**: ``hermes update`` owns it.
  The checkout's existence IS the fact; no manifest records it.
* A tree without ``.git`` is **sealed**: something external replaces it
  wholesale. The build stamp (``install-stamp.json``) names that
  steward in its ``distribution`` field: ``desktop-app`` (the embedded
  desktop bundle), ``docker``, ``nix``, or a future package manager.

The update channel (``stable`` or ``main``) lives in config.yaml under
``update.channel``. It applies to git checkouts only — sealed trees
version-track through their stewards.

If a future feature writes to user checkouts (nothing does today), it
must add an explicit opt-out fact FIRST. The old ``manageStyle: ejected``
stickiness guarded against desktop-side adoption and rematerialization;
both are deleted, so the guard went with them.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

BUILD_INFO_NAME = "install-stamp.json"

STEWARD_DESKTOP = "desktop-app"
STEWARD_DOCKER = "docker"
STEWARD_NIX = "nix"

# What `hermes update` says in a sealed tree, per steward — THE single
# refusal table (config.format_docker_update_message and the update
# command's docker/nix/desktop-app branches all read it). The fallback
# covers stewards this build does not know (a newer package-manager value
# read by older code).
STEWARD_UPDATE_MESSAGES = {
    STEWARD_DESKTOP: (
        "✗ This Hermes runs from inside the desktop app bundle.\n"
        "\n"
        "Manage updates from within the desktop app.\n"
        "Prefer a self-managed source install? See:\n"
        "  https://hermes-agent.nousresearch.com/docs/user-guide/switching-to-source"
    ),
    STEWARD_DOCKER: """\
✗ ``hermes update`` doesn't apply inside the Docker container.

Hermes Agent runs as a published image (nousresearch/hermes-agent), not a
git checkout — the container has no working tree to pull into.  Update by
pulling a fresh image and restarting your container instead:

  docker pull nousresearch/hermes-agent:latest
  # then restart whatever started the container, e.g.:
  docker compose up -d --force-recreate hermes-agent
  # or, for ad-hoc runs, exit the current container and `docker run` again

Verify the new version after restart:
  docker run --rm nousresearch/hermes-agent:latest --version

Notes:
  • If you pinned a specific tag (e.g. ``:v0.14.0``) the ``:latest`` tag
    won't move your container — pull the newer tag you actually want, or
    switch to ``:latest`` / ``:main`` for rolling updates.  See available
    tags at https://hub.docker.com/r/nousresearch/hermes-agent/tags
  • Your config and session history live under ``$HERMES_HOME`` (``/opt/data``
    in the container, typically bind-mounted from the host) and persist
    across image upgrades — re-pulling doesn't lose any state.
  • Running a fork?  Build your own image with this repo's ``Dockerfile``
    and replace the ``docker pull`` step with your build/push pipeline.""",
    STEWARD_NIX: (
        "✗ This Hermes runs from the Nix store.\n"
        "\n"
        "The store path is immutable. Update through your flake:\n"
        "  nix flake update && rebuild your profile or system"
    ),
}

_STEWARD_FALLBACK_MESSAGE = (
    "✗ This Hermes install is managed by {steward}.\n"
    "\n"
    "The tree has no git checkout, so `hermes update` cannot update it.\n"
    "Update it with the tool that installed it."
)

# What the uninstaller says when it refuses to remove code from a sealed
# tree. The steward put the code there; the steward removes it. The
# desktop-app message is per-OS because each OS owns app removal
# differently.
_STEWARD_DELETE_DATA_PREAMBLE = "To delete your Hermes data (chats, configuration, etc),\n"
_STEWARD_DELETE_DATA_CLI = "run:\n$ hermes uninstall --data\n"
_STEWARD_DELETE_DATA_DESKTOP = "Open Hermes Desktop, go to Settings -> About, and delete your data from there.\n"

_STEWARD_UNINSTALL_MESSAGES = {
    STEWARD_DOCKER: (
        "✗ This Hermes runs from a Docker image.\n"
        "\n"
        "There is no code to uninstall — remove the container and image:\n"
        "  docker rm <container> && docker rmi nousresearch/hermes-agent\n"
        "\n" +
        _STEWARD_DELETE_DATA_PREAMBLE +
        _STEWARD_DELETE_DATA_CLI
    ),
    STEWARD_NIX: (
        "✗ This Hermes was installed by Nix.\n"
        "\n"
        "The store path is immutable — uninstall it the same way you\n"
        "installed it: remove hermes-agent from your flake / profile\n"
        "(e.g. `nix profile remove`), then rebuild.\n"
        "\n" +
        _STEWARD_DELETE_DATA_PREAMBLE +
        _STEWARD_DELETE_DATA_CLI
    ),
}

_STEWARD_MANAGED_BY_DESKTOP = "✗ Hermes is managed by the desktop app.\n"

_STEWARD_DESKTOP_UNINSTALL_BY_PLATFORM = {
    "win32": (
        _STEWARD_MANAGED_BY_DESKTOP +
        "\n"
        "Remove the app from Windows Settings → Apps → Installed apps.\n" +
        _STEWARD_DELETE_DATA_PREAMBLE +
        _STEWARD_DELETE_DATA_DESKTOP
    ),
    "darwin": (
        _STEWARD_MANAGED_BY_DESKTOP +
        "\n"
        "Quit the app and drag Hermes.app from Applications to the Trash.\n" +
        _STEWARD_DELETE_DATA_PREAMBLE +
        _STEWARD_DELETE_DATA_DESKTOP
    ),
}

_STEWARD_DESKTOP_UNINSTALL_DEFAULT = (
    _STEWARD_MANAGED_BY_DESKTOP +
    "\n"
    "Delete the Hermes AppImage (or app directory) from wherever you\n"
    "saved it.\n" +
    _STEWARD_DELETE_DATA_PREAMBLE +
    _STEWARD_DELETE_DATA_DESKTOP
)

_STEWARD_UNINSTALL_FALLBACK = (
    "✗ Hermes is managed by {steward}.\n"
    "\n"
    "The tree has no git checkout, so the uninstaller will not remove it.\n"
    "Remove it with the tool that installed it.\n"
    "\n" +
    # A generic package-manager steward has no desktop app, and this
    # refusal prints in a CLI context — point at the CLI data path.
    _STEWARD_DELETE_DATA_PREAMBLE +
    _STEWARD_DELETE_DATA_CLI
)


def steward_uninstall_message(steward: str, platform: "str | None" = None) -> str:
    """The uninstall refusal text for a sealed tree."""
    if steward == STEWARD_DESKTOP:
        key = platform if platform is not None else sys.platform
        return _STEWARD_DESKTOP_UNINSTALL_BY_PLATFORM.get(key, _STEWARD_DESKTOP_UNINSTALL_DEFAULT)
    message = _STEWARD_UNINSTALL_MESSAGES.get(steward)
    if message is not None:
        return message
    return _STEWARD_UNINSTALL_FALLBACK.format(steward=steward)


@dataclass(frozen=True)
class GitCheckout:
    """A tree with .git — `hermes update` owns it."""

    root: Path


@dataclass(frozen=True)
class Sealed:
    """A gitless tree — the steward replaces it wholesale."""

    root: Path
    steward: str


def read_build_info(project_root: Path) -> dict:
    """The baked build stamp of ``project_root``, or ``{}``.

    Raises ``RuntimeError`` on a ``payload: light`` stamp: a light artifact
    ships no Python runtime, so a Python process reading its own stamp as
    light means the artifact was mispackaged. Failing loudly here beats
    every consumer misclassifying the tree.
    """
    try:
        data = json.loads((Path(project_root) / BUILD_INFO_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    if data.get("payload") == "light":
        raise RuntimeError(
            f"install-stamp.json at {project_root} marks this artifact as 'light' "
            "(no agent runtime). No Python process can legitimately run from a "
            "light artifact — this build is mispackaged."
        )
    return data


def runtime_tree(project_root: Path) -> GitCheckout | Sealed:
    """Classify the tree at ``project_root``.

    ``.git`` present (a directory, or a worktree/submodule gitfile) means a
    git checkout. Everything else is sealed, with the steward read from the
    build stamp; a missing or unknown stamp gives steward ``"unknown"``.
    """
    root = Path(project_root)
    if (root / ".git").exists():
        return GitCheckout(root=root)

    distribution = read_build_info(root).get("distribution")
    steward = distribution if isinstance(distribution, str) and distribution else "unknown"
    return Sealed(root=root, steward=steward)


def steward_update_message(steward: str) -> str:
    """The `hermes update` refusal text for a sealed tree."""
    message = STEWARD_UPDATE_MESSAGES.get(steward)
    if message is not None:
        return message
    return _STEWARD_FALLBACK_MESSAGE.format(steward=steward)


def managed_install_roots() -> tuple[Path, ...]:
    """The canonical roots where installers create the agent checkout.

    * per-user: ``$HERMES_HOME/hermes-agent`` (usually ``~/.hermes``)
    * FHS root installs (install.sh as root on Linux):
      ``/usr/local/lib/hermes-agent``
    """
    from hermes_constants import get_hermes_home

    return (get_hermes_home() / "hermes-agent", Path("/usr/local/lib/hermes-agent"))


def is_managed_install_root(path: Path) -> bool:
    """True when ``path`` is a canonical installer-created checkout root.

    `hermes update` updates these without a question. A checkout anywhere
    else is somebody's working tree, and update asks first.
    """
    try:
        resolved = Path(path).resolve()
    except OSError:
        return False
    for root in managed_install_roots():
        try:
            if resolved == root.resolve():
                return True
        except OSError:
            continue
    return False


# Stewards install_method() reports as-is. An unknown steward value (a newer
# package manager read by older code) reports "unknown" so consumers do not
# branch on an enum member they never heard of.
_KNOWN_STEWARDS = frozenset({STEWARD_DESKTOP, STEWARD_DOCKER, STEWARD_NIX})


def install_method(project_root: Path) -> str:
    """Derive the install method of the tree at ``project_root``.

    Everything comes from the tree itself — the stamp for sealed trees,
    ``.git`` plus location for checkouts. No stored method flags.

    * sealed tree, stamp ``distribution`` known → that steward
      (``docker``, ``nix``, ``desktop-app``)
    * ``.git`` at a managed install root → ``git`` (`hermes update` owns it)
    * ``.git`` anywhere else → ``source`` (somebody's working tree;
      update refuses and points at ``git pull``)
    * neither → ``unknown``
    """
    tree = runtime_tree(project_root)
    if isinstance(tree, Sealed):
        return tree.steward if tree.steward in _KNOWN_STEWARDS else "unknown"
    if is_managed_install_root(tree.root):
        return "git"
    return "source"
