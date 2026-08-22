"""Runtime smoke tests for the container's browser stack.

Build the real image and verify the browser the runtime resolves is the
PINNED one, recorded as a fact by the provisioner at build time.

This replaces a test of the previous mechanism. The image used to bake
its browser with ``npx playwright install`` and no fact was recorded, so
``docker/stage2-hook.sh`` located the binary at boot and exported
``AGENT_BROWSER_EXECUTABLE_PATH`` through s6's ``container_environment``.
That covered the supervised services and nothing else — a ``docker exec``
shell got no variable and resolved no browser. A fact is on disk, so
every process that asks gets the same answer, which is what the last
test here pins.
"""
from __future__ import annotations

import json

from tests.docker.conftest import docker_exec, docker_exec_sh, start_container

# The resolver, run inside the container. Prints the driver and engine
# exactly as the browser tool resolves them at call time.
_RESOLVE = (
    "from installation.browser import driver_path, engine_path; "
    "print('driver=%s' % driver_path()); "
    "print('engine=%s' % engine_path())"
)


def test_pinned_browser_is_provisioned_as_a_fact(
    built_image: str, container_name: str,
) -> None:
    """The build stages the pinned driver and engine, and records them.

    ``--extras agent-browser`` walks the pin table's ``requires`` edges,
    so one request brings up the driver plus the Chromium pair.
    """
    start_container(built_image, container_name)

    r = docker_exec_sh(
        container_name,
        "cat /opt/hermes/.hermes-runtime/runtimes.json",
        timeout=10,
    )
    assert r.returncode == 0, f"no runtime facts in the image: {r.stderr}"
    facts = json.loads(r.stdout)
    tools = facts.get("tools", facts)

    for tool in ("agent-browser", "chromium"):
        assert tool in tools, (
            f"{tool!r} has no recorded fact — the image did not provision "
            f"the pinned browser stack (facts: {sorted(tools)})"
        )


def test_runtime_resolves_the_pinned_browser(
    built_image: str, container_name: str,
) -> None:
    """The locator the browser tool uses answers inside the container."""
    start_container(built_image, container_name)

    r = docker_exec(container_name, "python3", "-c", _RESOLVE, timeout=30)
    assert r.returncode == 0, f"resolver failed: {r.stderr}"

    lines = dict(
        line.split("=", 1) for line in r.stdout.strip().splitlines() if "=" in line
    )
    assert lines.get("driver", "None") != "None", (
        f"agent-browser did not resolve in the container: {r.stdout}"
    )
    assert lines.get("engine", "None") != "None", (
        f"no Chromium resolved in the container: {r.stdout}"
    )


def test_the_resolved_engine_actually_runs(
    built_image: str, container_name: str,
) -> None:
    """The staged Chromium launches.

    The provisioner already probes this at build time, so a failure here
    means the runtime image is missing a shared library that the build
    stage had. Those two package sets are the same apt layer, and this
    test is what keeps them that way.
    """
    start_container(built_image, container_name)

    r = docker_exec(
        container_name,
        "python3", "-c",
        "from installation.browser import engine_path; print(engine_path())",
        timeout=30,
    )
    assert r.returncode == 0, r.stderr
    engine = r.stdout.strip()
    assert engine and engine != "None", "no engine to launch"

    r = docker_exec_sh(
        container_name,
        f'"{engine}" --headless --disable-gpu --no-sandbox '
        f"--dump-dom about:blank",
        timeout=120,
    )
    assert r.returncode == 0, (
        f"the staged Chromium did not run: {r.stderr[-600:]}"
    )
    assert "<html" in r.stdout.lower(), (
        f"Chromium ran but rendered nothing: {r.stdout[:300]}"
    )


def test_docker_exec_resolves_the_browser_too(
    built_image: str, container_name: str,
) -> None:
    """A non-supervised shell resolves the same browser.

    The regression this pins: the stage2 hook wrote
    AGENT_BROWSER_EXECUTABLE_PATH into ``/run/s6/container_environment``,
    which ``with-contenv`` hands to the supervised services only. An
    operator running ``docker exec <c> hermes ...`` got no variable, and
    the browser tool found nothing. Reading a fact from disk does not
    depend on how the process was started.
    """
    start_container(built_image, container_name)

    # No AGENT_BROWSER_EXECUTABLE_PATH in this environment at all.
    r = docker_exec_sh(
        container_name,
        "printenv AGENT_BROWSER_EXECUTABLE_PATH || echo UNSET",
        timeout=10,
    )
    assert "UNSET" in r.stdout, (
        "this test is meaningless if the variable is already exported: "
        f"{r.stdout!r}"
    )

    r = docker_exec(container_name, "python3", "-c", _RESOLVE, timeout=30)
    assert r.returncode == 0, r.stderr
    assert "engine=None" not in r.stdout, (
        f"a docker exec shell resolved no browser: {r.stdout}"
    )
