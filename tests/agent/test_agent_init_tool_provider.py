from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from tools.tool_provider_gateway import ProviderConnection


def _initialize_agent_with_tool_provider(*, entitled, gateway_config, connections):
    from agent.agent_init import init_agent
    from run_agent import AIAgent

    agent = object.__new__(AIAgent)
    agent._base_url = ""
    agent._base_url_lower = ""
    agent._base_url_hostname = ""
    pool = SimpleNamespace(provider="anthropic")

    with (
        patch(
            "agent.auxiliary_client.resolve_provider_client", return_value=(None, None)
        ),
        patch("run_agent.get_tool_definitions", return_value=[]),
        patch(
            "agent.anthropic_adapter.build_anthropic_client",
            return_value=MagicMock(),
        ),
        patch("agent.anthropic_adapter.resolve_anthropic_token", return_value=""),
        patch("agent.anthropic_adapter._is_oauth_token", return_value=False),
        patch("agent.azure_identity_adapter.is_token_provider", return_value=False),
        patch(
            "hermes_cli.model_normalize.normalize_model_for_provider",
            return_value="test-model",
        ),
        patch("agent.credential_pool.load_pool", return_value=MagicMock()),
        patch("hermes_cli.config.load_config", return_value={}),
        patch("hermes_cli.config.get_compatible_custom_providers", return_value=[]),
        patch("agent.iteration_budget.IterationBudget"),
        patch("hermes_cli.config.cfg_get", return_value=None),
        patch(
            "tools.tool_backend_helpers.managed_nous_tools_enabled",
            return_value=entitled,
        ),
        patch(
            "tools.tool_provider_gateway.resolve_tool_provider_gateway",
            return_value=gateway_config,
        ) as resolve_gateway,
        patch(
            "tools.tool_provider_gateway.connections",
            new=AsyncMock(return_value=connections),
        ) as gateway_connections,
    ):
        init_agent(
            agent,
            base_url="https://api.anthropic.com",
            api_key="test-key",
            provider=None,
            model="test-model",
            credential_pool=pool,
            skip_context_files=True,
            skip_memory=True,
            quiet_mode=True,
        )

    return agent, resolve_gateway, gateway_connections


def test_entitled_init_resolves_connected_toolkits_once_without_context():
    gateway_config = object()
    agent, resolve_gateway, gateway_connections = _initialize_agent_with_tool_provider(
        entitled=True,
        gateway_config=gateway_config,
        connections=[
            ProviderConnection("gmail", "connected"),
            ProviderConnection("slack", "not_connected"),
        ],
    )

    assert agent._tool_provider_context_id is None
    assert agent._tool_provider_connected_toolkits == ["gmail"]
    resolve_gateway.assert_called_once_with()
    gateway_connections.assert_awaited_once_with(
        gateway_config, [], "status", context_id=None
    )


def test_unentitled_init_leaves_connection_snapshot_unknown():
    agent, resolve_gateway, gateway_connections = _initialize_agent_with_tool_provider(
        entitled=False,
        gateway_config=object(),
        connections=[ProviderConnection("gmail", "connected")],
    )

    assert agent._tool_provider_context_id is None
    assert agent._tool_provider_connected_toolkits is None
    resolve_gateway.assert_not_called()
    gateway_connections.assert_not_awaited()
