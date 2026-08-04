# Tool-provider bridge integration (branch `sid/composio-bridge`)

Prototype spec, 2026-08-04. Wire contract: see tool-gateway branch `sid/tool-provider-v1`,
`docs/tool-provider-v1-contract.md`. Decisions D2/D5/D6 from the planning session apply:
demo surface is the CLI/TUI; one opaque `context_id` per hermes session shared with subagents;
gateway tools ride the EXISTING bridge — no new disclosure surface.

## What changes, where

### 1. Gateway catalog source (`tools/tool_search.py`)

Today the bridge (`tool_search` / `tool_describe` / `tool_call`) covers deferrable tools:
MCP (`toolset.startswith("mcp-")`) and non-core plugin tools, indexed by local BM25.

Add a second, remote catalog source: **provider tools** from `tools-gateway` `/v1/search`.

- `tool_search(query)` fans out in parallel (asyncio.gather): local BM25 + `POST /v1/search`
  with `queries=[query]`, `model=<current model>`, `context_id` from session state.
  Merge: local hits and gateway hits interleaved, gateway results labeled by toolkit; dedupe
  is a non-issue (namespaces don't overlap). Gateway timeout ~8s; on timeout/error return local
  results plus a one-line notice — never fail the whole search.
- Gateway availability gate: reuse `tools/tool_backend_helpers.py::managed_nous_tools_enabled()`
  semantics — Nous portal account present AND entitled. Resolve the origin via
  `tools/managed_tool_gateway.py` patterns (`build_vendor_gateway_url("tools")`, honoring
  `TOOLS_GATEWAY_URL` / `TOOL_GATEWAY_DOMAIN` overrides). Auth: same Nous OAuth bearer as other
  managed vendors (`read_nous_access_token()`).
- `tool_describe(slug)` for a gateway slug → `/v1/schemas` (most gateway hits already carry
  `input_schema` inline from search; describe is the fallback path).
- `tool_call(slug, args)` for a gateway slug → `/v1/execute` with `tools=[{slug, arguments}]`.
  Multiple independent gateway calls in one assistant turn MAY batch into one `/v1/execute`
  (contract supports 1–50) — implement single-call first, batch as a follow-up.
  Dispatch goes through the normal registry/executor path so approvals, guardrails, truncation,
  and trajectory display apply identically (`resolve_underlying_call` learns a provider-slug
  branch; scoping via `agent/tool_executor.py::_tool_search_scoped_names` must include/exclude
  provider tools per session toolset restrictions, so subagents keep working).

Catalog listing: when entitled, the token-budgeted catalog block gains one line-item family
("external app tools via search"), NOT an enumeration of 100 toolkits — the whole point is
progressive disclosure; search is the enumeration.

### 2. Connections tool (new, visible core-when-entitled tool)

New registered tool `app_connections` (exact name TBD at impl; NOT named after the vendor),
registered only when the gateway is entitled (same `check_fn` pattern other gated tools use):

- `app_connections(action="status", toolkits=[...])` → `/v1/connections` status.
- `app_connections(action="connect", toolkits=[...])` → `/v1/connections` connect; returns
  `connect_url`. The CLI/TUI handler auto-opens the browser (existing MCP dashboard-OAuth
  open-browser pattern in `web/src/lib/mcp-dashboard-oauth.ts` is the UX precedent; for the
  terminal use `webbrowser.open` + printed fallback URL) and the tool response tells the model
  to poll `status` (bounded: ~6 polls x 10s) before retrying the blocked tool call.

### 3. Session-init auth state injection

- `agent/agent_init.py::init_agent` — when entitled, fetch `/v1/connections` `status` for the
  enabled-toolkit set (single cheap call), store on the agent session.
- `agent/prompt_builder.py::build_nous_subscription_prompt()` (stable tier) — extend the existing
  "# Nous Subscription" block with connected/available app-tool state: connected toolkits listed,
  plus one line explaining search/connect ("External app tools are available via tool_search;
  connect accounts with app_connections."). Keep it short — this block is cached per session.

### 4. `context_id` state

- Stored on the agent session object at first `/v1/search` response; echoed on every subsequent
  /v1 call in that session, INCLUDING calls made on behalf of subagents (delegate_task children
  execute tools in-process through the same executor — they inherit, never re-mint).
- Respect `agent/secret_scope.py` multiplex isolation: context_id and the Nous token both resolve
  per-profile; never module-global.

### 5. Out of scope (do not touch)

Hermes terminal/Modal tools ("remote bash/workbench" in the brief = Composio's meta-tools, which
the gateway never exposes). MCP machinery. Existing pinned vendor gateways. Dashboard code is a
separate task (Capabilities page), not part of the bridge change.

## Verification

- Unit: bridge fan-out merge with gateway mocked (respx/httpx mock), entitlement-off ⇒ identical
  behavior to main, gateway-timeout ⇒ local-only results.
- Field: tmux-driven CLI session against the local stack (live-local NAS + local gateway):
  prompt "find top hackernews stories and fetch one" must produce tool_search → (inline schema)
  → tool_call → real data in transcript with zero manual steps. OAuth toolkit flow verified
  separately with the browser harness (Google needs one manual assist — known boundary).

File/line references above come from the 2026-08-04 exploration pass; re-verify exact symbols
against the worktree before coding (registry/config internals move).
