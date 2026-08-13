/**
 * Group chat: N profiles + the user in one room.
 *
 * ── Architecture ────────────────────────────────────────────────────────────
 * Each profile is its own backend process; the ONLY party connected to all of
 * them at once is this renderer (the multi-profile socket registry in
 * store/gateway.ts). So the room lives here: a group is a routing overlay over
 * N ordinary per-profile sessions — each member keeps its own transcript,
 * memory, and cache prefix (profiles stay islands, by design), and the desktop
 * composites the conversation. No new backend surface: fan-out is
 * `prompt.submit` on the member's socket, fan-in is its `message.complete`.
 *
 * ── Camp-1 rules (Buzz-derived, see /tmp/buzz audit) ───────────────────────
 * There is no speaker-selection referee. Addressing decides who speaks:
 *   - The user's message fires a turn for each ADDRESSED profile; everyone
 *     else receives it as context on their next turn (fan-in batch).
 *   - A member's reply fires a turn only for profiles it @-addresses
 *     (mention-gated agent↔agent, Buzz's require_mention default).
 *   - Narrative mentions ("waiting on @morgan") never trigger.
 * What IS centralized — the two things Buzz proves you need, which their
 * relay-race topology couldn't build and ours can:
 *   - SERIALIZATION: one in-flight turn per member per room. Messages that
 *     arrive mid-turn batch into the member's next prompt (queue-and-batch),
 *     so a busy profile never runs concurrent turns over one transcript.
 *   - CIRCUIT BREAKER: after AGENT_CHAIN_LIMIT consecutive agent-authored
 *     turns with no user message, agent→agent triggers stop routing (context
 *     still fans in). Any user message resets the chain. Deliberately high —
 *     a low cap truncates legitimate coordination; a too-aggressive breaker
 *     manufactures silent failures (Buzz's welcome-kickoff postmortem).
 */

import { atom } from 'nanostores'

import type { GatewayEvent } from '@hermes/shared'
import { PROMPT_SUBMIT_REQUEST_TIMEOUT_MS } from '@/hermes'
import { extractProfileMentions } from '@/lib/profile-mentions'
import { readJson, writeJson } from '@/lib/storage'
import { ensureGatewayForProfile, gatewayForProfileKey, openGatewayForProfile } from '@/store/gateway'
import { $activeGatewayProfile, $profiles, normalizeProfileKey } from '@/store/profile'

/** Unbroken agent-authored turns before agent→agent triggers stop routing.
 *  A user message resets the chain. */
export const AGENT_CHAIN_LIMIT = 8

export interface GroupMember {
  profile: string
  /** The member's own backend session inside this group. Created lazily on
   *  its first turn; stable thereafter — it IS the member's transcript. */
  sessionId: string | null
  /** Mention-gated by default (Buzz require_mention). `all` = free responder:
   *  every user message fires a turn. Agent messages stay mention-gated even
   *  for `all` — a free-responder pair would loop by construction. */
  respondTo: 'mentions' | 'all'
  /** Muted: stays in the room, keeps receiving context, never fires turns. */
  muted: boolean
  /** The chat this room grew out of. The host's session IS the room's home
   *  surface: the normal composer path owns its user-message turns (so we
   *  never double-fire them), and member replies land in it as `[name]:`
   *  prompts — which is how they both appear in the transcript and reach the
   *  host agent. */
  host?: boolean
}

export interface GroupTurnRequest {
  /** Room-visible author of the triggering message: 'user' or a profile. */
  author: string
  text: string
}

interface MemberRuntime {
  /** In-flight turn guard — the serialization rule. */
  running: boolean
  /** Messages that arrived while running (or before triggering); drained
   *  into ONE batched prompt on the member's next turn. */
  pending: GroupTurnRequest[]
  /** True when a pending entry addresses this member (a turn is owed). */
  turnOwed: boolean
  /** Host only: room rules delivered (they ride the first fan-in prompt —
   *  the host's session predates the room, so there's no join preamble). */
  briefed: boolean
}

export interface GroupChat {
  id: string
  members: GroupMember[]
  /** Consecutive agent-authored turns since the last user message. */
  agentChain: number
  /** Set when the breaker fired; cleared by the next user message. */
  breakerTripped: boolean
}

