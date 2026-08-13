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
 * heavy. Keep in sync with electron/translucency.ts, which carries the pixel
 * census these four were curated from (the 14 Electron materials collapse to
 * 9 distinct looks on macOS 26; these four stay distinct in both appearances
 * and are evenly spaced — dark lum 26/63/84/127).
 */
export const GLASS_MATERIALS = ['under-window', 'popover', 'titlebar', 'header'] as const

export type GlassMaterial = (typeof GLASS_MATERIALS)[number]

export const DEFAULT_GLASS_MATERIAL: GlassMaterial = 'under-window'

/**
 * Where the glass field lives. 'window' thins every field surface;
 * 'sidebar' is the Finder shape — glass rail, opaque content column
 * (see the [data-hermes-glass-scope='sidebar'] block in styles.css).
 */
export const GLASS_SCOPES = ['window', 'sidebar'] as const

export type GlassScope = (typeof GLASS_SCOPES)[number]

export const DEFAULT_GLASS_SCOPE: GlassScope = 'window'

const KEY = 'hermes.desktop.translucency.v1'
const MODE_KEY = 'hermes.desktop.translucency-mode.v1'
const MATERIAL_KEY = 'hermes.desktop.translucency-material.v1'
const SCOPE_KEY = 'hermes.desktop.translucency-scope.v1'

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

const readScope = (): GlassScope => {
  const stored = storedString(SCOPE_KEY) as GlassScope

  return GLASS_SCOPES.includes(stored) ? stored : DEFAULT_GLASS_SCOPE
}

export const $translucency = atom<number>(typeof window === 'undefined' ? 0 : read())

export const $translucencyMode = atom<TranslucencyMode>(typeof window === 'undefined' ? 'clear' : readMode())

export const $translucencyMaterial = atom<GlassMaterial>(typeof window === 'undefined' ? DEFAULT_GLASS_MATERIAL : readMaterial())

export const $translucencyScope = atom<GlassScope>(typeof window === 'undefined' ? DEFAULT_GLASS_SCOPE : readScope())

export function setTranslucency(intensity: number): void {
  $translucency.set(clamp(intensity))
}

export function setTranslucencyMode(mode: TranslucencyMode): void {
  $translucencyMode.set(mode === 'glass' && GLASS_SUPPORTED ? 'glass' : 'clear')
}

export function setTranslucencyMaterial(material: GlassMaterial): void {
  $translucencyMaterial.set(GLASS_MATERIALS.includes(material) ? material : DEFAULT_GLASS_MATERIAL)
}

export function setTranslucencyScope(scope: GlassScope): void {
  $translucencyScope.set(GLASS_SCOPES.includes(scope) ? scope : DEFAULT_GLASS_SCOPE)
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

/* Sidebar scope needs the rail's visual edge published on :root so <body>
   can split its paint there (glass left of the seam, opaque chrome right of
   it — the Finder shape). The rail is an in-flow div whose WIDTH animates
   (components/ui/sidebar.tsx, collapsible='none' branch), so a
   ResizeObserver sees every collapse/expand frame; a window resize listener
   and a re-measure on every store sync cover the rest. RTL flips which side
   the seam is measured from; styles.css picks the matching gradient
   direction off html[dir]. */
let railObserver: ResizeObserver | null = null
let railTarget: Element | null = null
let railTrackingOn = false

const measureRailEdge = (): void => {
  const root = document.documentElement
  const rail = document.querySelector('[data-slot="sidebar"]')

  if (rail !== railTarget) {
    if (railObserver && railTarget) {
      railObserver.unobserve(railTarget)
    }

    railTarget = rail

    if (railObserver && rail) {
      railObserver.observe(rail)
    }
  }

  if (!rail) {
    // No rail in this window (e.g. a pane-only layout): the seam sits at the
    // window edge and the whole field stays opaque — glass simply waits for
    // a rail to exist.
    root.style.setProperty('--glass-rail-edge', '0px')

    return
  }

  const rect = rail.getBoundingClientRect()
  const rtl = getComputedStyle(root).direction === 'rtl'
  const edge = rtl ? window.innerWidth - rect.left : rect.right

  root.style.setProperty('--glass-rail-edge', `${Math.max(0, Math.round(edge))}px`)
}

const startRailTracking = (): void => {
  if (railTrackingOn) {
    measureRailEdge()

    return
  }

  railTrackingOn = true

  if (typeof ResizeObserver !== 'undefined' && !railObserver) {
    railObserver = new ResizeObserver(() => measureRailEdge())
  }

  window.addEventListener('resize', measureRailEdge)
  measureRailEdge()
}

const stopRailTracking = (): void => {
  if (!railTrackingOn) {
    return
  }

  railTrackingOn = false

  if (railObserver && railTarget) {
    railObserver.unobserve(railTarget)
  }

  railTarget = null
  window.removeEventListener('resize', measureRailEdge)
  document.documentElement.style.removeProperty('--glass-rail-edge')
}

const applyGlassSurfaces = (intensity: number, mode: TranslucencyMode, scope: GlassScope): void => {
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
    root.setAttribute('data-hermes-glass-scope', scope)
    root.style.setProperty('--translucency-glass-keep', `${glassSurfaceKeep(intensity)}%`)
  } else {
    root.removeAttribute('data-hermes-glass')
    root.removeAttribute('data-hermes-glass-scope')
    root.style.removeProperty('--translucency-glass-keep')
  }

  if (on && scope === 'sidebar') {
    startRailTracking()
  } else {
    stopRailTracking()
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
    const scope = $translucencyScope.get()

    persistString(KEY, String(intensity))
    persistString(MODE_KEY, mode)
    persistString(MATERIAL_KEY, material)
    persistString(SCOPE_KEY, scope)
    applyGlassSurfaces(intensity, mode, scope)
    window.hermesDesktop?.setTranslucency?.({ intensity, mode, material, scope })
  }

  $translucency.subscribe(sync)
  $translucencyMode.subscribe(sync)
  $translucencyMaterial.subscribe(sync)
  $translucencyScope.subscribe(sync)
}
