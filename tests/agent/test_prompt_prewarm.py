"""Tests for ``agent.prompt_prewarm`` — the prompt-cache prewarm request.

The prewarm exists to pay the provider-side prompt-cache write (system
prompt + tool schemas) before the first user message, so the first real
turn reads a warm prefix instead of ingesting 50-70k uncached tokens.

Behavior contracts covered:

  * ``prewarm_supported`` gates on prompt caching being active and on a
    reproducible transport (chat_completions / anthropic_messages, not MoA).
  * ``prewarm_prompt_cache`` sends the SAME system prompt bytes the first
    real turn will send, with cache_control markers, capped at 1 output
    token, non-streaming, and with thinking/reasoning knobs stripped.
  * The request client it creates is always closed (success and failure).
  * Fail-open: any error → returns False, never raises.
  * The sent prompt is handed to the first real turn via
    ``agent._prewarmed_system_prompt`` and adopted by
    ``_restore_or_build_system_prompt`` so the volatile tail (timestamp)
    cannot drift between the prewarm and the first real request.
"""

from __future__ import annotations

from unittest.mock import MagicMock

from agent.prompt_prewarm import prewarm_prompt_cache, prewarm_supported


SYSTEM_PROMPT = "You are Hermes Agent.\n\nSTATIC PART\n\nVolatile tail"
STATIC_PREFIX = "You are Hermes Agent.\n\nSTATIC PART"


def _make_agent(api_mode: str = "chat_completions"):
    agent = MagicMock()
    agent._use_prompt_caching = True
    agent._use_native_cache_layout = False
    agent._cache_ttl = "5m"
    agent.api_mode = api_mode
    agent.provider = "nous"
    agent.model = "anthropic/claude-fable-5"
    agent._cached_system_prompt = SYSTEM_PROMPT
    agent._cached_system_prompt_static = STATIC_PREFIX
    agent._prewarmed_system_prompt = None

    # _build_api_kwargs echoes the messages it was given, like the real one.
    def _build_api_kwargs(api_messages):
        return {
            "model": agent.model,
            "messages": api_messages,
            "max_tokens": 8192,
            "stream": False,
        }

    agent._build_api_kwargs = MagicMock(side_effect=_build_api_kwargs)

    client = MagicMock()
    agent._create_request_openai_client = MagicMock(return_value=client)
    agent._create_request_anthropic_client = MagicMock(return_value=client)
    agent._request_client = client
    return agent


class TestPrewarmSupported:
    def test_supported_on_chat_completions_with_caching(self):
        assert prewarm_supported(_make_agent()) is True

    def test_supported_on_anthropic_messages(self):
        assert prewarm_supported(_make_agent(api_mode="anthropic_messages")) is True

    def test_not_supported_without_prompt_caching(self):
        agent = _make_agent()
        agent._use_prompt_caching = False
        assert prewarm_supported(agent) is False

    def test_not_supported_on_bespoke_transports(self):
        for mode in ("codex_responses", "bedrock_converse", "acp"):
            assert prewarm_supported(_make_agent(api_mode=mode)) is False

    def test_not_supported_for_moa(self):
        agent = _make_agent()
        agent.provider = "moa"
        assert prewarm_supported(agent) is False