export const $groupChats = atom<Record<string, GroupChat>>(loadPersistedGroups())

// ── Persistence ─────────────────────────────────────────────────────────────
// Rooms survive an app restart: membership + member session ids persist per
// window (scope declared in the key). Ephemeral runtime (in-flight guards,
// pending batches, typing) deliberately does NOT persist — a restart clears
// in-flight state by definition. Transcripts don't persist either: the room
// view rebuilds from the HOST session's stored history, which already carries
// every [name]: message durably (backend-authoritative, renderer is a cache).
const GROUPS_STORAGE_KEY = 'hermes.desktop.groupChats.v1'

function loadPersistedGroups(): Record<string, GroupChat> {
  const raw = readJson<Record<string, GroupChat>>(GROUPS_STORAGE_KEY)

  if (!raw || typeof raw !== 'object') {
    return {}
  }

  // Chains/breaker reset on load: a restart is a human-scale interruption,
  // and resuming a tripped breaker from storage would silently keep agents
  // paused with no visible cause.
  const groups: Record<string, GroupChat> = {}

  for (const key of Object.keys(raw)) {
    const group = raw[key]

    if (group && Array.isArray(group.members)) {
      groups[key] = { ...group, agentChain: 0, breakerTripped: false }
    }
  }

  return groups
}

$groupChats.subscribe(groups => writeJson(GROUPS_STORAGE_KEY, groups))

/** Profiles with a turn in flight, per group — the composer's typing dots. */
export const $groupTyping = atom<Record<string, string[]>>({})

function setTyping(groupId: string, profile: string, typing: boolean): void {
  const all = $groupTyping.get()
  const current = all[groupId] ?? []
  const next = typing ? (current.includes(profile) ? current : [...current, profile]) : current.filter(p => p !== profile)

  if (next !== current) {
    $groupTyping.set({ ...all, [groupId]: next })
  }
}

const runtimes = new Map<string, Map<string, MemberRuntime>>()

function runtimeFor(groupId: string, profile: string): MemberRuntime {
  let group = runtimes.get(groupId)

  if (!group) {
    group = new Map()
    runtimes.set(groupId, group)
  }

  let member = group.get(profile)

  if (!member) {
    member = { running: false, pending: [], turnOwed: false, briefed: false }
    group.set(profile, member)
  }

  return member
}

function patchGroup(groupId: string, patch: (group: GroupChat) => GroupChat): void {
  const groups = $groupChats.get()
  const group = groups[groupId]

  if (group) {
    $groupChats.set({ ...groups, [groupId]: patch(group) })
  }
}

/** Mention-as-invite: adding a member is idempotent, quiet, and prewarms the
 *  profile's backend so its first turn doesn't pay a cold boot. */
export function addGroupMember(groupId: string, profile: string): void {
  patchGroup(groupId, group =>
    group.members.some(member => member.profile === profile)
      ? group
      : {
          ...group,
          members: [...group.members, { profile, sessionId: null, respondTo: 'mentions', muted: false }]
        }
  )
  void openGatewayForProfile(profile)
}

/** Shared resolution for both submit halves: the room id, whether it exists,
 *  and which OTHER profiles this text addresses. The self-mention guard lives
 *  here — `@builder` typed in builder's own chat addresses the HOST, which is
 *  already present; "inviting" it tells the model it just summoned itself
 *  (observed: "you pinged me, here i am!" + confabulation about the feature). */
function resolveGroupMentions(
  sessionId: string,
  text: string
): { addressed: string[]; existing: GroupChat | undefined; groupId: string; hostProfile: string } | null {
  if (!text.includes('@')) {
    return null
  }

  const hostProfile = normalizeProfileKey($activeGatewayProfile.get())
  const known = $profiles
    .get()
    .map(profile => profile.name)
    .filter(name => name && normalizeProfileKey(name) !== hostProfile)

  const groupId = `session:${sessionId}`
  const existing = $groupChats.get()[groupId]
  const memberNames = existing ? existing.members.map(member => member.profile) : []
  const mentions = extractProfileMentions(text, [...new Set([...known, ...memberNames])])
  const addressed = mentions.addressed.filter(name => name !== hostProfile.toLowerCase())

  return addressed.length === 0 && !existing ? null : { addressed, existing, groupId, hostProfile }
}

