"""The conftest fixture must resolve through the REAL registry lookup."""


def test_managed_fixture_resolves(managed_cua_driver):
    from tools.computer_use.cua_backend import resolve_cua_driver_cmd

    assert resolve_cua_driver_cmd() == managed_cua_driver


def test_absent_fixture_resolves_to_none(no_cua_driver):
    from tools.computer_use.cua_backend import resolve_cua_driver_cmd

    assert resolve_cua_driver_cmd() is None


def test_path_driver_is_not_a_rung(no_cua_driver, tmp_path, monkeypatch):
    """A cua-driver on PATH must NOT satisfy resolution any more."""
    import stat

    from tools.computer_use.cua_backend import resolve_cua_driver_cmd

    bindir = tmp_path / "bin"
    bindir.mkdir()
    stray = bindir / "cua-driver"
    stray.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    stray.chmod(stray.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PATH", str(bindir))

    assert resolve_cua_driver_cmd() is None


def test_override_outranks_the_managed_fact(managed_cua_driver, tmp_path, monkeypatch):
    import stat

    from tools.computer_use.cua_backend import resolve_cua_driver_cmd

    mine = tmp_path / "mine"
    mine.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    mine.chmod(mine.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("HERMES_CUA_DRIVER_CMD", str(mine))

    assert resolve_cua_driver_cmd() == str(mine)
