# Read-Tool Eval — Results Log

## Feature 1: stat-based special-file guard (`_special_file_kind`)

**Change:** `read_file` stats the resolved path and refuses FIFOs, sockets,
and char/block devices with a plain-language note instead of blocking until
the exec timeout. Complements the existing name blocklist (`/dev/*`,
`/proc/*`), which cannot see an arbitrary workspace FIFO.

**A/B (file-only toolset, 3 reps, same prompts both arms):**

| fifo_hang | baseline | statguard | delta |
|---|---|---|---|
| opus-4.8 tokens | 40k | 23k | −43% |
| opus-4.8 turns | 5.7 | 4.0 | −30% |
| qwen3.8-max tokens | 122k | 26k | −79% |
| qwen3.8-max turns | 9.3 | 5.0 | −46% |
| qwen3.8-max wall (worst rep) | 618s | 115s | −81% |
| score (both models) | 1.00 | 1.00 | held |

Off-target tasks moved within ±rep noise, no directional pattern (guard
does not fire on regular files).

**Verdict: SHIP.** Pure efficiency win; accuracy ceiling held. Both models
recover *eventually* without the guard, but qwen pays ~7.5× tokens and up
to 10 minutes of wall per encounter.

**Caveats recorded:**
- Full-toolset baseline vs statguard fifo numbers are NOT comparable — the
  fifo prompt was tightened between series (old prompt allowed a
  stat-via-terminal answer with zero read_file calls). File-only arms are
  same-prompt.
- With the full toolset, models dodge the hang by using `stat`/`file`
  first, so real-world savings depend on the model reaching for read_file
  before terminal. qwen did so consistently in the file-only arm.

## Feature 2: unicode filename retry + near-miss suggestions (PR #82800)

**A/B (control = guard-only stack, same fixture, 3 reps):** unicode task
qwen 31k→16k tok (−48%), turns 6.7→3.7; opus 57k→33k (−42%), 8.3→5.0;
accuracy held 1.00. Near-miss: opus 40k→34k, qwen flat. Repair fires only
on invisible-encoding differences with exactly one match; homoglyph twins
and visible typos never auto-repair (pinned by tests).

**Verdict: SHIP.**

## Feature 3: past-EOF + empty-file notes (PR #82804)

**A/B (control = #82800 stack, 3 reps, past_eof + empty_config):**
qwen −18% tok / −26% tool calls / −17% turns; opus −10% tok, turns flat
(recovered cheaply already). Accuracy 1.00 both arms. Also fixes the
phantom-line bug (past-EOF returned content "900|" as if line 900
existed and were empty).

**Verdict: SHIP** — qwen-consistent efficiency win + correctness fix;
opus side is noise-level, which matches the feature's aim (it serves
models that can't infer around ambiguous silence).