/**
 * Pre-submit half of the in-chat upgrade: if `text` addresses other profiles,
 * upgrade the session to a room, add the mentioned members NOW, and return a
 * `group_note` for the submit — the model-input-only note that tells the HOST
 * agent, on this very turn, that the room exists and who's in it. Without it
 * the host's invite turn predates its own room and the agent "helpfully"
 * explains the feature doesn't exist. Returns '' for plain messages.
 */
export function prepareGroupSubmit(sessionId: string, text: string): string {
  const resolved = resolveGroupMentions(sessionId, text)

  if (!resolved) {
    return ''
  }

  const { addressed, existing, groupId, hostProfile } = resolved
  const memberNames = existing ? existing.members.map(member => member.profile) : []
  const invited = addressed.filter(name => !memberNames.some(member => member.toLowerCase() === name))

  ensureSessionGroup(sessionId, hostProfile)

  for (const name of addressed) {
    addGroupMember(groupId, name)
  }

  const roster = ($groupChats.get()[groupId]?.members ?? [])
    .filter(member => !member.host)
    .map(member => member.profile)

  const lines = [
    `[Group chat: this conversation is a room shared with the user and other agent profiles (${roster.join(', ') || 'none yet'}).`
  ]

  if (invited.length > 0) {
    lines.push(
      `The user's message just invited ${invited.join(', ')} — they are being woken now and their reply will arrive as a [name]: message. Do not claim you cannot invite profiles; it already happened.`
    )
  }

  lines.push(
    'Messages prefixed [name] are other participants speaking. Address one with @name to hand them the floor. You may end a turn without replying when you have nothing to add.]'
  )

  return lines.join('\n')
}

/**
 * Post-submit half: fan the user's message out to the addressed members.
 * Membership was already handled by prepareGroupSubmit; this only routes
 * (addGroupMember is idempotent, so a direct call without prepare also
 * works — the note is just skipped).
 */
export function maybeRouteGroupMentions(sessionId: string, text: string): void {
  const resolved = resolveGroupMentions(sessionId, text)

  if (!resolved) {
    return // plain message in a plain chat — the common case, zero cost
  }

  ensureSessionGroup(sessionId, resolved.hostProfile)

  for (const name of resolved.addressed) {
    addGroupMember(resolved.groupId, name)
  }

  routeGroupMessage(resolved.groupId, { author: 'user', text })
}

/**
 * The in-chat upgrade: ANY session becomes a room the first time its user
 * message addresses another profile. The session's own agent joins as the
 * `host` member (its session already exists — the chat itself); mentioned
 * profiles join as ordinary mention-gated members. Idempotent per session.
 */
export function ensureSessionGroup(sessionId: string, hostProfile: string): string {
  const groupId = `session:${sessionId}`

  if (!$groupChats.get()[groupId]) {
    $groupChats.set({
      ...$groupChats.get(),
      [groupId]: {
        id: groupId,
        members: [{ profile: hostProfile, sessionId, respondTo: 'all', muted: false, host: true }],
        agentChain: 0,
        breakerTripped: false
      }
    })
  }

  return groupId
}

export function removeGroupMember(groupId: string, profile: string): void {
  patchGroup(groupId, group => ({
    ...group,
    members: group.members.filter(member => member.profile !== profile)
  }))
  runtimes.get(groupId)?.delete(profile)
}

export function setMemberMuted(groupId: string, profile: string, muted: boolean): void {
  patchGroup(groupId, group => ({
    ...group,
    members: group.members.map(member => (member.profile === profile ? { ...member, muted } : member))
  }))
}

/**
 * Route one room message. The single choke point every trigger passes
 * through — which is what makes the breaker a guarantee instead of a hope.
 *
 * Returns the profiles whose turns fired (for the surface's typing dots).
 */
