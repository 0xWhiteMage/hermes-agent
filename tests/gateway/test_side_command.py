"""Tests for the /side ephemeral side-question command (gateway surface).

/side <question> answers a quick question using a read-only snapshot of the
current conversation. The critical invariant: the main session's
conversation history is NEVER mutated — the parent transcript is only read
and serialized into a throwaway prompt for a separate background agent.
"""

import asyncio
import copy
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from gateway.config import Platform
from gateway.platforms.base import MessageEvent
from gateway.session import SessionSource
from hermes_cli.side_question import (
    SIDE_HISTORY_MAX_MESSAGES,
    compose_side_prompt,
)


def _make_event(text="/side", platform=Platform.TELEGRAM,
                user_id="12345", chat_id="67890"):
    source = SessionSource(
        platform=platform,
        user_id=user_id,
        chat_id=chat_id,
        user_name="testuser",
    )
    return MessageEvent(text=text, source=source)


def _make_runner(transcript=None):
    """Create a bare GatewayRunner with a stubbed session store."""
    from gateway.run import GatewayRunner
    runner = object.__new__(GatewayRunner)
    runner.adapters = {}
    runner._session_db = None
    runner._background_tasks = set()

    entry = MagicMock()
    entry.session_id = "sess-1"
    store = MagicMock()
    store._entries = {"telegram:67890": entry}
    store.load_transcript.return_value = transcript if transcript is not None else []
    runner.session_store = store
    runner._session_key_for_source = MagicMock(return_value="telegram:67890")
    return runner


SAMPLE_HISTORY = [
    {"role": "user", "content": "refactor the auth module"},
    {"role": "assistant", "content": "Done — I split it into three files."},
    {"role": "user", "content": "now add tests"},
]


# ---------------------------------------------------------------------------
# compose_side_prompt (shared cross-surface helper)
# ---------------------------------------------------------------------------


class TestComposeSidePrompt:
    def test_includes_question_and_history(self):
        prompt = compose_side_prompt("what is ECONNRESET?", SAMPLE_HISTORY)
        assert "<side_question>\nwhat is ECONNRESET?\n</side_question>" in prompt
        assert "<conversation_history>" in prompt
        assert "USER: refactor the auth module" in prompt
        assert "ASSISTANT: Done — I split it into three files." in prompt

    def test_instructs_not_to_continue_main_task(self):
        prompt = compose_side_prompt("q", SAMPLE_HISTORY)
        assert "Do not continue, resume, or complete any unfinished main task." in prompt

    def test_empty_history_omits_history_block(self):
        prompt = compose_side_prompt("standalone question", [])
        assert "<conversation_history>" not in prompt
        assert "<side_question>\nstandalone question\n</side_question>" in prompt

    def test_does_not_mutate_input_messages(self):
        """The composer must treat the caller's history as read-only."""
        history = copy.deepcopy(SAMPLE_HISTORY)
        before = json.dumps(history, sort_keys=True)
        compose_side_prompt("question", history)
        after = json.dumps(history, sort_keys=True)
        assert before == after

    def test_truncates_to_max_messages(self):
        history = [
            {"role": "user", "content": f"msg {i}"}
            for i in range(SIDE_HISTORY_MAX_MESSAGES + 15)
        ]
        prompt = compose_side_prompt("q", history)
        assert "msg 0" not in prompt
        assert f"msg {SIDE_HISTORY_MAX_MESSAGES + 14}" in prompt

    def test_flattens_multimodal_content_parts(self):
        history = [
            {"role": "user", "content": [
                {"type": "text", "text": "look at this"},
                {"type": "image_url", "image_url": {"url": "http://x/y.png"}},
            ]},
        ]
        prompt = compose_side_prompt("q", history)
        assert "USER: look at this" in prompt
        assert "image_url" not in prompt

    def test_skips_non_dict_messages(self):
        prompt = compose_side_prompt("q", ["garbage", None, {"role": "user", "content": "real"}])
        assert "USER: real" in prompt


# ---------------------------------------------------------------------------
# GatewayRunner._handle_side_command
# ---------------------------------------------------------------------------


