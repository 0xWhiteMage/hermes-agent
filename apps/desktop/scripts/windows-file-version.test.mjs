// The Windows VERSIONINFO quad for a release tag.
//
// The bug these guard: Windows VERSIONINFO is four 16-bit fields, and
// resedit clamps every token it is handed into [0, 65535]. Handing it a
// nightly semver string produced 0.28.0.65535 — "0-nightly" parsed as NaN
// and fell to the min, the timestamp saturated at the max — so every
// nightly of a minor showed the same meaningless quad.
import assert from 'node:assert/strict'

import { test } from 'vitest'

import { windowsFileVersion } from './windows-file-version.mjs'

// resedit/dist/resource/VersionInfo.js:372-380 (clampInt) and 388-396
// (parseVersionArguments), verbatim. The contract under test is what
// survives THIS function, not what our own formatter returns.
function reseditQuad(value) {
  const clampInt = (val, min, max) => (isNaN(val) || val < min ? min : val >= max ? max : Math.floor(val))

  return String(value)
    .split('.')
    .map(token => clampInt(Number(token), 0, 65535))
    .concat(0, 0, 0)
    .slice(0, 4)
    .join('.')
}

test('a nightly quad survives resedit unchanged, where the raw semver does not', () => {
  const tag = 'v0.28.0-nightly.20260819171926'
  const quad = windowsFileVersion(tag)

  // The regression: the raw version string is destroyed by the clamp.
  assert.equal(reseditQuad(tag.slice(1)), '0.28.0.65535')
  // The fix: the quad passes through untouched, so what the build asks for
  // is what the Details tab shows.
  assert.equal(reseditQuad(quad), quad)
  assert.equal(quad, '2026.819.1719.26')
})

test('every field of every nightly timestamp fits a 16-bit VERSIONINFO field', () => {
  // The extremes of the calendar, where saturation would show up first.
  // The year ceiling is 2099: every nightly tag regex in the repo pins the
  // stamp to 20\d{6} (release.py, write_install_stamp.py, product-identity.cjs).
  for (const stamp of ['20260101000000', '20261231235959', '20260819171926', '20991231235959']) {
    const quad = windowsFileVersion(`v0.28.0-nightly.${stamp}`)
    const fields = quad.split('.').map(Number)

    assert.equal(fields.length, 4, `${stamp} -> ${quad}`)
    for (const field of fields) {
      assert.ok(field >= 0 && field <= 65535, `${stamp} -> ${quad}: ${field} out of 16-bit range`)
    }
    // Survives the clamp: no field was silently rewritten.
    assert.equal(reseditQuad(quad), quad, `${stamp} -> ${quad}`)
  }
})

test('quads order the same way their timestamps do', () => {
  // Windows compares these numerically, field by field. A newer nightly
  // must never look older than an earlier one.
  const stamps = ['20260819171926', '20260819171927', '20260820000000', '20261231235959', '20270101000000']
  const keys = stamps.map(stamp => windowsFileVersion(`v0.28.0-nightly.${stamp}`).split('.').map(Number))

  for (let i = 1; i < keys.length; i += 1) {
    assert.ok(
      keys[i] > keys[i - 1] || keys[i].some((field, index) => field > keys[i - 1][index]),
      `${stamps[i - 1]} -> ${keys[i - 1].join('.')} must precede ${stamps[i]} -> ${keys[i].join('.')}`
    )
  }
})

test('the legacy date-only nightly shape reads as midnight', () => {
  assert.equal(windowsFileVersion('v0.28.0-nightly.20260818'), '2026.818.0.0')
})

test('a stable tag opts out, leaving app-builder-lib to derive its own quad', () => {
  // A stable version is already four legal fields or fewer, so overriding
  // it would add a second source of truth for no gain.
  assert.equal(windowsFileVersion('v0.27.0'), null)
  assert.equal(windowsFileVersion('v1.2.3'), null)
})