export function routeGroupMessage(groupId: string, message: GroupTurnRequest): string[] {
  const group = $groupChats.get()[groupId]

  if (!group) {
    return []
  }

  const fromUser = message.author === 'user'
  const names = group.members.map(member => member.profile)
  const { addressed } = extractProfileMentions(message.text, names)

  // The chain counts turns, not messages: bump/reset BEFORE routing so the
  // breaker decision below sees the message's own contribution.
  if (fromUser) {
    patchGroup(groupId, current => ({ ...current, agentChain: 0, breakerTripped: false }))
  }

  const breakerOpen = !fromUser && group.agentChain + 1 >= AGENT_CHAIN_LIMIT

  const fired: string[] = []

  for (const member of group.members) {
    if (member.profile === message.author || member.muted) {
      continue // self-drop: a profile never triggers itself (Buzz ignore_self)
    }

    // The host session hears user messages natively — the composer already
    // submitted this text as the chat's own turn. Routing it again would
    // double-fire the host.
    if (member.host && fromUser) {
      continue
    }

    const isAddressed = addressed.includes(member.profile.toLowerCase())

    // The host is the room's home surface: a member's reply MUST reach its
    // session (that's how it appears in the chat and reaches the host agent),
    // so the host always takes the turn. Everyone else: user messages fire
    // addressed/free-responder members; agent messages are strictly
    // mention-gated (Buzz require_mention).
    const wantsTurn = member.host
      ? true
      : fromUser
        ? isAddressed || member.respondTo === 'all'
        : isAddressed

    const runtime = runtimeFor(groupId, member.profile)
    runtime.pending.push(message)

    if (!wantsTurn) {
      continue // context only — drains into the next owed turn's batch
    }

    if (!fromUser && !member.host && breakerOpen) {
      // Breaker: drop the TRIGGER, keep the context. Logged loudly because
      // the false-positive is the case that needs a human eye (Buzz doc).
      console.warn(
        `[group ${groupId}] agent↔agent breaker open (chain ≥ ${AGENT_CHAIN_LIMIT}): ` +
          `suppressing ${message.author} → ${member.profile}; a user message resets it`
      )
      patchGroup(groupId, current => ({ ...current, breakerTripped: true }))
      continue
    }

    runtime.turnOwed = true
    fired.push(member.profile)

    if (!runtime.running) {
      void runMemberTurn(groupId, member.profile)
    }
    // Already running → queue-and-batch: the owed turn starts from
    // runMemberTurn's finally when the current one completes.
  }

  if (!fromUser) {
    patchGroup(groupId, current => ({ ...current, agentChain: current.agentChain + 1 }))
  }

  return fired
}

/** Drain a member's pending room messages into one sender-prefixed batch —
 *  the shared_multi_user_session wire shape, so the profile's own transcript
 *  stays an ordinary user/assistant alternation and its cache prefix holds. */
function drainPendingPrompt(groupId: string, profile: string): string {
  const runtime = runtimeFor(groupId, profile)
  const batch = runtime.pending
  runtime.pending = []
  runtime.turnOwed = false

  return batch.map(entry => `[${entry.author === 'user' ? 'user' : entry.author}]: ${entry.text}`).join('\n\n')
}

async function runMemberTurn(groupId: string, profile: string): Promise<void> {
  const runtime = runtimeFor(groupId, profile)

  if (runtime.running) {
    return
  }

  runtime.running = true
  setTyping(groupId, profile, true)

  try {
    const prompt = drainPendingPrompt(groupId, profile)

    if (!prompt) {
      return
    }

    await submitToProfile(groupId, profile, prompt)
  } finally {
    runtime.running = false
    setTyping(groupId, profile, false)

    // Queue-and-batch drain: messages that addressed us mid-turn owe us
    // exactly one more turn, over the whole accumulated batch.
    if (runtime.turnOwed) {
      void runMemberTurn(groupId, profile)
    }
  }
}

/** The room's rules + roster — leads a member's first prompt (quiet join)
 *  and the host's first fan-in. Prompt-level norms are Buzz's, verbatim where
 *  it counts: no bare acks, silence is success, narrative mentions drop the @. */
