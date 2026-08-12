/**
 * Window translucency (see-through window).
 *
 * One lever, 0–100. 0 = off (fully opaque, the default). Higher = more of the
 * desktop shows through. Two modes decide HOW it shows through:
 *
 * - 'clear' — the main process maps the lever to native window opacity
 *   (`setOpacity`), the same effect as the Windows shift-scroll trick. The
 *   whole window fades, text included. macOS + Windows; Linux has no runtime
 *   window opacity, so it's a no-op there.
 * - 'glass' — macOS only. The window stays opaque at the native level; this
 *   store thins the renderer's page surfaces instead (see the
 *   `[data-hermes-glass]` block in styles.css), so the vibrancy material every
 *   chat window already carries shows through as a matte blur while text keeps
 *   full contrast.
 *
 * The renderer owns both values and mirrors them to the main process over IPC.
 */

import { atom } from 'nanostores'

import { persistString, storedString } from '@/lib/storage'

export type TranslucencyMode = 'clear' | 'glass'

/**
 * Vibrancy materials selectable as glass "frost" levels, ordered sheer →
 * heavy. Keep in sync with electron/translucency.ts (measured on macOS 26:
 * popover keeps the most wallpaper detail and reads darkest; under-window
 * blurs hardest and reads brightest).
 */
export const GLASS_MATERIALS = ['popover', 'hud', 'sidebar', 'under-window'] as const

export type GlassMaterial = (typeof GLASS_MATERIALS)[number]

export const DEFAULT_GLASS_MATERIAL: GlassMaterial = 'under-window'

const KEY = 'hermes.desktop.translucency.v1'
const MODE_KEY = 'hermes.desktop.translucency-mode.v1'
const MATERIAL_KEY = 'hermes.desktop.translucency-material.v1'

/** Glass rides on macOS vibrancy; other platforms only have Clear. */
export const GLASS_SUPPORTED = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent || '')

const clamp = (n: number): number => Math.min(100, Math.max(0, Math.round(n)))

const read = (): number => {
  const n = Number(storedString(KEY))

  return Number.isFinite(n) ? clamp(n) : 0
}

const readMode = (): TranslucencyMode => (GLASS_SUPPORTED && storedString(MODE_KEY) === 'glass' ? 'glass' : 'clear')

const readMaterial = (): GlassMaterial => {
  const stored = storedString(MATERIAL_KEY) as GlassMaterial

  return GLASS_MATERIALS.includes(stored) ? stored : DEFAULT_GLASS_MATERIAL
}

export const $translucency = atom<number>(typeof window === 'undefined' ? 0 : read())

export const $translucencyMode = atom<TranslucencyMode>(typeof window === 'undefined' ? 'clear' : readMode())

export const $translucencyMaterial = atom<GlassMaterial>(typeof window === 'undefined' ? DEFAULT_GLASS_MATERIAL : readMaterial())

export function setTranslucency(intensity: number): void {
  $translucency.set(clamp(intensity))
}

export function setTranslucencyMode(mode: TranslucencyMode): void {
  $translucencyMode.set(mode === 'glass' && GLASS_SUPPORTED ? 'glass' : 'clear')
}

export function setTranslucencyMaterial(material: GlassMaterial): void {
  $translucencyMaterial.set(GLASS_MATERIALS.includes(material) ? material : DEFAULT_GLASS_MATERIAL)
}

// Glass thins surfaces only in real chat windows (primary + secondary session
// windows). The HUD, pet overlay, quick entry and wake indicator are
// transparent special-purpose windows that manage their own backgrounds — a
// page-surface rewrite there would fight them.
const isChatWindow = (): boolean => {
  try {
    const win = new URLSearchParams(window.location.search).get('win')

    return win === null || win === 'secondary'
  } catch {
    return false
  }
}

/**
 * Percent of the surface tint KEPT at a given intensity. Linear to zero: at
 * 100 the tint is fully gone — bare vibrancy glass — so the slider spans the
 * whole range from opaque theme to untinted blur. Text and cards keep their
 * own opaque tokens for contrast; only the field surfaces thin.
 */
export const glassSurfaceKeep = (intensity: number): number => 100 - clamp(intensity)

const applyGlassSurfaces = (intensity: number, mode: TranslucencyMode): void => {
  if (typeof document === 'undefined') {
    return
  }

  const root = document.documentElement
  const on = mode === 'glass' && intensity > 0 && GLASS_SUPPORTED && isChatWindow()
  // Clear mode fades the whole window uniformly, so overlay text and the
  // covered transcript blend; styles.css strengthens the overlay scrim while
  // this attribute is present. Native opacity applies in every window kind,
  // so no chat-window gate.
  const clearOn = mode === 'clear' && intensity > 0

  if (on) {
    root.setAttribute('data-hermes-glass', '')
    root.style.setProperty('--translucency-glass-keep', `${glassSurfaceKeep(intensity)}%`)
  } else {
    root.removeAttribute('data-hermes-glass')
    root.style.removeProperty('--translucency-glass-keep')
  }

  if (clearOn) {
    root.setAttribute('data-hermes-clear', '')
  } else {
    root.removeAttribute('data-hermes-clear')
  }
}

if (typeof window !== 'undefined') {
  const sync = () => {
    const intensity = $translucency.get()
    const mode = $translucencyMode.get()
    const material = $translucencyMaterial.get()

    persistString(KEY, String(intensity))
    persistString(MODE_KEY, mode)
    persistString(MATERIAL_KEY, material)
    applyGlassSurfaces(intensity, mode)
    window.hermesDesktop?.setTranslucency?.({ intensity, mode, material })
  }

  $translucency.subscribe(sync)
  $translucencyMode.subscribe(sync)
  $translucencyMaterial.subscribe(sync)
}
