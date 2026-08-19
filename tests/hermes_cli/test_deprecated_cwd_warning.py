"""Tests for warn_deprecated_cwd_env_vars() migration warning."""


class TestDeprecatedCwdWarning:
    """Warn when MESSAGING_CWD or TERMINAL_CWD is set in .env."""

    def test_messaging_cwd_triggers_warning(self, monkeypatch, capsys):
        monkeypatch.setenv("MESSAGING_CWD", "/some/path")
        monkeypatch.delenv("TERMINAL_CWD", raising=False)

        from hermes_cli.config import warn_deprecated_cwd_env_vars
        warn_deprecated_cwd_env_vars(config={})

        captured = capsys.readouterr()
        assert "MESSAGING_CWD" in captured.err
        assert "deprecated" in captured.err.lower()
        assert "config.yaml" in captured.err


    def test_both_deprecated_vars_warn(self, monkeypatch, capsys):
        monkeypatch.setenv("MESSAGING_CWD", "/msg/path")
        monkeypatch.setenv("TERMINAL_CWD", "/term/path")

        from hermes_cli.config import warn_deprecated_cwd_env_vars
        warn_deprecated_cwd_env_vars(config={})

        captured = capsys.readouterr()
        assert "MESSAGING_CWD" in captured.err
        assert "TERMINAL_CWD" in captured.err

    def test_migration_hint_has_no_literal_escape_text(self, monkeypatch, capsys):
        """The config.yaml hint must be real lines, not literal '\\n' text.

        Regression: the hint was built with '\\\\n' inside an f-string, which
        printed the two characters backslash-n into the terminal instead of a
        newline.
        """
        monkeypatch.setenv("TERMINAL_CWD", "/term/path")
        monkeypatch.delenv("MESSAGING_CWD", raising=False)

        from hermes_cli.config import warn_deprecated_cwd_env_vars
        warn_deprecated_cwd_env_vars(config={})

        captured = capsys.readouterr()
        assert "\\n" not in captured.err
        # The yaml snippet is on its own lines and cwd is nested under terminal:
        plain_lines = captured.err.splitlines()
        terminal_idx = next(
            i for i, ln in enumerate(plain_lines) if ln.strip("\x1b[02m ").startswith("terminal:")
        )
        assert "cwd:" in plain_lines[terminal_idx + 1]
