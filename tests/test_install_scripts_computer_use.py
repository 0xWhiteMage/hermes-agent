"""The installers provision cua-driver through the pin table.

Policy: choosing Computer Use is a config flip, not a surprise
multi-minute binary fetch. Both installers stage the pinned driver during
the ordinary provisioner sweep (`--extra cua-driver`), and both can be
told not to (`--skip-computer-use` / `-SkipComputerUse`).

This file used to assert that policy by reading install.sh / install.ps1
as TEXT and grepping for `install_computer_use_driver() {`, a literal
`run_with_timeout 660`, and similar. That is the banned source-regex
pattern (AGENTS.md, "Never read source code in tests"): it passed while
the flag was wired to the wrong variable and failed when a local was
renamed.

What it asserts now is the CONTRACT the installers depend on, exercised
for real against the pin table. The scripts' own wiring is covered where
it can be covered honestly: bash/PowerShell syntax gates in CI, and the
install E2E lane that actually runs them. Executing install.sh here is
not an option worth the risk — its last line calls `main`, so sourcing
it to inspect a parsed flag runs a real installation.
"""

from __future__ import annotations

import pytest

_TARGETS = (
    "darwin-arm64", "darwin-x64",
    "linux-arm64", "linux-x64",
    "win32-arm64", "win32-x64",
)


class TestPinnedDriverContract:
    def test_cua_driver_is_an_optional_pin(self) -> None:
        """Optional is what makes the whole arrangement work.

        It means nobody downloads a driver they never asked for, so the
        installers can name it explicitly (`--extra cua-driver`) while a
        `--skip-computer-use` user pays nothing — AND it means
        `hermes update` carries a version bump onto an install that DID
        provision it, because provision_runtimes keeps optional tools the
        facts already record.
        """
        from installation.registry import is_optional, load_pins

        pins = load_pins()
        assert "cua-driver" in pins
        assert is_optional("cua-driver", pins)

    def test_every_target_is_declared(self) -> None:
        """No silent gaps: a target has an artifact or a stated reason."""
        from installation.registry import load_pins

        files = load_pins()["cua-driver"]["files"]
        for target in _TARGETS:
            assert target in files, f"{target} is neither pinned nor declared missing"
            spec = files[target]
            assert ("url" in spec) ^ ("missing" in spec)

    @pytest.mark.parametrize("target", _TARGETS)
    def test_every_pinned_artifact_resolves(self, target: str) -> None:
        """`--extra cua-driver` must resolve on every target we ship to."""
        from installation.registry import pinned_file

        pin = pinned_file("cua-driver", target)
        assert pin.url.startswith("https://")
        assert len(pin.sha256) == 64

    def test_the_driver_binary_has_a_known_layout(self) -> None:
        """A pinned tool the provisioner cannot lay out is a build break.

        ``_binary_rel`` raises for a (tool, target) pair it has no layout
        for, which would surface as a failed provision at install time
        rather than here.
        """
        from installation.provisioner import _binary_rel

        for target in _TARGETS:
            rel = _binary_rel("cua-driver", target)
            assert rel.startswith("cua-driver")
            assert rel.endswith(".exe") == target.startswith("win32")
