"""app_connections — check/establish connections to external app accounts.

Registered only when the tool-provider gateway (tools/tool_provider_gateway.py)
is entitled. Wraps POST /v1/connections: "status" is a cheap, side-effect-free
read; "connect" initiates managed OAuth for toolkits that need it and returns
a connect_url, which this tool also tries to open in a local browser (mirrors
tools/mcp_oauth.py's _can_open_browser() + webbrowser.open pattern — degrades
to a printed URL on headless/SSH sessions).

NOT dispatched through the tool_search bridge — this is a normal, directly
visible core-when-entitled tool (see docs/design/tool-provider-bridge.md
section 2), so it does not thread the tool_search bridge's context_id: the
handler has no access to the agent session object through the standard
registry.dispatch() kwargs (task_id/session_id/user_task only), and
/v1/connections's response carries no context_id to store back regardless.
Every call passes context_id=None to the gateway client, which is a
deliberate, documented simplification, not an oversight.
"""

import json
import logging
import sys
import webbrowser
from typing import Any, Dict, List

from tools.registry import registry, tool_error

logger = logging.getLogger(__name__)

_POLL_MAX_ATTEMPTS = 6
_POLL_INTERVAL_SECONDS = 10


def _resolve_gateway():
    try:
        from tools.tool_backend_helpers import managed_nous_tools_enabled

        if not managed_nous_tools_enabled():
            return None
        from tools.tool_provider_gateway import resolve_tool_provider_gateway

        return resolve_tool_provider_gateway()
    except Exception:
        logger.debug("app_connections gateway resolution failed", exc_info=True)
        return None


def check_app_connections_available() -> bool:
    return _resolve_gateway() is not None


def _open_browser_best_effort(url: str) -> bool:
    """Try to open `url` in a local browser. Returns True iff it actually opened.

    Mirrors tools/mcp_oauth.py's _can_open_browser()/webbrowser.open() pattern:
    never attempt on a headless/SSH session, never raise.
    """
    try:
        from tools.mcp_oauth import _can_open_browser

        if not _can_open_browser():
            print(
                f"  (Headless environment detected — open this URL manually: {url})",
                file=sys.stderr,
            )
            return False
    except Exception:
        pass
    try:
        opened = webbrowser.open(url)
        if opened:
            print(f"  (Browser opened automatically: {url})", file=sys.stderr)
        else:
            print(
                f"  (Could not open browser automatically — open this URL manually: {url})",
                file=sys.stderr,
            )
        return bool(opened)
    except Exception:
        print(
            f"  (Could not open browser automatically — open this URL manually: {url})",
            file=sys.stderr,
        )
        return False


def _dispatch_app_connections(args: Dict[str, Any], **kw) -> str:
    action = str(args.get("action") or "").strip().lower()
    if action not in ("status", "connect"):
        return tool_error("action must be 'status' or 'connect'")
    toolkits = args.get("toolkits")
    if (
        not isinstance(toolkits, list)
        or not toolkits
        or not all(isinstance(t, str) and t.strip() for t in toolkits)
    ):
        return tool_error(
            "toolkits must be a non-empty list of toolkit name strings "
            "(e.g. ['gmail', 'googlecalendar'])"
        )
    toolkits = [t.strip() for t in toolkits]

    gw_config = _resolve_gateway()
    if gw_config is None:
        from tools.tool_backend_helpers import nous_tool_gateway_unavailable_message

        return tool_error(
            nous_tool_gateway_unavailable_message("external app-tool connections")
        )

    try:
        from model_tools import _run_async
        from tools.tool_provider_gateway import (
            ToolProviderGatewayError,
            ToolProviderTransportError,
            connections as _gw_connections,
        )

        results = _run_async(
            _gw_connections(gw_config, toolkits, action, context_id=None)
        )
    except ToolProviderGatewayError as exc:
        return tool_error(exc.message, code=exc.code)
    except ToolProviderTransportError as exc:
        return tool_error(f"Could not reach the app-connections gateway: {exc}")
    except Exception as exc:
        logger.warning("app_connections dispatch failed: %s", exc)
        return tool_error(f"Unexpected error checking connections: {exc}")

    connections_out: List[Dict[str, Any]] = []
    opened_any = False
    for conn in results:
        entry: Dict[str, Any] = {"toolkit": conn.toolkit, "status": conn.status}
        if conn.connect_url:
            entry["connect_url"] = conn.connect_url
        if conn.account_hint:
            entry["account_hint"] = conn.account_hint
        connections_out.append(entry)
        if action == "connect" and conn.connect_url:
            if _open_browser_best_effort(conn.connect_url):
                opened_any = True

    payload: Dict[str, Any] = {"connections": connections_out}
    if action == "connect":
        needs_auth = [c for c in connections_out if c.get("connect_url")]
        if needs_auth:
            payload["note"] = (
                (
                    "A browser tab was opened for you to sign in and authorize access. "
                    if opened_any
                    else "Open the connect_url(s) above in a browser to sign in and authorize access. "
                )
                + "After the user confirms they finished, call "
                "app_connections(action='status', "
                f"toolkits={toolkits!r}) to verify — poll at most "
                f"{_POLL_MAX_ATTEMPTS} times, about {_POLL_INTERVAL_SECONDS} seconds "
                "apart, before telling the user the connection did not complete."
            )
        else:
            payload["note"] = (
                "No new authorization was needed — the requested toolkit(s) "
                "are already connected."
            )
    return json.dumps(payload, ensure_ascii=False)


APP_CONNECTIONS_SCHEMA = {
    "name": "app_connections",
    "description": (
        "Check or establish connections to external app accounts (Gmail, GitHub, "
        "Google Calendar, Slack, etc.) that are reachable through tool_search / "
        "tool_call. Use action='status' to check whether toolkits are connected "
        "for the current user; use action='connect' to start sign-in for toolkits "
        "that need it (opens a browser tab when possible, otherwise prints a URL "
        "to open manually). After 'connect', poll action='status' a few times, "
        "several seconds apart, before retrying a tool call that was blocked on "
        "a missing connection — do not poll more than a handful of times in a row."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["status", "connect"],
                "description": (
                    "'status' checks current connection state (cheap, no side effects). "
                    "'connect' initiates sign-in for toolkits that need it."
                ),
            },
            "toolkits": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "Toolkit names to check/connect, e.g. ['gmail', 'googlecalendar']. "
                    "Use the toolkit name from tool_search results (the 'source_name' "
                    "field on provider hits)."
                ),
            },
        },
        "required": ["action", "toolkits"],
    },
}

registry.register(
    name="app_connections",
    toolset="app_connections",
    schema=APP_CONNECTIONS_SCHEMA,
    handler=_dispatch_app_connections,
    check_fn=check_app_connections_available,
    requires_env=[],
    emoji="🔌",
)
