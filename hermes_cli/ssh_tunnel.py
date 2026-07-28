"""Managed SSH tunnels for configured OpenAI-compatible endpoints.

A tunnel is process-local and reused by every agent in the same Hermes process.
The persisted provider URL remains the address as seen from the SSH host; only
the runtime URL is rewritten to a loopback port selected by the kernel.
"""

from __future__ import annotations

import atexit
import hashlib
import logging
import os
import shutil
import socket
import subprocess
import threading
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse, urlunparse

logger = logging.getLogger(__name__)

_CONNECT_TIMEOUT_SECONDS = 15
_START_TIMEOUT_SECONDS = 5
_TUNNELS: dict[str, "ManagedSshTunnel"] = {}
_TUNNELS_LOCK = threading.Lock()
_CONTROL_CHARS = frozenset(chr(i) for i in (*range(32), 127))


def _has_control_chars(value: str) -> bool:
    return any(char in _CONTROL_CHARS for char in value)


def _validate_ssh_value(name: str, value: str, *, required: bool = False) -> str:
    clean = str(value or "").strip()
    if required and not clean:
        raise ValueError(f"SSH tunnel requires {name}.")
    if clean and (_has_control_chars(clean) or clean.startswith("-")):
        raise ValueError(f"Unsafe SSH tunnel {name}.")
    return clean


@dataclass(frozen=True)
class SshTunnelConfig:
    host: str
    user: str = ""
    port: int = 22
    key_path: str = ""

    @classmethod
    def from_dict(cls, raw: Any) -> "SshTunnelConfig | None":
        if not isinstance(raw, dict):
            return None
        host = _validate_ssh_value("host", raw.get("host", ""), required=True)
        user = _validate_ssh_value("user", raw.get("user", ""))
        if "@" in host and not user:
            user, host = host.split("@", 1)
            user = _validate_ssh_value("user", user, required=True)
            host = _validate_ssh_value("host", host, required=True)
        elif "@" in host:
            raise ValueError("SSH tunnel host must not include a user when SSH user is set separately.")
        key_path = _validate_ssh_value("key path", raw.get("key_path", ""))
        try:
            port = int(raw.get("port") or 22)
        except (TypeError, ValueError) as exc:
            raise ValueError("SSH tunnel port must be an integer between 1 and 65535.") from exc
        if not 1 <= port <= 65535:
            raise ValueError("SSH tunnel port must be between 1 and 65535.")
        return cls(host=host, user=user, port=port, key_path=key_path)


def _pick_local_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _endpoint_target(base_url: str) -> tuple[str, int, str]:
    parsed = urlparse(str(base_url or "").strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("SSH-tunneled endpoint URL must include http(s) scheme and host.")
    try:
        remote_port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError as exc:
        raise ValueError("SSH-tunneled endpoint URL has an invalid port.") from exc
    return parsed.hostname, remote_port, parsed.geturl().rstrip("/")


class ManagedSshTunnel:
    def __init__(self, config: SshTunnelConfig, remote_host: str, remote_port: int):
        self.config = config
        self.remote_host = remote_host
        self.remote_port = remote_port
        self.local_port: int | None = None
        self.process: subprocess.Popen[bytes] | None = None

    @property
    def target(self) -> str:
        return f"{self.config.user + '@' if self.config.user else ''}{self.config.host}"

    def _args(self, local_port: int) -> list[str]:
        args = [
            "ssh",
            "-N",
            "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", "ExitOnForwardFailure=yes",
            "-o", f"ConnectTimeout={_CONNECT_TIMEOUT_SECONDS}",
        ]
        if self.config.port != 22:
            args.extend(["-p", str(self.config.port)])
        if self.config.key_path:
            args.extend(["-i", self.config.key_path])
        args.extend(["-L", f"127.0.0.1:{local_port}:{self.remote_host}:{self.remote_port}", "--", self.target])
        return args

    def start(self) -> int:
        if self.local_port and self.process and self.process.poll() is None:
            return self.local_port
        if not shutil.which("ssh"):
            raise RuntimeError("SSH is not installed or not in PATH. Install an OpenSSH client first.")
        if self.config.key_path and not os.path.isfile(os.path.expanduser(self.config.key_path)):
            raise RuntimeError(f"SSH identity file does not exist: {self.config.key_path}")

        for _ in range(3):
            local_port = _pick_local_port()
            process = subprocess.Popen(
                self._args(local_port),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
            deadline = time.monotonic() + _START_TIMEOUT_SECONDS
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    process.communicate()
                    raise RuntimeError("SSH tunnel failed to start. Check the SSH connection and credentials.")
                try:
                    with socket.create_connection(("127.0.0.1", local_port), timeout=0.15):
                        self.process = process
                        self.local_port = local_port
                        logger.info("SSH tunnel ready on loopback port %s", local_port)
                        return local_port
                except OSError:
                    time.sleep(0.05)
            process.terminate()
            try:
                process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                process.kill()
        raise RuntimeError("SSH tunnel could not bind an automatically assigned local port.")

    def close(self) -> None:
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
        self.process = None
        self.local_port = None


def resolve_ssh_tunnel_url(base_url: str, ssh_tunnel: Any) -> str:
    """Start/reuse a configured tunnel and return its loopback runtime URL."""
    config = SshTunnelConfig.from_dict(ssh_tunnel)
    if config is None:
        return base_url.rstrip("/")
    remote_host, remote_port, normalized_url = _endpoint_target(base_url)
    identity = hashlib.sha256(repr((config, remote_host, remote_port)).encode()).hexdigest()
    with _TUNNELS_LOCK:
        tunnel = _TUNNELS.get(identity)
        if tunnel is None:
            tunnel = ManagedSshTunnel(config, remote_host, remote_port)
            _TUNNELS[identity] = tunnel
        local_port = tunnel.start()
    parsed = urlparse(normalized_url)
    return urlunparse(parsed._replace(netloc=f"127.0.0.1:{local_port}")).rstrip("/")


def close_ssh_tunnels() -> None:
    with _TUNNELS_LOCK:
        tunnels = list(_TUNNELS.values())
        _TUNNELS.clear()
    for tunnel in tunnels:
        tunnel.close()


atexit.register(close_ssh_tunnels)