class TestHandleSideCommand:
    @pytest.mark.asyncio
    async def test_no_question_shows_usage(self):
        runner = _make_runner()
        result = await runner._handle_side_command(_make_event("/side"))
        assert "Usage:" in result
        assert "/side" in result

    @pytest.mark.asyncio
    async def test_whitespace_question_shows_usage(self):
        runner = _make_runner()
        result = await runner._handle_side_command(_make_event("/side    "))
        assert "Usage:" in result

    @pytest.mark.asyncio
    async def test_side_question_queues_task_with_context(self):
        """A valid /side runs a background task whose prompt embeds the
        parent transcript and the question."""
        runner = _make_runner(transcript=SAMPLE_HISTORY)
        runner._run_background_task = AsyncMock()

        result = await runner._handle_side_command(
            _make_event("/side what did we change in auth?")
        )
        # Let the created asyncio task run the mocked coroutine.
        await asyncio.sleep(0)

        assert "Side question queued" in result
        assert "what did we change in auth?" in result

        runner._run_background_task.assert_called_once()
        kwargs = runner._run_background_task.call_args.kwargs
        prompt = kwargs["prompt"]
        assert "<side_question>\nwhat did we change in auth?\n</side_question>" in prompt
        assert "USER: refactor the auth module" in prompt
        assert kwargs["task_id"].startswith("side-")

    @pytest.mark.asyncio
    async def test_main_history_byte_identical_after_side(self):
        """The invariant: /side never mutates the main conversation history."""
        transcript = copy.deepcopy(SAMPLE_HISTORY)
        before = json.dumps(transcript, sort_keys=True)

        runner = _make_runner(transcript=transcript)
        runner._run_background_task = AsyncMock()

        await runner._handle_side_command(_make_event("/side quick question"))
        await asyncio.sleep(0)

        after = json.dumps(transcript, sort_keys=True)
        assert before == after
        # And nothing was written back through the session store.
        assert not runner.session_store.save_transcript.called
        assert not runner.session_store.append_message.called

    @pytest.mark.asyncio
    async def test_side_works_with_empty_history(self):
        """/side on a brand-new session (no transcript) still runs."""
        runner = _make_runner(transcript=[])
        runner._run_background_task = AsyncMock()

        result = await runner._handle_side_command(_make_event("/side hello?"))
        await asyncio.sleep(0)

        assert "Side question queued" in result
        prompt = runner._run_background_task.call_args.kwargs["prompt"]
        assert "<conversation_history>" not in prompt
        assert "<side_question>\nhello?\n</side_question>" in prompt

    @pytest.mark.asyncio
    async def test_side_works_when_no_session_entry(self):
        """/side before any session exists (no store entry) still runs."""
        runner = _make_runner()
        runner.session_store._entries = {}
        runner._run_background_task = AsyncMock()

        result = await runner._handle_side_command(_make_event("/side hi"))
        await asyncio.sleep(0)
        assert "Side question queued" in result

    @pytest.mark.asyncio
    async def test_side_task_registered_in_background_tasks(self):
        """/side uses the tracked background-task lifecycle (not a bare
        fire-and-forget create_task)."""
        runner = _make_runner(transcript=[])

        started = asyncio.Event()
        release = asyncio.Event()

        async def slow_task(*args, **kwargs):
            started.set()
            await release.wait()

        runner._run_background_task = slow_task

        await runner._handle_side_command(_make_event("/side q"))
        await started.wait()
        assert len(runner._background_tasks) == 1

        release.set()
        await asyncio.sleep(0.01)
        # done_callback discards the finished task.
        assert len(runner._background_tasks) == 0


# ---------------------------------------------------------------------------
# Command registry
# ---------------------------------------------------------------------------


class TestSideRegistry:
    def test_side_registered(self):
        from hermes_cli.commands import resolve_command
        cmd = resolve_command("side")
        assert cmd is not None
        assert cmd.name == "side"
        assert not cmd.gateway_only  # cross-surface: CLI + TUI + gateway

    def test_btw_still_resolves_to_background(self):
        """/btw is a long-standing alias of /background — /side must not
        steal it."""
        from hermes_cli.commands import resolve_command
        cmd = resolve_command("btw")
        assert cmd is not None
        assert cmd.name == "background"

    def test_side_has_no_aliases(self):
        from hermes_cli.commands import COMMAND_REGISTRY
        side = next(c for c in COMMAND_REGISTRY if c.name == "side")
        assert side.aliases == ()

    def test_side_in_active_session_bypass(self):
        """/side must work while an agent is running (it can't interrupt
        the main loop by construction)."""
        from hermes_cli.commands import ACTIVE_SESSION_BYPASS_COMMANDS
        assert "side" in ACTIVE_SESSION_BYPASS_COMMANDS

    def test_side_is_gateway_known(self):
        from hermes_cli.commands import is_gateway_known_command
        assert is_gateway_known_command("side")
