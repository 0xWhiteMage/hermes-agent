#!/usr/bin/env python3
"""Prove the GUI-tool fix over a REAL remote gateway, not an in-process call.

Stands up `hermes serve` in a subprocess with a scrubbed environment — no
HERMES_DESKTOP — which is exactly what a URL-token or Hermes Cloud backend
looks like. Then talks JSON-RPC over the WebSocket the desktop app uses,
creates a session with source='desktop' (and one with source='tui'), and asks
the gateway which tools that session's agent actually got.

Usage: PYTHONPATH=<repo> .venv/bin/python scripts/probe_remote_gui_tools.py
"""

import asyncio
import json
import os
import secrets
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import websockets

REPO = Path(__file__).resolve().parent.parent
GUI_TOOLS = {
    "close_terminal",
    "focus_pane",
    "open_preview",
    "react_to_message",
    "read_preview",
    "read_terminal",
}


def scrubbed_env(hermes_home: Path, token: str) -> dict:
    """The env a backend we did NOT spawn would have: no desktop markers."""
    env = {
        k: v
        for k, v in os.environ.items()
        if not k.startswith(("HERMES_DESKTOP", "HERMES_TUI_TOOLSETS"))
    }
    env.pop("HERMES_DESKTOP", None)
    env.update(
        HERMES_HOME=str(hermes_home),
        HERMES_DASHBOARD_SESSION_TOKEN=token,
        PYTHONPATH=str(REPO),
        PYTHONUNBUFFERED="1",
        # The agent must BUILD for us to read its resolved toolsets. Building
        # needs a provider; it is never called (we send no prompt), so a dummy
        # key is enough and keeps the probe offline.
        OPENROUTER_API_KEY="sk-probe-not-a-real-key",
        HERMES_MODEL="openai/gpt-4o-mini",
    )
    return env


def start_backend(hermes_home: Path, token: str, log: Path):
    """Launch `hermes serve` and scrape the port it binds."""
    proc = subprocess.Popen(
        [
            sys.executable,
            "-c",
            "import sys; from hermes_cli.main import main; sys.exit(main())",
            "serve",
            "--isolated",
            "--host",
            "127.0.0.1",
            "--port",
            "0",
        ],
        cwd=str(REPO),
        env=scrubbed_env(hermes_home, token),
        stdout=log.open("wb"),
        stderr=subprocess.STDOUT,
    )

    deadline = time.time() + 120
    while time.time() < deadline:
        if proc.poll() is not None:
            raise SystemExit(f"backend exited early ({proc.returncode}); see {log}")
        text = log.read_text(errors="replace")
        # `hermes serve` announces its bound port on stdout once listening.
        marker = "HERMES_BACKEND_READY port="
        idx = text.find(marker)
        if idx >= 0:
            digits = ""
            for ch in text[idx + len(marker) :]:
                if ch.isdigit():
                    digits += ch
                else:
                    break
            if digits:
                return proc, int(digits)
        time.sleep(0.5)

    proc.kill()
    raise SystemExit(f"backend never reported a port; see {log}")


async def rpc(ws, method: str, params: dict, rid: int):
    await ws.send(json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}))
    while True:
        raw = await asyncio.wait_for(ws.recv(), timeout=180)
        msg = json.loads(raw)
        if msg.get("id") == rid:
            if "error" in msg:
                raise SystemExit(f"{method} failed: {msg['error']}")
            return msg.get("result", {})


async def tools_for_source(port: int, token: str, source: str) -> set:
    url = f"ws://127.0.0.1:{port}/api/ws?token={token}"
    async with websockets.connect(url, max_size=32 * 1024 * 1024) as ws:
        created = await rpc(ws, "session.create", {"cols": 96, "source": source}, 1)
        sid = created["session_id"]

        # session.create defers the agent build. `process.list` goes through
        # the gateway's _sess() helper, which forces the build and blocks
        # until it lands — so the toolsets we read next are the REAL agent's,
        # not the no-session fallback. Its wait caps at 30s while a cold build
        # (MCP discovery, skills scan) can exceed that; the build keeps going
        # in the background, so retry until it lands.
        for attempt in range(12):
            try:
                await rpc(ws, "process.list", {"session_id": sid}, 2 + attempt)
                break
            except SystemExit as exc:
                if "timed out" not in str(exc):
                    raise
        else:
            raise SystemExit("agent never finished building")

        shown = await rpc(ws, "tools.show", {"session_id": sid}, 99)
        names: set = set()
        _collect_tool_names(shown.get("sections"), names)
        return names


def _collect_tool_names(node, out: set) -> None:
    """tools.show groups tools by section; tolerate list- or dict-shaped groups."""
    if isinstance(node, dict):
        if isinstance(node.get("name"), str) and "parameters" not in node:
            out.add(node["name"])
        for value in node.values():
            _collect_tool_names(value, out)
    elif isinstance(node, list):
        for item in node:
            _collect_tool_names(item, out)


async def main() -> int:
    with tempfile.TemporaryDirectory(prefix="gui-probe-") as tmp:
        home = Path(tmp) / "hermes-home"
        home.mkdir(parents=True)
        # react_to_message is additionally opt-in (Settings → Appearance, which
        # the desktop mirrors to display.message_reactions on the CONNECTED
        # gateway). Turn it on so the probe covers all six tools; the other
        # five are surface-gated only.
        (home / "config.yaml").write_text("display:\n  message_reactions: true\n")
        token = secrets.token_hex(16)
        log = Path(tmp) / "backend.log"

        try:
            proc, port = start_backend(home, token, log)
        except SystemExit:
            print("--- backend log ---")
            print(log.read_text(errors="replace")[-4000:])
            raise
        print(f"backend up on 127.0.0.1:{port}  (HERMES_DESKTOP unset in its env)")

        try:
            results = {}
            for source in ("desktop", "tui"):
                names = await tools_for_source(port, token, source)
                results[source] = sorted(GUI_TOOLS & names)
                print(f"  source={source:8s} total={len(names):3d} gui={results[source]}")
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                proc.kill()

    ok = len(results["desktop"]) == len(GUI_TOOLS) and not results["tui"]
    print("\nPASS" if ok else "\nFAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
