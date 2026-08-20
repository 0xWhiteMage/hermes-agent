import assert from 'node:assert/strict'

import { test } from 'vitest'

import { normalizeState, windowsGlassTransparency } from './translucency'

// #90237: `transparent: true` changes DWM hit-testing and breaks Snap/
// FancyZones. It must be paid only when the user actually RUNS glass —
// never on bare OS capability (the old gate made every Win11-22H2+ chat
// window transparent with glass OFF, the default).

const glassOn = normalizeState({ mode: 'glass', intensity: 50 }, true)
const clear = normalizeState({ mode: 'clear', intensity: 50 }, true)
const off = normalizeState({ mode: 'off', intensity: 50 }, true)

test('transparent only when capable AND glass is the active mode', () => {
  assert.equal(windowsGlassTransparency(true, glassOn), true)
})

test('capable OS with glass off/clear stays opaque (the #90237 default)', () => {
  assert.equal(windowsGlassTransparency(true, off), false)
  assert.equal(windowsGlassTransparency(true, clear), false)
})

test('incapable platform never goes transparent, even with glass requested', () => {
  const normalizedWithoutGlass = normalizeState({ mode: 'glass', intensity: 50 }, false)

  assert.equal(windowsGlassTransparency(false, glassOn), false)
  // normalizeState itself demotes glass on incapable platforms — both gates agree.
  assert.equal(windowsGlassTransparency(true, normalizedWithoutGlass), false)
})
