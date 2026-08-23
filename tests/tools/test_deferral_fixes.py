"""Deferral-layer fixes: behavior regression suite.

Each test class pins one user-visible behavior that was broken while the
tool_search bridge was active. Tests assert at public seams (planner
segment shapes, search results, listing lines, get_tool_definitions
output) — not private implementation details — so refactors that keep
the behavior keep the tests.

The bugs, as reproduced before the fix:

1. ``_plan_tool_batch_segments`` classified the literal name ``tool_call``
   as a sequential barrier, so a server opted in via
   ``supports_parallel_tool_calls: true`` silently lost all concurrency
   the moment the bridge activated (every deferred call arrives wrapped).
2. ``_short_desc`` cut at the first ``.`` anywhere, so "e.g.", "v1.2",
   and "api.github.com" truncated catalog listing lines to garbage.
3. The BM25 document didn't include the tool's source, so a query naming
   the service ("linear") missed tools whose own name omits it.
4. (docstring-only) the substring fallback documented a zero-IDF case
   that cannot occur with the Lucene IDF variant.
5. A ``check_fn`` verdict flip (credential appears, daemon starts) never
   invalidated the ``get_tool_definitions`` memo — the stale tool list
   survived until an unrelated registry mutation.
"""

import json
import time
import uuid
from types import SimpleNamespace

import pytest

from agent.tool_dispatch_helpers import _plan_tool_batch_segments
from tools.tool_search import _short_desc, build_catalog, search_catalog


def _tc(name, arguments="{}", call_id=None):
    return SimpleNamespace(
        id=call_id or f"call_{uuid.uuid4().hex[:8]}",
        type="function",
        function=SimpleNamespace(name=name, arguments=arguments),
    )


def _bridge_tc(underlying, arguments=None, call_id=None):
    """A tool_call bridge invocation as the model emits it."""
    return _tc(
        "tool_call",
        json.dumps({"name": underlying, "arguments": arguments or {}}),
        call_id=call_id,
    )


def _td(name, desc="", params=None, required=None):
    parameters = {"type": "object", "properties": params or {}}
    if required:
        parameters["required"] = required
    return {
        "type": "function",
        "function": {"name": name, "description": desc, "parameters": parameters},
    }


def _kinds(segments):
    return [kind for kind, _ in segments]


def _flatten_ids(segments):
    return [tc.id for _, calls in segments for tc in calls]


@pytest.fixture
def mcp_pair(monkeypatch):
    """Two tools on a parallel-opted-in MCP server, registered for real.

    Registers via the actual registry (so ``resolve_underlying_call``'s
    deferability check passes) and marks the server parallel-safe through
    the real provenance maps in ``tools.mcp_tool``.
    """
    from tools import mcp_tool
    from tools.registry import registry

    names = ["mcp__pytestsrv__alpha_read", "mcp__pytestsrv__beta_read"]
    for n in names:
        registry.register(
            name=n,
            toolset="mcp-pytestsrv",
            schema=_td(n, "Read-only test tool.")["function"],
            handler=lambda args, **kw: json.dumps({"ok": True}),
        )
    with mcp_tool._lock:
        for n in names:
            mcp_tool._mcp_tool_server_names[n] = "pytestsrv"
        mcp_tool._parallel_safe_servers.add("pytestsrv")
    yield names
    with mcp_tool._lock:
        mcp_tool._parallel_safe_servers.discard("pytestsrv")
        for n in names:
            mcp_tool._mcp_tool_server_names.pop(n, None)
    for n in names:
        registry.deregister(n)


