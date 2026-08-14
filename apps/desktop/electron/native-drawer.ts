// Native drawer — geometry for edge-docked WebContentsView strips.
//
// A drawer extends the app window outward on one edge (left, right, bottom):
// the WINDOW grows by the drawer's depth and a native view owns the new
// region, while the renderer pins its own content to the original size via a
// margin var (--hermes-drawer-<edge>). One OS window — one shadow, one
// rounded rect — so the drawer reads as part of the chrome, not a second
// window. The guest view owns every pixel of its strip; the app's layout,
// statusbar, and sidebars never reflow.
//
// Pure math, no Electron imports — unit-testable. The wiring lives in
// main.ts (the pen canvas is the first consumer).

export type DrawerEdge = 'bottom' | 'left' | 'right'

export interface Rect {
  height: number
  width: number
  x: number
  y: number
}

export interface DrawerExpansion {
  /** Depth the window actually grew by (≤ requested when screen-bound). */
  grewBy: number
  /** Window bounds after growing toward the edge (shifted when the screen
   *  lacked room on that side). */
  window: Rect
}

/** Grow `bounds` by `size` toward `edge`, keeping the result inside
 *  `workArea`. Room on the far side is used first; the remainder shifts the
 *  window the other way; whatever still doesn't fit is given up (the drawer
 *  renders shallower rather than pushing the window offscreen). */
export function expandForDrawer(edge: DrawerEdge, bounds: Rect, size: number, workArea: Rect): DrawerExpansion {
  if (edge === 'bottom') {
    const room = Math.max(0, workArea.y + workArea.height - (bounds.y + bounds.height))
    const shift = Math.min(Math.max(0, size - room), Math.max(0, bounds.y - workArea.y))
    const grewBy = Math.min(size, room + shift)

    return { grewBy, window: { ...bounds, height: bounds.height + grewBy, y: bounds.y - shift } }
  }

  const room =
    edge === 'right'
      ? Math.max(0, workArea.x + workArea.width - (bounds.x + bounds.width))
      : Math.max(0, bounds.x - workArea.x)

  const shiftRoom =
    edge === 'right'
      ? Math.max(0, bounds.x - workArea.x)
      : Math.max(0, workArea.x + workArea.width - (bounds.x + bounds.width))

  const shift = Math.min(Math.max(0, size - room), shiftRoom)
  const grewBy = Math.min(size, room + shift)
  const x = edge === 'right' ? bounds.x - shift : bounds.x - grewBy + shift

  return { grewBy, window: { ...bounds, width: bounds.width + grewBy, x } }
}

/** The strip of the window's CONTENT area a drawer of `size` occupies. */
export function drawerStripBounds(edge: DrawerEdge, contentWidth: number, contentHeight: number, size: number): Rect {
  const depth = Math.max(0, Math.min(size, edge === 'bottom' ? contentHeight : contentWidth))

  if (edge === 'left') {
    return { height: contentHeight, width: depth, x: 0, y: 0 }
  }

  if (edge === 'right') {
    return { height: contentHeight, width: depth, x: contentWidth - depth, y: 0 }
  }

  return { height: depth, width: contentWidth, x: 0, y: contentHeight - depth }
}

/** Window bounds after the drawer closes: shrink by what it grew, back
 *  toward the edge it grew from. Clamped so a window the user shrank
 *  meanwhile never goes below `minSize`. */
export function shrinkAfterDrawer(edge: DrawerEdge, bounds: Rect, grewBy: number, minSize: number): Rect {
  if (edge === 'bottom') {
    const height = Math.max(minSize, bounds.height - grewBy)

    return { ...bounds, height }
  }

  const width = Math.max(minSize, bounds.width - grewBy)

  if (edge === 'left') {
    return { ...bounds, width, x: bounds.x + (bounds.width - width) }
  }

  return { ...bounds, width }
}
