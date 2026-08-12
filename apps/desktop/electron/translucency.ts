/**
 * Window translucency mapping shared by main-process call sites.
 *
 * Two modes ride one persisted lever (see src/store/translucency.ts):
 * - 'clear': the 0-100 intensity maps to native window opacity — the whole
 *   window (text included) fades so the desktop shows through unblurred.
 * - 'glass': the window stays fully opaque at the native level; the renderer
 *   thins its background surfaces instead so the macOS vibrancy material
 *   (already attached to every chat window) shows through as a matte blur
 *   while text keeps full contrast. macOS only — other platforms fall back
 *   to 'clear'.
 */

export type TranslucencyMode = 'clear' | 'glass'

/**
 * macOS vibrancy materials offered as glass "frost" levels, ordered sheer →
 * heavy. macOS exposes no blur-radius knob (VibrancyOptions is only an
 * animation duration), so the material IS the blur control: each maps to a
 * different NSVisualEffectView material with its own blur strength and
 * luminance lift (measured on macOS 26: popover keeps ~2.5x more wallpaper
 * detail than under-window and reads ~30% darker; fullscreen-ui/menu/content
 * render pixel-identical to each other, so only distinct looks are offered).
 * Keep in sync with GLASS_MATERIALS in src/store/translucency.ts.
 */
export const GLASS_MATERIALS = ['popover', 'hud', 'sidebar', 'under-window'] as const

export type GlassMaterial = (typeof GLASS_MATERIALS)[number]

export const DEFAULT_GLASS_MATERIAL: GlassMaterial = 'under-window'

export interface TranslucencyState {
  intensity: number
  mode: TranslucencyMode
  material: GlassMaterial
}

export function clampIntensity(value: unknown): number {
  const n = Math.round(Number(value))

  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0
}

/** Unknown or unsupported values fall back to 'clear' (the legacy behavior). */
export function normalizeMode(value: unknown, isMac: boolean): TranslucencyMode {
  return value === 'glass' && isMac ? 'glass' : 'clear'
}

/**
 * Native window opacity for a mode + intensity. Glass never fades the native
 * window — the see-through effect is painted by the renderer over vibrancy.
 * Clear keeps the historical ramp: floor at 0.3 so the most see-through
 * setting is still usable rather than nearly invisible. 0 → fully opaque.
 */
export function windowOpacityFor(intensity: number, mode: TranslucencyMode): number {
  if (mode === 'glass') {
    return 1
  }

  return 1 - (clampIntensity(intensity) / 100) * 0.7
}

/** Unknown or unsupported values fall back to the default material. */
export function normalizeMaterial(value: unknown): GlassMaterial {
  return GLASS_MATERIALS.includes(value as GlassMaterial) ? (value as GlassMaterial) : DEFAULT_GLASS_MATERIAL
}

/** Parse a persisted translucency.json / IPC payload into a safe shape. */
export function normalizePayload(payload: unknown, isMac: boolean): TranslucencyState {
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}

  return {
    intensity: clampIntensity(record.intensity),
    mode: normalizeMode(record.mode, isMac),
    material: normalizeMaterial(record.material)
  }
}

/**
 * Whether glass is visually active. Decides the chat windows' webContents
 * backing: Chromium composites the page against the window's backgroundColor
 * BEFORE macOS composites the window, so an opaque backing (the normal
 * anti-white-flash paint) blocks the vibrancy material even under a fully
 * transparent page. Glass needs the backing gone; any other state keeps the
 * opaque themed backing.
 */
export function glassActive(state: { intensity: number; mode: TranslucencyMode }): boolean {
  return state.mode === 'glass' && state.intensity > 0
}

/**
 * The vibrancy material a chat window should carry. 'sidebar' is the
 * long-standing default the titlebar band was designed against; glass mode
 * swaps the whole window onto the user's chosen material (setVibrancy is
 * cheap and animatable at runtime, unlike the backing).
 */
export function vibrancyFor(state: TranslucencyState): GlassMaterial | 'sidebar' {
  return glassActive(state) ? state.material : 'sidebar'
}

/**
 * BrowserWindow constructor options for a chat window's backing, given the
 * translucency state at creation time.
 *
 * Glass active → OMIT `backgroundColor` entirely: on a `vibrancy` window the
 * NSVisualEffectView then shows through a transparent page from the first
 * frame. Passing an alpha color instead does NOT work — the docs only support
 * constructor alpha with `transparent: true`, and `#00000000` on a normal
 * window is quietly treated as opaque.
 *
 * Glass inactive → the opaque themed backing (anti-flash paint before the
 * renderer's first paint, and what clear mode fades against).
 *
 * A runtime `setBackgroundColor` swap (see applyWindowTranslucency in main)
 * only settles reliably on a window that has been compositing for a while —
 * measured on macOS 26/Electron 40: swaps issued during roughly the first
 * seconds of a fresh process were lost, including from 'ready-to-show' and
 * 'did-finish-load' — so creation must not rely on a post-creation fixup.
 */
export function windowBackingOptions(
  state: { intensity: number; mode: TranslucencyMode },
  themedColor: string
): { backgroundColor?: string } {
  return glassActive(state) ? {} : { backgroundColor: themedColor }
}
