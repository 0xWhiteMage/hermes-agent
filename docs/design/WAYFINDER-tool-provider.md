# Wayfinder — tool-provider bridge + Capabilities dashboard (branch `sid/composio-bridge`)

Prototype branch, never merges to main. Built 2026-08-04. Pairs with tool-gateway
`sid/tool-provider-v1` and NAS `sid/composio-control-plane` (each has its own wayfinder).
Design spec: `docs/design/tool-provider-bridge.md`. Wire contract: gateway repo,
`docs/tool-provider-v1-contract.md`.

## Map

- `tools/tool_provider_gateway.py` — typed client for gateway `/v1/*` (origin via
  `resolve_managed_tool_gateway("tools")`, override `TOOLS_GATEWAY_URL`).
- `tools/tool_search.py` — bridge fan-out (local BM25 + gateway search, merged, inline
  schemas), provider-slug dispatch (`SCREAMING_SNAKE_CASE` heuristic), `capture_context_id`.
- `model_tools.py` — provider slugs route through TWO insertion points (`tool_call` gets
  pre-unwrapped in two paths — both patched; regressions hide here).
- `tools/app_connections_tool.py` — visible connect/status tool; headless-safe (prints URL
  when no display); bounded polling.
- `agent/agent_init.py` + `agent/prompt_builder.py` — session-init `/v1/connections` probe
  (empty list = all enabled) + "External app tools" line in the Nous Subscription block.
- `tools/delegate_tool.py` — children inherit `_tool_provider_context_id`/connected set.
- Dashboard: `web/src/pages/CapabilitiesPage.tsx` (+ `McpServersSection.tsx`,
  `lib/capability-catalog.ts`), backend proxy `hermes_cli/web_routers/capabilities.py`
  (→ NAS `/api/portal/tools/*`). `/mcp` → `/capabilities`; McpPage deleted.
  Design reference under `web/design-reference/` (partial by design — composed HTML +
  Toolkits.jsx + tools.css fully specify the port).

## Isolated live-run recipe (proven by the e2e field test)

Never touch real `~/.hermes`. Use:
- `HERMES_HOME=<scratch>/hermes-home`
- `HERMES_PORTAL_BASE_URL=http://127.0.0.1:3111` (trusted operator escape hatch in
  `hermes_cli/auth.py` — bypasses host allowlist)
- `TOOLS_GATEWAY_URL=http://tools-gateway.localhost:3009` (glibc resolves `.localhost`)
- `TOOL_GATEWAY_USER_TOKEN=<minted JWT>` AND the same JWT in the isolated
  `auth.json` at `providers.nous.access_token` (+ `portal_base_url`). Entitlement is
  satisfied by local decode of the `paid_access` claim — no network call.
- Model key: copy ONLY the model provider key (e.g. `OPENROUTER_API_KEY`) into the profile.
- Token TTL is 900s and is baked into the process env at launch — RE-MINT AND RELAUNCH,
  a refreshed auth.json does not help a running process.

Mint command lives in the NAS wayfinder. E2E transcripts from the rehearsal:
`/tmp/claude-1001/-home-daimon-github/850540eb-b16a-49d8-96d0-6ac86358ab4c/scratchpad/e2e-transcripts/`.

## Demo-day notes (from the rehearsal)

1. **Lead with auth-required apps** (Calendar/Gmail/GitHub). Public-API asks (HackerNews)
   invite the model to bypass the bridge with `terminal`+curl — real data, wrong mechanism.
   Composio search also misroutes HN-shaped queries.
2. Mint a fresh token immediately before the demo (900s TTL).
3. Real Google/GitHub OAuth completion is a human step (browser login wall) — the harness
   proves everything up to the wall; `check-connection.ts` (gateway repo) picks up after.
4. Subagent gateway usage is code-complete but live-unproven (child terminal approvals
   fail closed in background sessions — known friction).
5. Init probe adds ~0.5s to session start; search 2.5–4.6s; execute ~1–1.3s.

## Verification

- Bridge tests: per-file pytest (repo convention — full-suite runs hit pre-existing
  order-dependent pollution, not this branch's fault). 617 passed at commit time.
- Dashboard: `tsc -b`, `vite build`, `vitest run` (156), backend router pytest (5).
- Live screenshots: scratchpad `logs/capabilities-{page,admin,slideover}.png`.
