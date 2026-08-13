/**
 * Pure `@profile` mention semantics for group chats — Buzz-derived rules,
 * collapsed to local profiles (no pubkeys, no network):
 *
 *   - `@` counts only at start-of-string or after whitespace (never emails,
 *     never mid-word), matching buzz-sdk's extract_at_names.
 *   - Mentions inside code fences/spans are ignored (strip_code_regions).
 *   - Known names match longest-first so `babe-work` wins over `babe` when
 *     both exist; bare-name matches require a word boundary after the name.
 *   - Self-mentions are dropped by callers (a profile never wakes itself).
 *   - ADDRESSED vs NARRATIVE: only a mention that leads the message (or leads
 *     a line) addresses the profile — "waiting on @morgan" mid-sentence is
 *     narrative and must not fire a turn. Buzz shipped this rule after a loop
 *     spammed a member with false notifications.
 *
 * The composer's canonical wire form `@profile:babe` is also recognized, and
 * is ALWAYS addressed — picking a chip is deliberate.
 */

export interface ProfileMentions {
  /** Profiles this message addresses — these get a full turn. */
  addressed: string[]
  /** Profiles named mid-prose — context only, never a trigger. */
  narrative: string[]
}

const WIRE_PROFILE_RE = /(?<![\w/])@profile:(`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|\S+)/g

/** Fenced/inline code carries literal `@`s (decorators, scoped npm packages);
 *  blank the regions out, preserving offsets, before any mention scan. */
export function stripCodeRegions(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, region => ' '.repeat(region.length))
    .replace(/`[^`\n]*`/g, region => ' '.repeat(region.length))
}

function unquote(raw: string): string {
  const head = raw[0]
  const tail = raw[raw.length - 1]

  if (raw.length >= 2 && head === tail && (head === '`' || head === '"' || head === "'")) {
    return raw.slice(1, -1)
  }

  return raw.replace(/[,.;:!?)\]}]+$/, '')
}

/**
 * Extract profile mentions from message text.
 *
 * `knownNames` scopes bare `@name` matching to real profiles (longest-first),
 * so `@8pm` in prose can't invent a member. Wire refs (`@profile:x`) resolve
 * even when unknown — the composer inserted them deliberately.
 */
export function extractProfileMentions(text: string, knownNames: readonly string[]): ProfileMentions {
  const addressed = new Set<string>()
  const narrative = new Set<string>()

  if (!text || !text.includes('@')) {
    return { addressed: [], narrative: [] }
  }

  const scan = stripCodeRegions(text)

  // Wire form first: always addressed, wherever it sits. A chip is a choice.
  for (const match of scan.matchAll(WIRE_PROFILE_RE)) {
    const name = unquote(match[1] ?? '').trim().toLowerCase()

    if (name) {
      addressed.add(name)
    }
  }

  // Bare `@name` against known profiles, longest name first so a profile
  // whose name prefixes another can't steal its mentions.
  const byLength = [...knownNames].filter(name => name && name !== 'default').sort((a, b) => b.length - a.length)

  for (const known of byLength) {
    const lower = known.toLowerCase()
    let from = 0

    for (;;) {
      const at = scan.toLowerCase().indexOf(`@${lower}`, from)

      if (at === -1) {
        break
      }

      from = at + 1

      const before = at === 0 ? '' : scan[at - 1]
      const afterIndex = at + 1 + lower.length
      const after = afterIndex >= scan.length ? '' : scan[afterIndex]

      // `@` must sit at a whitespace boundary; the name must end at one too
      // (or at punctuation), or `@babe` would match inside `@babe-work`.
      if ((before && !/\s/.test(before)) || (after && /[\w-]/.test(after))) {
        continue
      }

      if (addressed.has(lower)) {
        continue
      }

      // Addressed = the mention LEADS: first non-whitespace of the message or
      // of its line. Anything mid-prose is narrative.
      const lineStart = scan.lastIndexOf('\n', at) + 1
      const leading = scan.slice(lineStart, at).trim() === ''

      if (leading) {
        addressed.add(lower)
      } else {
        narrative.add(lower)
      }
    }
  }

  for (const name of addressed) {
    narrative.delete(name)
  }

  return { addressed: [...addressed], narrative: [...narrative] }
}