const GROUP_JOIN_PREAMBLE = (groupId: string, self: string, others: string[]) =>
  [
    `[You are "${self}", a participant in a group chat with the user and other agent profiles (${others.join(', ')}).`,
    'Messages arrive prefixed with [sender]. Address a participant with @name; it fires a turn for them.',
    'Rules of the room:',
    '- Speak only when you add information the thread does not have. Ending your turn WITHOUT replying is a normal, successful outcome — reply with an empty message to stay silent.',
    '- Never send bare acknowledgements ("Got it", "Standing by", "Will do") — they re-trigger everyone you mention. If you are tempted to announce you are done replying, that is the message not to send.',
    '- Mention someone only when you need them to act. Naming someone while talking about them ("waiting on @vera") is narrative — drop the @.]'
  ].join('\n')

/** The transport leg — the gateway is resolved per call so a member's socket
 *  can drop and reconnect between turns without the room noticing. */
async function submitToProfile(groupId: string, profile: string, text: string): Promise<void> {
  await ensureGatewayForProfile(profile)

  const group = $groupChats.get()[groupId]
  const member = group?.members.find(entry => entry.profile === profile)

  if (!member) {
    return
  }

  const gateway = gatewayForProfileKey(profile)

  if (!gateway) {
    console.warn(`[group ${groupId}] no open socket for ${profile}; dropping turn`)

    return
  }

  let sessionId = member.sessionId
  let prompt = text
  const runtime = runtimeFor(groupId, profile)

  if (member.host) {
    // Host session predates the room — no session.create, and the rules ride
    // its first fan-in prompt instead of a join preamble.
    if (!sessionId) {
      return
    }

    if (!runtime.briefed) {
      runtime.briefed = true
      const others = group.members.map(entry => entry.profile).filter(name => name !== profile)
      prompt = `${GROUP_JOIN_PREAMBLE(groupId, profile, ['user', ...others])}\n\n${text}`
    }
  } else if (!sessionId) {
    const created = await gateway.request<{ session_id?: string }>('session.create', {
      title: `group:${groupId}`
    })
    sessionId = created.session_id ?? null

    if (!sessionId) {
      return
    }

    patchGroup(groupId, current => ({
      ...current,
      members: current.members.map(entry => (entry.profile === profile ? { ...entry, sessionId } : entry))
    }))

    // Quiet join: the room's rules + roster lead the member's FIRST prompt —
    // per-session state can't live in the (byte-stable) system prompt, and a
    // late joiner gets the room's recent tail batched here by the caller
    // rather than a replay of the whole backlog.
    const others = group.members.map(entry => entry.profile).filter(name => name !== profile)
    prompt = `${GROUP_JOIN_PREAMBLE(groupId, profile, ['user', ...others])}\n\n${text}`
  }

  await gateway.request(
    'prompt.submit',
    { session_id: sessionId, text: prompt },
    PROMPT_SUBMIT_REQUEST_TIMEOUT_MS
  )
}

/**
 * Fan a completed member turn back into the room. The surface calls this from
 * its message.complete handler (it already receives every member socket's
 * events through the shared handleGatewayEvent path).
 *
 * Empty/whitespace replies are a SUCCESS, not a gap — the turn contract says
 * a profile that has nothing to add ends its turn silently (Buzz base
 * prompt: "silence is usually correct").
 */
export function onMemberTurnComplete(groupId: string, profile: string, text: string): string[] {
  const reply = (text || '').trim()

  if (!reply) {
    return []
  }

  return routeGroupMessage(groupId, { author: profile, text: reply })
}

/** Handle a gateway event from ANY profile socket. The surface routes events
 *  here when the session id belongs to a group member. */
export function handleGroupGatewayEvent(groupId: string, profile: string, event: GatewayEvent): void {
  if (event.type !== 'message.complete') {
    return
  }

  const payload = (event.payload ?? {}) as { status?: string; text?: string }

  // An errored turn is not speech — surface it as the member's session error,
  // never as a room message that could re-trigger other members.
  if (payload.status === 'error') {
    return
  }

  onMemberTurnComplete(groupId, profile, typeof payload.text === 'string' ? payload.text : '')
}
