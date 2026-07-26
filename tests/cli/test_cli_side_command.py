"""Tests for the CLI /side command — ephemeral side question.

/side composes a throwaway prompt from a read-only snapshot of
``self.conversation_history`` and delegates to _handle_background_command.
Invariant: the main conversation history is byte-identical before/after.
"""

import copy
import json
from unittest.mock import MagicMock, patch

from cli import HermesCLI


def _make_cli(history=None):
    cli_obj = HermesCLI.__new__(HermesCLI)
    cli_obj.conversation_history = history if history is not None else []
    return cli_obj


SAMPLE_HISTORY = [
    {"role": "user", "content": "set up the docker compose stack"},
    {"role": "assistant", "content": "Done, three services are running."},
]


class TestCliSideCommand:
    def test_usage_when_no_question(self, capsys):
        cli_obj = _make_cli()
        cli_obj._handle_background_command = MagicMock()
        cli_obj._handle_side_command("/side")
        out = capsys.readouterr().out
        assert "Usage: /side <question>" in out
        cli_obj._handle_background_command.assert_not_called()

    def test_usage_when_whitespace_question(self, capsys):
        cli_obj = _make_cli()
        cli_obj._handle_background_command = MagicMock()
        cli_obj._handle_side_command("/side    ")
        out = capsys.readouterr().out
        assert "Usage: /side <question>" in out
        cli_obj._handle_background_command.assert_not_called()

    def test_delegates_to_background_with_context_prompt(self):
        cli_obj = _make_cli(history=copy.deepcopy(SAMPLE_HISTORY))
        cli_obj._handle_background_command = MagicMock()

        cli_obj._handle_side_command("/side which ports are exposed?")

        cli_obj._handle_background_command.assert_called_once()
        kwargs = cli_obj._handle_background_command.call_args.kwargs
        prompt = kwargs["prompt_override"]
        assert "<side_question>\nwhich ports are exposed?\n</side_question>" in prompt
        assert "USER: set up the docker compose stack" in prompt
        assert "Do not continue, resume, or complete any unfinished main task." in prompt
        assert kwargs["display_prompt"] == "which ports are exposed?"
        assert kwargs["task_label"] == "Side question"

    def test_main_history_byte_identical_after_side(self):
        history = copy.deepcopy(SAMPLE_HISTORY)
        before = json.dumps(history, sort_keys=True)

        cli_obj = _make_cli(history=history)
        cli_obj._handle_background_command = MagicMock()
        cli_obj._handle_side_command("/side quick question")

        after = json.dumps(cli_obj.conversation_history, sort_keys=True)
        assert before == after

    def test_works_with_empty_history(self):
        cli_obj = _make_cli(history=[])
        cli_obj._handle_background_command = MagicMock()

        cli_obj._handle_side_command("/side hello?")

        prompt = cli_obj._handle_background_command.call_args.kwargs["prompt_override"]
        assert "<conversation_history>" not in prompt
        assert "<side_question>\nhello?\n</side_question>" in prompt

    def test_works_when_history_attr_missing(self):
        """A bare CLI object without conversation_history must not crash."""
        cli_obj = HermesCLI.__new__(HermesCLI)
        cli_obj._handle_background_command = MagicMock()
        cli_obj._handle_side_command("/side hi")
        cli_obj._handle_background_command.assert_called_once()


class TestCliSideDispatch:
    def test_slash_dispatch_routes_side(self):
        """The CLI slash dispatcher routes canonical 'side' to the handler."""
        import inspect
        import cli as cli_mod
        src = inspect.getsource(cli_mod.HermesCLI.process_command)
        assert 'canonical == "side"' in src
        assert "_handle_side_command" in src