class TestPrewarmRequest:
    def test_sends_cached_system_prompt_with_markers(self):
        agent = _make_agent()
        assert prewarm_prompt_cache(agent) is True

        create = agent._request_client.chat.completions.create
        assert create.call_count == 1
        kwargs = create.call_args.kwargs
        messages = kwargs["messages"]

        assert messages[0]["role"] == "system"
        # The static prefix split produced the two-part [static, volatile]
        # layout, each part carrying a cache_control marker, and the joined
        # bytes are exactly the prompt the first real turn will send.
        system_content = messages[0]["content"]
        assert isinstance(system_content, list)
        assert "".join(p["text"] for p in system_content) == SYSTEM_PROMPT
        assert all("cache_control" in p for p in system_content)
        assert messages[1]["role"] == "user"

    def test_output_capped_to_one_token_and_non_streaming(self):
        agent = _make_agent()
        prewarm_prompt_cache(agent)
        kwargs = agent._request_client.chat.completions.create.call_args.kwargs
        assert kwargs["max_tokens"] == 1
        assert "stream" not in kwargs

    def test_thinking_and_reasoning_knobs_stripped(self):
        agent = _make_agent()

        def _build_api_kwargs(api_messages):
            return {
                "model": agent.model,
                "messages": api_messages,
                "max_tokens": 8192,
                "thinking": {"type": "enabled", "budget_tokens": 4096},
                "reasoning_effort": "high",
                "extra_body": {"reasoning": {"effort": "high"}, "keep": 1},
            }

        agent._build_api_kwargs = MagicMock(side_effect=_build_api_kwargs)
        assert prewarm_prompt_cache(agent) is True
        kwargs = agent._request_client.chat.completions.create.call_args.kwargs
        assert "thinking" not in kwargs
        assert "reasoning_effort" not in kwargs
        assert "reasoning" not in kwargs["extra_body"]
        assert kwargs["extra_body"]["keep"] == 1

    def test_builds_prompt_when_not_cached(self):
        agent = _make_agent()
        agent._cached_system_prompt = None
        agent._build_system_prompt = MagicMock(return_value=SYSTEM_PROMPT)
        assert prewarm_prompt_cache(agent) is True
        agent._build_system_prompt.assert_called_once_with()

    def test_hands_sent_prompt_to_first_real_turn(self):
        agent = _make_agent()
        prewarm_prompt_cache(agent)
        assert agent._prewarmed_system_prompt == SYSTEM_PROMPT

    def test_request_client_closed_on_success(self):
        agent = _make_agent()
        prewarm_prompt_cache(agent)
        agent._close_request_openai_client.assert_called_once()

    def test_request_client_closed_on_request_failure(self):
        agent = _make_agent()
        agent._request_client.chat.completions.create.side_effect = RuntimeError(
            "provider 500"
        )
        assert prewarm_prompt_cache(agent) is False
        agent._close_request_openai_client.assert_called_once()

    def test_fail_open_never_raises(self):
        agent = _make_agent()
        agent._build_api_kwargs = MagicMock(side_effect=RuntimeError("boom"))
        assert prewarm_prompt_cache(agent) is False
        assert agent._prewarmed_system_prompt is None

    def test_skips_unsupported_agent(self):
        agent = _make_agent()
        agent._use_prompt_caching = False
        assert prewarm_prompt_cache(agent) is False
        agent._build_api_kwargs.assert_not_called()

    def test_anthropic_messages_uses_anthropic_client(self):
        agent = _make_agent(api_mode="anthropic_messages")
        agent._anthropic_messages_create = MagicMock(return_value=MagicMock())
        assert prewarm_prompt_cache(agent) is True
        agent._create_request_anthropic_client.assert_called_once()
        agent._anthropic_messages_create.assert_called_once()


class TestFirstTurnAdoption:
    """The first real turn must reuse the exact prewarmed bytes."""

    def _restore_agent(self, prewarmed):
        agent = MagicMock()
        agent._cached_system_prompt = None
        agent.session_id = "sid"
        agent.model = "anthropic/claude-fable-5"
        agent.provider = "nous"
        agent.platform = "desktop"
        agent._session_db = None
        agent._use_prompt_caching = False
        agent._prewarmed_system_prompt = prewarmed
        agent._build_system_prompt = MagicMock(return_value="FRESH_BUILD")
        return agent

    def test_first_turn_reuses_prewarmed_prompt(self):
        from agent.conversation_loop import _restore_or_build_system_prompt

        agent = self._restore_agent(SYSTEM_PROMPT)
        _restore_or_build_system_prompt(agent, None, None)
        assert agent._cached_system_prompt == SYSTEM_PROMPT
        agent._build_system_prompt.assert_not_called()
        # One-shot: consumed after adoption.
        assert agent._prewarmed_system_prompt is None

    def test_prewarmed_prompt_rejected_on_model_switch(self):
        """A /model switch between prewarm and first message must rebuild."""
        from agent.conversation_loop import _restore_or_build_system_prompt

        stale = SYSTEM_PROMPT + "\nModel: anthropic/claude-old\nProvider: nous"
        agent = self._restore_agent(stale)
        agent.model = "openai/gpt-6"
        _restore_or_build_system_prompt(agent, None, None)
        assert agent._cached_system_prompt == "FRESH_BUILD"
        agent._build_system_prompt.assert_called_once_with(None)
        assert agent._prewarmed_system_prompt is None

    def test_prewarmed_prompt_ignored_with_custom_system_message(self):
        from agent.conversation_loop import _restore_or_build_system_prompt

        agent = self._restore_agent(SYSTEM_PROMPT)
        _restore_or_build_system_prompt(agent, "custom system", None)
        assert agent._cached_system_prompt == "FRESH_BUILD"
        agent._build_system_prompt.assert_called_once_with("custom system")

    def test_prewarmed_prompt_ignored_on_continuing_session(self):
        from agent.conversation_loop import _restore_or_build_system_prompt

        agent = self._restore_agent(SYSTEM_PROMPT)
        _restore_or_build_system_prompt(
            agent, None, [{"role": "user", "content": "hi"}]
        )
        assert agent._cached_system_prompt == "FRESH_BUILD"

    def test_no_prewarm_builds_fresh(self):
        from agent.conversation_loop import _restore_or_build_system_prompt

        agent = self._restore_agent(None)
        _restore_or_build_system_prompt(agent, None, None)
        assert agent._cached_system_prompt == "FRESH_BUILD"
