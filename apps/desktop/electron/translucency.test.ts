import { describe, expect, it } from 'vitest'

import { clampIntensity, DEFAULT_GLASS_MATERIAL, glassActive, normalizeMaterial, normalizeMode, normalizePayload, normalizeScope, vibrancyFor, windowBackingOptions, windowOpacityFor } from './translucency'

describe('clampIntensity', () => {
  it('clamps to 0-100 and rounds', () => {
    expect(clampIntensity(-5)).toBe(0)
    expect(clampIntensity(0)).toBe(0)
    expect(clampIntensity(49.6)).toBe(50)
    expect(clampIntensity(100)).toBe(100)
    expect(clampIntensity(250)).toBe(100)
  })

  it('treats junk as 0 (opaque)', () => {
    expect(clampIntensity(undefined)).toBe(0)
    expect(clampIntensity(NaN)).toBe(0)
    expect(clampIntensity('glass')).toBe(0)
    expect(clampIntensity(null)).toBe(0)
  })
})

describe('normalizeMode', () => {
  it('accepts glass on macOS only', () => {
    expect(normalizeMode('glass', true)).toBe('glass')
    expect(normalizeMode('glass', false)).toBe('clear')
  })

  it('falls back to clear for legacy and junk values', () => {
    expect(normalizeMode(undefined, true)).toBe('clear')
    expect(normalizeMode('clear', true)).toBe('clear')
    expect(normalizeMode('acrylic', true)).toBe('clear')
    expect(normalizeMode(42, true)).toBe('clear')
  })
})

describe('windowOpacityFor', () => {
  it('keeps the legacy clear-mode ramp with its 0.3 floor', () => {
    expect(windowOpacityFor(0, 'clear')).toBe(1)
    expect(windowOpacityFor(50, 'clear')).toBeCloseTo(0.65)
    expect(windowOpacityFor(100, 'clear')).toBeCloseTo(0.3)
  })

  it('never fades the native window in glass mode', () => {
    expect(windowOpacityFor(0, 'glass')).toBe(1)
    expect(windowOpacityFor(60, 'glass')).toBe(1)
    expect(windowOpacityFor(100, 'glass')).toBe(1)
  })
})

describe('normalizePayload', () => {
  it('parses a modern payload', () => {
    expect(normalizePayload({ intensity: 40, material: 'popover', mode: 'glass', scope: 'sidebar' }, true)).toEqual({
      intensity: 40,
      material: 'popover',
      mode: 'glass',
      scope: 'sidebar'
    })
  })

  it('parses a legacy intensity-only payload as clear with defaults', () => {
    expect(normalizePayload({ intensity: 70 }, true)).toEqual({
      intensity: 70,
      material: DEFAULT_GLASS_MATERIAL,
      mode: 'clear',
      scope: 'window'
    })
  })

  it('survives junk payloads', () => {
    expect(normalizePayload(null, true)).toEqual({
      intensity: 0,
      material: DEFAULT_GLASS_MATERIAL,
      mode: 'clear',
      scope: 'window'
    })
    expect(normalizePayload('nope', true)).toEqual({
      intensity: 0,
      material: DEFAULT_GLASS_MATERIAL,
      mode: 'clear',
      scope: 'window'
    })
    expect(normalizePayload({ intensity: 'x', material: 'acrylic', mode: 'glass', scope: 9 }, false)).toEqual({
      intensity: 0,
      material: DEFAULT_GLASS_MATERIAL,
      mode: 'clear',
      scope: 'window'
    })
  })
})

describe('glassActive', () => {
  it('is on only for glass with nonzero intensity', () => {
    expect(glassActive({ intensity: 60, mode: 'glass' })).toBe(true)
    expect(glassActive({ intensity: 0, mode: 'glass' })).toBe(false)
    expect(glassActive({ intensity: 60, mode: 'clear' })).toBe(false)
  })
})

describe('normalizeMaterial', () => {
  it('accepts curated materials and falls back on junk', () => {
    expect(normalizeMaterial('popover')).toBe('popover')
    expect(normalizeMaterial('header')).toBe('header')
    expect(normalizeMaterial('acrylic')).toBe(DEFAULT_GLASS_MATERIAL)
    expect(normalizeMaterial(undefined)).toBe(DEFAULT_GLASS_MATERIAL)
  })

  it('rejects materials that render as duplicates of the curated set', () => {
    // sidebar≡hud collapse into under-window when unfocused (macOS 26 census)
    // — they shipped once as picker options nobody could tell apart.
    expect(normalizeMaterial('sidebar')).toBe(DEFAULT_GLASS_MATERIAL)
    expect(normalizeMaterial('hud')).toBe(DEFAULT_GLASS_MATERIAL)
  })
})

describe('normalizeScope', () => {
  it('accepts window and sidebar, falls back on junk', () => {
    expect(normalizeScope('window')).toBe('window')
    expect(normalizeScope('sidebar')).toBe('sidebar')
    expect(normalizeScope('composer')).toBe('window')
    expect(normalizeScope(undefined)).toBe('window')
  })
})

describe('vibrancyFor', () => {
  it('serves the chosen material while glass is active', () => {
    expect(vibrancyFor({ intensity: 60, material: 'header', mode: 'glass', scope: 'window' })).toBe('header')
  })

  it('serves the legacy sidebar material otherwise', () => {
    expect(vibrancyFor({ intensity: 0, material: 'header', mode: 'glass', scope: 'window' })).toBe('sidebar')
    expect(vibrancyFor({ intensity: 60, material: 'header', mode: 'clear', scope: 'window' })).toBe('sidebar')
  })
})

describe('windowBackingOptions', () => {
  it('omits backgroundColor entirely while glass is active', () => {
    // Spreading a themed color (even alpha-0) would be silently treated as
    // opaque on a non-transparent window and block the vibrancy material.
    expect(windowBackingOptions({ intensity: 60, mode: 'glass' }, '#111111')).toEqual({})
  })

  it('keeps the themed anti-flash backing otherwise', () => {
    expect(windowBackingOptions({ intensity: 0, mode: 'glass' }, '#111111')).toEqual({ backgroundColor: '#111111' })
    expect(windowBackingOptions({ intensity: 60, mode: 'clear' }, '#111111')).toEqual({ backgroundColor: '#111111' })
    expect(windowBackingOptions({ intensity: 0, mode: 'clear' }, '#f7f7f7')).toEqual({ backgroundColor: '#f7f7f7' })
  })
})
