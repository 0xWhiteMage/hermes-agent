/**
 * PEN CANVAS TILES — the pen.dev editor as a layout-tree pane.
 *
 * The canvas mounts a <webview> on the hermes-pen:// protocol inside a normal
 * tree pane (the URL-preview pattern), so the tree owns sizing, sashes, tabs
 * and theme, and DOM overlays (palette, pickers, menus) stack above it
 * natively. Main owns the documents; this file owns their presentation.
 */

import { atom } from 'nanostores'

import { revealTreePane } from '@/components/pane-shell/tree/store'

import penMark from '@/assets/pen-mark.png'

import { paneMirror } from './pane-mirror'
import { PenTilePane } from './pen-tile-pane'

export interface PenCanvasTab {
  docId: string
  title: string
  url: string
}

/** The open canvas tabs (usually 0 or 1 — one document per session). */
export const $penCanvasTabs = atom<PenCanvasTab[]>([])

const PEN_TILE_PREFIX = 'pen-tile'

export function openPenCanvasTile(tab: PenCanvasTab): void {
  // ONE canvas pane, mirroring main's single-document invariant: a new doc
  // REPLACES the pane's content rather than adding a second pane. Keeping the
  // list single-entry here means even a missed close-document event can't
  // strand a ghost pane.
  $penCanvasTabs.set([tab])

  revealTreePane(`${PEN_TILE_PREFIX}:${tab.docId}`)
}

export function closePenCanvasTile(docId: string): void {
  $penCanvasTabs.set($penCanvasTabs.get().filter(t => t.docId !== docId))
}

export function penCanvasTileOpen(): boolean {
  return $penCanvasTabs.get().length > 0
}

function tabFor(docId: string): PenCanvasTab | null {
  return $penCanvasTabs.get().find(t => t.docId === docId) ?? null
}

/** The tab's lead glyph: pen.dev's pencil-tip mark, extracted from their own
 *  logo SVG (the mark is a raster pattern inside it), alpha-trimmed and
 *  re-centered — the raw asset carried ~27% transparent padding that made it
 *  render as a dot at tab size. User-directed bundling of the processed mark. */
function PenTabLead() {
  return <img alt="" className="size-[0.8125rem] shrink-0" src={penMark} />
}

/** Mirror `$penCanvasTabs` into tree panes. Call once from the contrib root. */
export const watchPenTiles = paneMirror<PenCanvasTab>({
  source: $penCanvasTabs,
  key: tab => tab.docId,
  prefix: PEN_TILE_PREFIX,
  // Docked right of the workspace, like preview tiles — its own zone, its own
  // sash, and the canvas participates in the ONE window's layout: no second
  // shadow, no seam, theme cascades like any other pane.
  dir: () => 'right',
  minWidth: '24rem',
  // The tab row STAYS. It was hidden once (headerVeto, "the editor is the
  // chrome") and that deleted the only visible close — the user sat with
  // three canvases and no exit. One slim row carrying the pen icon, the doc
  // name, and ✕ is the honest price of an always-visible way out.
  title: docId => tabFor(docId)?.title || 'Canvas',
  tabLead: () => <PenTabLead />,
  render: docId => <PenTilePane docId={docId} />,
  close: docId => {
    // Tab close = put the canvas away for this session. Main saves the dirty
    // document (closeDocument autosaves) and broadcasts close-document; the
    // tab list is pruned by the event watcher, but prune here too so the pane
    // never outlives an unreachable webview.
    void window.hermesDesktop?.pen?.close()
    closePenCanvasTile(docId)
  }
})
