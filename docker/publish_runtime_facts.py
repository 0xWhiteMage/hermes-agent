"""Publish the managed-runtime facts for the Docker image.

Runs at image build time, directly after ``installation.provisioner``.
It writes two files that the runtime shells read (``path-dirs`` and
``tool-env``) and links every managed binary into ``/usr/local/bin``.

This lives in a file, not in a Dockerfile heredoc: hadolint cannot
parse RUN heredocs (its parser stops at the first heredoc body line),
and the docker-lint CI job lints the Dockerfile as a blocking check.
"""

import shlex
import sys
from pathlib import Path

sys.path.insert(0, "/opt/hermes-build")
from installation.env import managed_path_dirs, managed_tool_env  # noqa: E402

runtime_dir = Path("/opt/hermes/.hermes-runtime")
dirs = managed_path_dirs(runtime_dir)
assert dirs, "provisioner ran but assembled no PATH dirs"
(runtime_dir / "path-dirs").write_text(
    "".join(f"{d}\n" for d in dirs), encoding="utf-8"
)
(runtime_dir / "tool-env").write_text(
    "".join(
        f"export {key}={shlex.quote(value)}\n"
        for key, value in sorted(managed_tool_env(runtime_dir).items())
    ),
    encoding="utf-8",
)
# Symlink each managed binary into /usr/local/bin: ENV PATH cannot hold
# per-tool dirs computed at build time, and the link farm keeps `docker
# exec <c> node` working with zero shell-profile tricks. The links point
# INTO the runtime dir, so the facts file remains the single authority.
for d in dirs:
    for binary in Path(d).iterdir():
        if binary.is_file():
            link = Path("/usr/local/bin") / binary.name
            if not link.exists():
                link.symlink_to(binary)