class TestBridgePeelInPlanner:
    """Fix 1: batch admission is decided on the underlying tool."""

    def test_two_bridged_parallel_safe_mcp_calls_run_parallel(self, mcp_pair):
        alpha, beta = mcp_pair
        calls = [_bridge_tc(alpha, call_id="a"), _bridge_tc(beta, call_id="b")]
        segments = _plan_tool_batch_segments(calls)
        assert _kinds(segments) == ["parallel"]
        assert _flatten_ids(segments) == ["a", "b"]

    def test_bridged_call_to_non_opted_in_tool_stays_sequential(self, mcp_pair, monkeypatch):
        from tools import mcp_tool
        with mcp_tool._lock:
            mcp_tool._parallel_safe_servers.discard("pytestsrv")
        alpha, beta = mcp_pair
        calls = [_bridge_tc(alpha, call_id="a"), _bridge_tc(beta, call_id="b")]
        segments = _plan_tool_batch_segments(calls)
        assert _kinds(segments) == ["sequential"]
        # restore for the fixture's teardown symmetry
        with mcp_tool._lock:
            mcp_tool._parallel_safe_servers.add("pytestsrv")

    def test_bridge_lookups_are_parallel_safe(self):
        calls = [
            _tc("tool_search", '{"query": "issues"}', call_id="s1"),
            _tc("tool_search", '{"query": "pages"}', call_id="s2"),
            _tc("tool_describe", '{"name": "mcp__x__y"}', call_id="d1"),
        ]
        segments = _plan_tool_batch_segments(calls)
        assert _kinds(segments) == ["parallel"]
        assert _flatten_ids(segments) == ["s1", "s2", "d1"]

    def test_malformed_bridge_call_stays_a_barrier(self):
        calls = [
            _tc("tool_call", '{"arguments": {}}', call_id="bad"),  # no name
            _tc("web_search", '{"query": "x"}', call_id="r1"),
            _tc("web_search", '{"query": "y"}', call_id="r2"),
        ]
        segments = _plan_tool_batch_segments(calls)
        assert _kinds(segments) == ["sequential", "parallel"]
        assert [tc.id for tc in segments[0][1]] == ["bad"]

    def test_emission_order_survives_the_peel(self, mcp_pair):
        alpha, beta = mcp_pair
        calls = [
            _bridge_tc(alpha, call_id="a"),
            _tc("terminal", '{"command": "make"}', call_id="t"),
            _bridge_tc(beta, call_id="b"),
        ]
        segments = _plan_tool_batch_segments(calls)
        assert _flatten_ids(segments) == ["a", "t", "b"]

    def test_bridged_path_tools_get_path_conflict_analysis(self, tmp_path, monkeypatch):
        """A write_file smuggled through the bridge must not share a parallel
        segment with a bridged read of the same file — the peel exposes the
        underlying args to the path-overlap analysis."""
        monkeypatch.chdir(tmp_path)
        calls = [
            _bridge_tc("write_file", {"path": "a.py", "content": "x"}, call_id="w"),
            _bridge_tc("read_file", {"path": "a.py"}, call_id="r"),
        ]
        # write_file/read_file are core tools, not deferrable, so the peel
        # refuses them (resolve_underlying_call errors) and both stay
        # sequential barriers — same net safety as before the fix.
        segments = _plan_tool_batch_segments(calls)
        for kind, seg_calls in segments:
            ids = [tc.id for tc in seg_calls]
            assert not (kind == "parallel" and {"w", "r"} <= set(ids))


class TestShortDescSentenceBoundary:
    """Fix 2: listing lines survive abbreviations, versions, hostnames."""

    def test_clean_two_sentence_case_still_clips_at_first(self):
        assert _short_desc("Open an issue. Second sentence dropped.") == "Open an issue."

    def test_abbreviation_does_not_truncate(self):
        s = _short_desc("Create an issue (e.g. a bug report) in a repository.")
        assert s.startswith("Create an issue (e.g. a bug report)")

    def test_hostname_does_not_truncate(self):
        s = _short_desc("Fetch a page from api.github.com and return the JSON body.")
        assert "api.github.com" in s

    def test_version_string_does_not_truncate(self):
        s = _short_desc("Upgrade to v1.2 of the schema and migrate all rows.")
        assert "v1.2" in s

    def test_exclamation_terminator_is_kept(self):
        assert _short_desc("List repos! Supports pagination.") == "List repos!"

    def test_question_terminator_is_kept(self):
        s = _short_desc("What does this do? It lists channels.")
        assert s == "What does this do?"

    def test_long_text_still_clips_with_ellipsis(self):
        s = _short_desc("word " * 40)
        assert len(s) <= 61
        assert s.endswith("…")

    def test_empty_is_empty(self):
        assert _short_desc("") == ""


class TestSourceNameIndexing:
    """Fix 3: a query naming the service finds that source's tools."""

    @staticmethod
    def _register(name, toolset, desc):
        from tools.registry import registry

        registry.register(
            name=name,
            toolset=toolset,
            schema=_td(name, desc)["function"],
            handler=lambda args, **kw: json.dumps({"ok": True}),
        )
        return name

    def test_service_query_reaches_tool_without_service_in_name(self):
        """A plugin tool named ``create_issue`` in toolset ``mcp-linear``
        must be reachable by the query "linear"."""
        from tools.registry import registry

        names = [
            self._register("create_issue", "mcp-linear", "Create a new issue in a team."),
            self._register("post_message", "mcp-slack", "Post a message to a channel."),
        ]
        try:
            defs = [_td(n, d) for n, d in
                    [("create_issue", "Create a new issue in a team."),
                     ("post_message", "Post a message to a channel.")]]
            catalog = build_catalog(defs)
            hits = search_catalog(catalog, "linear")
            assert [h.name for h in hits] == ["create_issue"]
        finally:
            for n in names:
                registry.deregister(n)

    def test_mcp_prefix_is_not_a_matchable_token(self):
        """The shared ``mcp`` prefix used to sit in every native MCP document
        as a near-zero-IDF token: a query containing "mcp" matched EVERY
        tool, drowning the discriminating terms. Now "mcp" contributes
        nothing to ranking, so the discriminating term decides alone."""
        from tools.registry import registry

        names = [
            self._register("mcp__linear__create_issue", "mcp-linear", "Create an issue."),
            self._register("mcp__slack__post_message", "mcp-slack", "Post a message."),
        ]
        try:
            defs = [_td("mcp__linear__create_issue", "Create an issue."),
                    _td("mcp__slack__post_message", "Post a message.")]
            catalog = build_catalog(defs)
            hits = search_catalog(catalog, "mcp message")
            # Before the fix "mcp" BM25-matched both docs, so both came
            # back and the order was decided by document length, not by
            # the term the model actually meant.
            assert [h.name for h in hits] == ["mcp__slack__post_message"]
        finally:
            for n in names:
                registry.deregister(n)

    def test_substring_fallback_covers_token_misses(self):
        """"hub" is a substring of github but never a token — the fallback
        (not BM25) must return the github tools."""
        from tools.registry import registry

        names = [
            self._register("github_create_issue", "mcp-github", "Create an issue."),
            self._register("github_merge_pr", "mcp-github", "Merge a pull request."),
        ]
        try:
            defs = [_td("github_create_issue", "Create an issue."),
                    _td("github_merge_pr", "Merge a pull request.")]
            catalog = build_catalog(defs)
            hits = search_catalog(catalog, "hub")
            assert {h.name for h in hits} == {"github_create_issue", "github_merge_pr"}
            assert search_catalog(catalog, "zzzz") == []
        finally:
            for n in names:
                registry.deregister(n)


