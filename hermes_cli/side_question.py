"""Shared helpers for the /side ephemeral side-question command.

/side <question> answers a quick side question using the current
conversation as read-only context, without continuing the main task and
without mutating the main session's conversation history. The question runs
in a throwaway agent under its own task id; the parent history is snapshotted
into the prompt text, so the main session's messages are never touched
(cache-preserving by construction).

Used by all three surfaces:
  * gateway  — GatewaySlashCommandsMixin._handle_side_command
  * CLI      — CLICommandsMixin._handle_side_command
  * TUI      — tui_gateway prompt.side RPC
"""

from __future__ import annotations

from typing import Any, Dict, List

# Instructions prepended to every side question so the throwaway agent
# treats inherited history as reference-only (mirrors Codex CLI /side and
# Claude Code /btw semantics: context available, main task untouched).
SIDE_PROMPT_PREAMBLE = (
    "Use the conversation history below as background context only.\n"
    "Do not continue, resume, or complete any unfinished main task.\n"
    "Answer only the side question at the end. If the question can be "
    "answered briefly, answer briefly.\n\n"
)

# How many trailing parent messages to include as context.
SIDE_HISTORY_MAX_MESSAGES = 20


def compose_side_prompt(
    question: str,
    messages: List[Dict[str, Any]],
    max_messages: int = SIDE_HISTORY_MAX_MESSAGES,
) -> str:
    """Build the throwaway side-agent prompt from a parent-history snapshot.

    ``messages`` is read, never mutated — callers can (and do) pass their live
    conversation history. Content-part lists (multimodal messages) are
    flattened to their text parts.
    """
    history_lines: List[str] = []
    for msg in (messages or [])[-max_messages:]:
        if not isinstance(msg, dict):
            continue
        role = str(msg.get("role", "")).upper()
        content = msg.get("content", "")
        if isinstance(content, list):
            text_parts = [
                p.get("text", "") for p in content
                if isinstance(p, dict) and p.get("type") == "text"
            ]
            content = "\n".join(text_parts)
        if role and content:
            history_lines.append(f"{role}: {content}")
    history_text = "\n\n".join(history_lines)

    prompt = SIDE_PROMPT_PREAMBLE
    if history_text:
        prompt += f"<conversation_history>\n{history_text}\n</conversation_history>\n\n"
    prompt += f"<side_question>\n{question}\n</side_question>"
    return prompt
