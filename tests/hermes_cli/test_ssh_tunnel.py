from hermes_cli import ssh_tunnel


def test_tunnel_config_accepts_user_at_host_and_explicit_key():
    config = ssh_tunnel.SshTunnelConfig.from_dict({
        "host": "ari@example.test",
        "port": 2222,
        "key_path": "/tmp/key",
    })

    assert config == ssh_tunnel.SshTunnelConfig(
        host="example.test", user="ari", port=2222, key_path="/tmp/key"
    )
    agent_config = ssh_tunnel.SshTunnelConfig.from_dict({"host": "example.test"})
    assert agent_config is not None
    assert agent_config.key_path == ""


def test_tunnel_url_rewrites_only_the_runtime_host(monkeypatch):
    ssh_tunnel.close_ssh_tunnels()
    started = []

    class LiveProcess:
        def __init__(self):
            self.alive = True

        def poll(self):
            return None if self.alive else 0

        def terminate(self):
            self.alive = False

        def wait(self, timeout=None):
            return 0

        def kill(self):
            self.alive = False

    def fake_start(self):
        if self.local_port and self.process and self.process.poll() is None:
            return self.local_port
        started.append(self)
        self.local_port = 45678
        self.process = LiveProcess()
        return self.local_port

    monkeypatch.setattr(ssh_tunnel.ManagedSshTunnel, "start", fake_start)

    url = ssh_tunnel.resolve_ssh_tunnel_url(
        "http://127.0.0.1:30090/v1",
        {"host": "remote.example", "user": "ari", "key_path": "/tmp/key"},
    )

    assert url == "http://127.0.0.1:45678/v1"
    assert len(started) == 1
    assert started[0].remote_host == "127.0.0.1"
    assert started[0].remote_port == 30090

    assert ssh_tunnel.resolve_ssh_tunnel_url(
        "http://127.0.0.1:30090/v1",
        {"host": "remote.example", "user": "ari", "key_path": "/tmp/key"},
    ) == url
    assert len(started) == 1
    ssh_tunnel.close_ssh_tunnels()


def test_tunnel_config_rejects_user_twice():
    try:
        ssh_tunnel.SshTunnelConfig.from_dict({"host": "ari@example.test", "user": "other"})
    except ValueError as exc:
        assert "must not include a user" in str(exc)
    else:
        raise AssertionError("unsafe SSH target accepted")
