// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'

import {
  $translucency,
  $translucencyMaterial,
  $translucencyMode,
  $translucencyScope,
  DEFAULT_GLASS_MATERIAL,
  GLASS_SUPPORTED,
  glassSurfaceKeep,
  setTranslucency,
  setTranslucencyMaterial,
  setTranslucencyMode,
  setTranslucencyScope
} from './translucency'

// jsdom reports a mac platform in CI and locally alike only when the host is a
// mac; the glass-specific assertions gate on the same flag the store uses so
// the suite is honest on every platform.
describe('translucency store', () => {
  beforeEach(() => {
    setTranslucency(0)
    setTranslucencyMode('clear')
  })

  it('clamps intensity', () => {
    setTranslucency(140)
    expect($translucency.get()).toBe(100)
    setTranslucency(-3)
    expect($translucency.get()).toBe(0)
  })

  it('mirrors intensity, mode and material to the desktop bridge', () => {
    const calls: Array<{ intensity: number; mode?: string }> = []
    window.hermesDesktop = { setTranslucency: (payload: { intensity: number; mode?: 'clear' | 'glass' }) => calls.push(payload) } as never

    setTranslucency(40)
    expect(calls.at(-1)).toEqual({ intensity: 40, material: DEFAULT_GLASS_MATERIAL, mode: 'clear', scope: 'window' })
  })

  it('rejects glass off macOS and applies it on macOS', () => {
    setTranslucency(50)
    setTranslucencyMode('glass')

    if (GLASS_SUPPORTED) {
      expect($translucencyMode.get()).toBe('glass')
      expect(document.documentElement.hasAttribute('data-hermes-glass')).toBe(true)
      expect(document.documentElement.style.getPropertyValue('--translucency-glass-keep')).toBe('50%')
    } else {
      expect($translucencyMode.get()).toBe('clear')
      expect(document.documentElement.hasAttribute('data-hermes-glass')).toBe(false)
    }
  })

  it('persists and mirrors the frost material, rejecting junk', () => {
    const calls: Array<{ intensity: number; mode?: string; material?: string }> = []
    window.hermesDesktop = {
      setTranslucency: (payload: { intensity: number; mode?: 'clear' | 'glass' }) => calls.push(payload)
    } as never

    setTranslucencyMaterial('popover')
    expect($translucencyMaterial.get()).toBe('popover')
    expect(calls.at(-1)?.material).toBe('popover')

    setTranslucencyMaterial('acrylic' as never)
    expect($translucencyMaterial.get()).toBe(DEFAULT_GLASS_MATERIAL)
  })

  it('removes the glass attribute at zero intensity or back on clear', () => {
    setTranslucency(50)
    setTranslucencyMode('glass')
    setTranslucency(0)
    expect(document.documentElement.hasAttribute('data-hermes-glass')).toBe(false)

    setTranslucency(50)
    setTranslucencyMode('clear')
    expect(document.documentElement.hasAttribute('data-hermes-glass')).toBe(false)
  })

  it('marks clear mode on <html> so the overlay scrim can compensate', () => {
    setTranslucency(50)
    setTranslucencyMode('clear')
    expect(document.documentElement.hasAttribute('data-hermes-clear')).toBe(true)

    setTranslucency(0)
    expect(document.documentElement.hasAttribute('data-hermes-clear')).toBe(false)

    setTranslucency(50)

    if (GLASS_SUPPORTED) {
      setTranslucencyMode('glass')
      expect(document.documentElement.hasAttribute('data-hermes-clear')).toBe(false)
    }
  })

  it('publishes the glass scope on <html> and validates junk', () => {
    const calls: Array<{ intensity: number; scope?: string }> = []
    window.hermesDesktop = {
      setTranslucency: (payload: { intensity: number }) => calls.push(payload)
    } as never

    setTranslucency(50)
    setTranslucencyScope('sidebar')
    expect($translucencyScope.get()).toBe('sidebar')
    expect(calls.at(-1)?.scope).toBe('sidebar')

    if (GLASS_SUPPORTED) {
      setTranslucencyMode('glass')
      expect(document.documentElement.getAttribute('data-hermes-glass-scope')).toBe('sidebar')
      setTranslucencyScope('window')
      expect(document.documentElement.getAttribute('data-hermes-glass-scope')).toBe('window')
    }

    setTranslucencyScope('composer' as never)
    expect($translucencyScope.get()).toBe('window')
  })
})

describe('glassSurfaceKeep', () => {
  it('runs linear from full tint to bare glass', () => {
    expect(glassSurfaceKeep(0)).toBe(100)
    expect(glassSurfaceKeep(50)).toBe(50)
    expect(glassSurfaceKeep(100)).toBe(0)
  })
})
