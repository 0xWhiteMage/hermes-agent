from unittest.mock import patch

import pytest

from hermes_cli.dep_ensure import _PINNED_DEPS


@pytest.mark.linux_only
def test_find_install_script_from_checkout(tmp_path):
    """_find_install_script finds scripts/install.sh in a git checkout.

    ``linux_only``: the POSIX arm picks ``install.sh`` + ``bash``, which is
    already what ``_IS_WINDOWS`` reports here — nothing needs faking.
    """
    from hermes_cli.dep_ensure import _find_install_script
    scripts_dir = tmp_path / "scripts"
    scripts_dir.mkdir()
    (scripts_dir / "install.sh").write_text("#!/bin/bash", encoding="utf-8")
    path, shell = _find_install_script(package_dir=tmp_path / "hermes_cli", repo_root=tmp_path)
    assert path is not None
    assert path.name == "install.sh"
    assert shell == "bash"








def test_agent_browser_resolves_true_when_npx_resolves():
    """agent-browser resolves lazily via npx on the default install (#43564)
    — the "browser" dep check delegates to the runtime cascade, so it must
    not report the driver missing when npx is the answering rung."""
    from hermes_cli.dep_ensure import _agent_browser_resolves
    import tools.browser_tool as bt

    with patch.object(bt, "_find_agent_browser", return_value="npx agent-browser"):
        assert _agent_browser_resolves() is True


def test_agent_browser_resolves_true_for_the_pinned_copy(tmp_path):
    """The pinned driver's recorded name carries the host target
    (agent-browser-linux-x64), so a probe looking for a file called
    "agent-browser" reports a staged copy as missing. Delegating to
    _find_agent_browser is what makes the check agree with the tool."""
    from hermes_cli.dep_ensure import _agent_browser_resolves
    import tools.browser_tool as bt

    staged = tmp_path / "agent-browser-linux-x64"
    staged.write_text("#!/bin/sh\n", encoding="utf-8")

    with patch.object(bt, "_find_agent_browser", return_value=str(staged)):
        assert _agent_browser_resolves() is True


def test_agent_browser_resolves_false_when_nothing_resolves():
    from hermes_cli.dep_ensure import _agent_browser_resolves
    import tools.browser_tool as bt

    def _raise(**_kw):
        raise FileNotFoundError("agent-browser CLI not found")

    with patch.object(bt, "_find_agent_browser", _raise):
        assert _agent_browser_resolves() is False


def test_find_agent_browser_lazy_install_cycle_terminates(monkeypatch):
    """tools.browser_tool._find_agent_browser's "nothing found" branch calls
    ensure_dependency("browser"), whose "browser" check now calls
    _find_agent_browser(validate=False) again. That nested call must NOT be
    able to trigger another ensure_dependency call (only validate=True does
    that) — verifying the cycle is bounded to one extra rescan, not unbounded
    recursion, using the real functions on both sides rather than mocking the
    cycle away."""
    import shutil
    import tools.browser_tool as bt
    from hermes_cli import dep_ensure
    from installation.provisioner import ToolResult

    monkeypatch.setattr(bt, "_cached_agent_browser", None)
    monkeypatch.setattr(bt, "_agent_browser_resolved", False)
    monkeypatch.setattr(shutil, "which", lambda *a, **k: None)
    monkeypatch.setattr(bt, "_resolve_npx_bin", lambda: None)
    monkeypatch.setattr(dep_ensure, "_has_system_browser", lambda: False)
    # "browser" is a PINNED dep: the real lazy-install path provisions
    # agent-browser rather than shelling out. Fail the provision so the
    # cycle runs to its end, and keep the provisioner off the network.
    monkeypatch.setattr(
        "installation.provisioner.provision_tool",
        lambda *a, **k: ToolResult("agent-browser", "failed", detail="no network"),
    )

    real_find_agent_browser = bt._find_agent_browser
    validate_calls = []

    def counting_find_agent_browser(*, validate=True):
        validate_calls.append(validate)
        return real_find_agent_browser(validate=validate)

    monkeypatch.setattr(bt, "_find_agent_browser", counting_find_agent_browser)

    with pytest.raises(FileNotFoundError):
        bt._find_agent_browser(validate=True)

    # One outer validate=True call, plus exactly one bounded nested
    # validate=False rescan from the "browser" dep check inside
    # ensure_dependency — not unbounded recursion, and not a second
    # ensure_dependency("browser") call (which would show up as a second
    # `True` in this list).
    assert validate_calls == [True, False]