class TestCheckFnFlipBustsToolDefsMemo:
    """Fix 5: an availability flip propagates without a registry mutation."""

    def test_verdict_flip_changes_tool_definitions(self, monkeypatch):
        import model_tools
        from tools.registry import registry, invalidate_check_fn_cache

        available = {"value": False}

        def _flip_check():
            return available["value"]

        registry.register(
            name="flip_gated_tool",
            toolset="fliptest",
            schema=_td("flip_gated_tool", "Gated test tool.")["function"],
            handler=lambda args, **kw: json.dumps({"ok": True}),
            check_fn=_flip_check,
        )
        try:
            model_tools._clear_tool_defs_cache()
            invalidate_check_fn_cache()

            # skip_tool_search_assembly: assert on the raw exposed list —
            # deferral would otherwise (correctly) fold a plugin tool into
            # the bridge and hide the name we're asserting on. The memo
            # path under test is identical for both shapes.
            names_before = {
                t["function"]["name"]
                for t in model_tools.get_tool_definitions(
                    enabled_toolsets=["fliptest"], quiet_mode=True,
                    skip_tool_search_assembly=True,
                )
            }
            assert "flip_gated_tool" not in names_before

            # The flip: credential lands / daemon starts. No registry
            # mutation. Config untouched. Same toolsets. The TTL cache is
            # cleared the way `hermes tools enable` / config writers do.
            available["value"] = True
            invalidate_check_fn_cache()

            names_after = {
                t["function"]["name"]
                for t in model_tools.get_tool_definitions(
                    enabled_toolsets=["fliptest"], quiet_mode=True,
                    skip_tool_search_assembly=True,
                )
            }
            assert "flip_gated_tool" in names_after
        finally:
            registry.deregister("flip_gated_tool")
            model_tools._clear_tool_defs_cache()
            invalidate_check_fn_cache()

    def test_memo_still_hits_within_ttl(self, monkeypatch):
        """The fix must not disable memoization: with stable verdicts, repeat
        calls must be served from cache (probes may run; compute must not).

        A warmup call settles lazy registration first — the first compute
        after registry churn registers dynamic tools itself, which bumps the
        generation and changes the key. That warmup miss predates this fix;
        what this test pins is that the verdict-snapshot key member does not
        introduce PERPETUAL misses.
        """
        import model_tools
        from tools.registry import registry, invalidate_check_fn_cache

        probe_calls = {"n": 0}

        def _steady_check():
            probe_calls["n"] += 1
            return True

        registry.register(
            name="steady_gated_tool",
            toolset="steadytest",
            schema=_td("steady_gated_tool", "Gated test tool.")["function"],
            handler=lambda args, **kw: json.dumps({"ok": True}),
            check_fn=_steady_check,
        )
        try:
            model_tools._clear_tool_defs_cache()
            invalidate_check_fn_cache()

            # Warmup: let lazy registration inside compute settle the
            # generation, then once more to seed the settled key.
            for _ in range(2):
                model_tools.get_tool_definitions(
                    enabled_toolsets=["steadytest"], quiet_mode=True)

            compute_calls = {"n": 0}
            real_compute = model_tools._compute_tool_definitions

            def _counting_compute(*args, **kwargs):
                compute_calls["n"] += 1
                return real_compute(*args, **kwargs)

            monkeypatch.setattr(model_tools, "_compute_tool_definitions", _counting_compute)

            first = model_tools.get_tool_definitions(
                enabled_toolsets=["steadytest"], quiet_mode=True)
            second = model_tools.get_tool_definitions(
                enabled_toolsets=["steadytest"], quiet_mode=True)

            assert compute_calls["n"] == 0
            assert [t["function"]["name"] for t in first] == \
                   [t["function"]["name"] for t in second]
        finally:
            registry.deregister("steady_gated_tool")
            model_tools._clear_tool_defs_cache()
            invalidate_check_fn_cache()
