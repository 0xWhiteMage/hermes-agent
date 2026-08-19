import assert from 'node:assert/strict'

import { test } from 'vitest'

import { applyAppUpdate, describeFeedCheck, feedSelection, shouldUseAppUpdater } from './app-updater'

// ── feedSelection ───────────────────────────────────────────────────

test('every channel names its feed file explicitly', () => {
  // The regression: the stable arm passed null ("no override"), and
  // GitHubProvider then fell back to the channel baked into app-update.yml.
  // On a nightly artifact that is 'nightly', so a stable-channel check
  // asked for nightly.yml under the newest STABLE release — 404, with no
  // latest.yml retry because that only runs when allowPrerelease is true.
  for (const light of [false, true]) {
    for (const channel of ['stable', 'nightly'] as const) {
      const feed = feedSelection(channel, light)

      assert.ok(feed.channel, `${channel}/light=${light} must name a feed`)
      assert.equal(typeof feed.channel, 'string')
    }
  }
})

test('feed names are per-variant so the two variants never share a feed', () => {
  assert.equal(feedSelection('stable', false).channel, 'latest')
  assert.equal(feedSelection('nightly', false).channel, 'nightly')
  assert.equal(feedSelection('stable', true).channel, 'light')
  assert.equal(feedSelection('nightly', true).channel, 'light-nightly')
})

test('only the nightly channel accepts prereleases', () => {
  // allowPrerelease also picks which release the feed file is read FROM:
  // true walks the atom feed for the newest nightly tag, false takes
  // /releases/latest. A nightly feed must be paired with the atom walk, or
  // it looks for its feed file under the newest stable release.
  assert.equal(feedSelection('nightly', false).allowPrerelease, true)
  assert.equal(feedSelection('nightly', true).allowPrerelease, true)
  assert.equal(feedSelection('stable', false).allowPrerelease, false)
  assert.equal(feedSelection('stable', true).allowPrerelease, false)
})

// ── shouldUseAppUpdater ─────────────────────────────────────────────

test('app updater runs for packaged embedded builds', () => {
  assert.equal(shouldUseAppUpdater({ stampPayload: 'bundled', isPackaged: true }), true)
})

test('app updater runs for packaged light builds', () => {
  assert.equal(shouldUseAppUpdater({ stampPayload: 'light', isPackaged: true }), true)
})

test('a bootstrap build never uses the app updater', () => {
  assert.equal(shouldUseAppUpdater({ stampPayload: 'bootstrap', isPackaged: true }), false)
})

test('dev runs never use the app updater', () => {
  assert.equal(shouldUseAppUpdater({ stampPayload: 'bundled', isPackaged: false }), false)
  assert.equal(shouldUseAppUpdater({ stampPayload: 'light', isPackaged: false }), false)
})

// ── describeFeedCheck ───────────────────────────────────────────────

test('feed check reports an available update when versions differ', () => {
  const out = describeFeedCheck('0.17.0', { version: '0.18.0' })

  assert.equal(out.supported, true)
  assert.equal(out.mechanism, 'app-updater')
  assert.equal(out.channel, 'stable')
  assert.equal(out.currentVersion, '0.17.0')
  assert.equal(out.latestVersion, '0.18.0')
  assert.equal(out.latestTag, 'v0.18.0')
  assert.equal(out.updateAvailable, true)
  assert.ok(out.fetchedAt > 0)
})

test('feed check reports up to date when versions match', () => {
  const out = describeFeedCheck('0.17.0', { version: '0.17.0' })

  assert.equal(out.updateAvailable, false)
  assert.equal(out.latestVersion, '0.17.0')
})

test('feed check tolerates a missing update info payload', () => {
  const out = describeFeedCheck('0.17.0', null)

  assert.equal(out.updateAvailable, false)
  assert.equal(out.latestVersion, null)
})

// ── applyAppUpdate ──────────────────────────────────────────────────

function fakeUpdater(calls: string[], failDownload = false) {
  return {
    on: () => void 0,
    removeListener: () => void 0,
    downloadUpdate: async () => {
      calls.push('download')

      if (failDownload) {
        throw new Error('download failed')
      }
    },
    quitAndInstall: () => void calls.push('install')
  } as any
}

test('apply runs beforeInstall between the download and the install', async () => {
  const calls: string[] = []

  await applyAppUpdate(undefined, () => void calls.push('teardown'), fakeUpdater(calls))

  assert.deepEqual(calls, ['download', 'teardown', 'install'])
})

test('a failed download installs nothing and skips beforeInstall', async () => {
  const calls: string[] = []

  await assert.rejects(applyAppUpdate(undefined, () => void calls.push('teardown'), fakeUpdater(calls, true)))

  assert.deepEqual(calls, ['download'])
})