@pytest.mark.windows_only
def test_ensure_dependency_provisions_pinned_node_without_powershell(tmp_path):
    """node is a PINNED dep now: ensure_dependency drives the provisioner,
    which stages the managed node.exe in the tool store — the install.ps1
    shell-out no longer exists for it, so no PowerShell process is spawned.

    ``windows_only``: the assertion is about the Windows arm of the ensure
    path, where the shell-out used to be the mechanism."""
    from hermes_cli.dep_ensure import ensure_dependency
    from installation.provisioner import ToolResult

    # The real result type, not a stub: dep_ensure reads .provisioned,
    # and a hand-rolled fake drifts the moment ToolResult grows a field.
    result = ToolResult("node", "downloaded", version="26.7.0")

    checks = iter([False, True])  # missing before provisioning, present after
    with patch("hermes_cli.dep_ensure._DEP_CHECKS", {"node": lambda: next(checks)}), \
         patch("installation.provisioner.provision_tool", return_value=result) as prov, \
         patch("subprocess.run") as mock_run, \
         patch("sys.stdin") as mock_stdin:
        mock_stdin.isatty.return_value = False
        assert ensure_dependency("node", interactive=False) is True
    prov.assert_called_once_with("node")
    mock_run.assert_not_called()


@pytest.mark.parametrize("dep", sorted(_PINNED_DEPS))
def test_every_pinned_dep_provisions_instead_of_shelling_out(dep, monkeypatch):
    """Each pinned dep reaches the provisioner and never a shell.

    Host-independent on purpose: the Windows-only sibling below covers the
    PowerShell arm, and a regression that dropped the pinned path entirely
    was invisible to the Linux slices because no unmarked test asserted it.
    The install scripts reject these names ("Unknown dependency"), so a
    shell-out here does not install anything — it reports failure.
    """
    from hermes_cli.dep_ensure import _PINNED_DEPS as pinned_map, ensure_dependency
    from installation.provisioner import ToolResult

    tool = pinned_map[dep]
    result = ToolResult(tool, "downloaded", version="1.0.0")

    checks = iter([False, True])  # missing before provisioning, present after
    with patch("hermes_cli.dep_ensure._DEP_CHECKS", {dep: lambda: next(checks)}), \
         patch("installation.provisioner.provision_tool", return_value=result) as prov, \
         patch("subprocess.run") as mock_run, \
         patch("sys.stdin") as mock_stdin:
        mock_stdin.isatty.return_value = False
        assert ensure_dependency(dep, interactive=False) is True
    prov.assert_called_once_with(tool)
    mock_run.assert_not_called()


def test_every_pinned_dep_names_a_real_pin():
    """A _PINNED_DEPS value that is not in the pin table can never be
    provisioned: provision_tool returns "<tool> is not pinned" and the dep
    silently fails to install."""
    from hermes_cli.dep_ensure import _PINNED_DEPS as pinned_map
    from installation.registry import load_pins

    pins = load_pins()
    for dep, tool in pinned_map.items():
        assert tool in pins, f"{dep!r} maps to unpinned tool {tool!r}"


@pytest.mark.windows_only
def test_ensure_dependency_uses_powershell_on_windows(tmp_path):
    """Deps WITHOUT a pin (ffmpeg) still shell out to install.ps1.
    ``windows_only``: the assertion is that we shell out to a real
    PowerShell. Faking ``_IS_WINDOWS`` on Linux also required faking
    ``shutil.which`` into inventing a powershell.exe that isn't there."""
    from hermes_cli.dep_ensure import ensure_dependency
    scripts_dir = tmp_path / "scripts"
    scripts_dir.mkdir(parents=True)
    (scripts_dir / "install.ps1").write_text("# fake")
    with patch("hermes_cli.dep_ensure._DEP_CHECKS", {"ffmpeg": lambda: False}), \
         patch("hermes_cli.dep_ensure._find_install_script", return_value=(scripts_dir / "install.ps1", "powershell")), \
         patch("hermes_cli.dep_ensure.shutil") as mock_shutil, \
         patch("hermes_constants.get_hermes_home", return_value=tmp_path / "fakehome"), \
         patch("subprocess.run") as mock_run, \
         patch("sys.stdin") as mock_stdin:
        mock_shutil.which.side_effect = lambda name: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" if name == "powershell" else None
        mock_stdin.isatty.return_value = False
        mock_run.return_value = type("R", (), {"returncode": 0})()
        ensure_dependency("ffmpeg", interactive=False)
        cmd = mock_run.call_args[0][0]
        assert "powershell" in cmd[0].lower()
        assert "-Ensure" in cmd
        assert cmd[cmd.index("-Ensure") + 1] == "ffmpeg"
        assert "-HermesHome" in cmd
        assert str(tmp_path / "fakehome") in cmd
