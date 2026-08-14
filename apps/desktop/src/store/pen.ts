/**
 * PEN CANVAS — pen.dev design documents hosted by hermes.
 *
 * The canvas is NOT an in-app pane: Electron main hosts the user's installed
 * pen.dev editor in a chromeless window attached to the app's right edge
 * (electron/pen-canvas.ts + the pen block in electron/main.ts). This store is
 * just the renderer's doors: open/close/status and the agent bridge's tool
 * runner. No tab list, no pane mirroring — the window IS the surface.
 */

import { atom } from 'nanostores'

import type { PenStatus, PenToolResult } from '@/global'
import { translateNow } from '@/i18n'
import { notifyError } from '@/store/notifications'

/** pen.dev host availability — drives the ⌘K rows' enabled state. Refreshed on
 *  demand, not polled. */
export const $penStatus = atom<PenStatus | null>(null)

export async function refreshPenStatus(): Promise<PenStatus | null> {
  const pen = window.hermesDesktop?.pen

  if (!pen) {
    return null
  }

  try {
    const status = await pen.status()

    $penStatus.set(status)

    return status
  } catch {
    return null
  }
}

/** Open a canvas window: a .pen file when `path` is given, else a fresh
 *  temporary document (blank canvas by default; pass a template like `shadcn`
 *  for a design-kit start). Re-opening an open document re-fronts its window. */
export async function openPenCanvas(options: { path?: string; template?: string } = {}) {
  const pen = window.hermesDesktop?.pen

  if (!pen) {
    return null
  }

  try {
    const { doc } = await pen.open(options)

    return doc
  } catch (error) {
    notifyError(error, translateNow('pen.openFailed'))

    return null
  }
}

/** Run a pen design tool (execute / get_app_state / get_guidelines / …)
 *  against the live canvas. The agent bridge routes through here so the tool
 *  works wherever the CLIENT is, remote backends included. */
export async function runPenTool(name: string, payload?: Record<string, unknown>): Promise<PenToolResult> {
  const pen = window.hermesDesktop?.pen

  if (!pen) {
    return { success: false, error: 'pen canvas is only available in the Hermes desktop app' }
  }

  try {
    return await pen.tool(name, payload)
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Pin the app's layout to the content strip a native drawer view leaves
 *  free. Main drives (hermes:drawer:changed); the margin on #root is the
 *  whole mechanism — the app never reflows for the drawer beyond it. Call
 *  once from the contrib root; returns a disposer. */
export function watchPenDrawer(): () => void {
  const pen = window.hermesDesktop?.pen

  if (!pen?.onDrawerChanged) {
    return () => {}
  }

  return pen.onDrawerChanged(({ edge, size }) => {
    const root = document.getElementById('root')

    if (!root) {
      return
    }

    root.style.marginLeft = edge === 'left' && size > 0 ? `${size}px` : ''
    root.style.marginRight = edge === 'right' && size > 0 ? `${size}px` : ''
    root.style.marginBottom = edge === 'bottom' && size > 0 ? `${size}px` : ''

    // Margins don't reach vw-derived widths (the titlebar header cap), so the
    // inset is also published as a var for calc() consumers.
    for (const side of ['left', 'right', 'bottom'] as const) {
      document.documentElement.style.setProperty(
        `--hermes-drawer-${side}`,
        edge === side && size > 0 ? `${size}px` : '0px'
      )
    }
  })
}
