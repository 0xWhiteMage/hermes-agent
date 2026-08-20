import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../plugin.js', import.meta.url), 'utf8')

// Bug: a bot whose pinned canonical-chat id is dead/stale (points at a session
// id that was never persisted, or was rewritten past recovery) reintroduced
// itself on a brand-new session every open — while its real forever-chat sat
// intact but HIDDEN on disk. The roster's last_session/preferred_session are
// both computed from a hidden-EXCLUDING query, so the recovery branches had no
// adoptable history and fell straight through to createCanonicalChat.
//
// Fix: before minting a new chat, browse the profile's hidden sessions
// (session.list include_hidden:true — the same view the Sessions submenu uses)
// and adopt the existing "Bot Chat".

test('a dead/stale pin adopts the existing hidden Bot Chat instead of reintroducing', () => {
  // The recovery helper exists and browses hidden sessions.
  assert.match(source, /async function findExistingCanonicalBotChat\(name\)/)
  assert.match(source, /async function adoptOrCreateCanonicalChat\(name\)/)

  const finder = source.slice(
    source.indexOf('async function findExistingCanonicalBotChat'),
    source.indexOf('async function adoptOrCreateCanonicalChat')
  )
  // It queries the hidden-inclusive listing, not the roster's hidden-excluding one.
  assert.match(finder, /session\.list/)
  assert.match(finder, /include_hidden:\s*true/)
  // It only adopts an actual Bot Chat (never an unrelated user conversation).
  assert.match(finder, /isCanonicalBotChatHistory\(row\)/)
})

test('every mint-new branch routes through adoptOrCreateCanonicalChat', () => {
  const fn = source.slice(
    source.indexOf('async function openBotCanonicalChat'),
    source.indexOf('async function prepareBotSource')
  )
  // The old direct createCanonicalChat fall-throughs are gone from the
  // recovery branches — they adopt first now.
  const adoptCalls = (fn.match(/adoptOrCreateCanonicalChat\(name\)/g) || []).length
  assert.ok(adoptCalls >= 3, `expected >=3 adopt-or-create fallbacks, found ${adoptCalls}`)
})

test('adopt path opens the stored chat and re-pins it', () => {
  const adopt = source.slice(
    source.indexOf('async function adoptOrCreateCanonicalChat'),
    source.indexOf('async function openBotCanonicalChat')
  )
  assert.match(adopt, /openStoredBotChat\(name, existing/)
  assert.match(adopt, /saveBotMeta\(name, \{ chat: existing \}\)/)
  // Falls back to a fresh chat only when there's genuinely nothing to adopt.
  assert.match(adopt, /return createCanonicalChat\(name\)/)
})
