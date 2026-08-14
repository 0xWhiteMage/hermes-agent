// pen.dev host discovery — the Electron-free half of the Pen canvas
// integration. Locates the user's installed pen.dev desktop app and exposes
// the paths hermes borrows from it at runtime:
//
//   - `out/editor/`   — the full canvas editor web bundle (served over the
//                       hermes-pen:// protocol into our <webview>)
//   - `@ha/*` modules — the host-side IPC/device libraries (required straight
//                       from the asar; they are plain CJS)
//   - `out/mcp-server-<platform>` — the MCP stdio binary the agent uses to
//                       drive a live canvas over the pencil socket
//   - `out/data/*.pen` — the document templates (blank canvas, design kits)
//
// Nothing is vendored: pen.dev updates itself, and hermes always hosts
// whatever version the user has installed. When Pen isn't installed the
// integration reports unavailable and every door stays closed.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** The socket app name hermes registers with. `pen interactive -a hermes` and
 *  `mcp-server --app hermes` both resolve `~/.pencil/socket/pencil-hermes.sock`
 *  from this name (see @ha/ipc getSocketPath). */
export const PEN_SOCKET_APP_NAME = 'hermes'

export interface PenInstallation {
  /** /Applications/Pen.app */
  appPath: string
  /** …/Contents/Resources/app.asar */
  asarPath: string
  /** …/Contents/Resources/app.asar.unpacked — folderPath for getMcpConfiguration */
  unpackedPath: string
  /** …/app.asar/out/editor — the editor web bundle root */
  editorRoot: string
  /** …/app.asar/out/data — .pen templates */
  templatesRoot: string
  /** …/app.asar.unpacked/out/mcp-server-<platform> */
  mcpServerPath: string
  /** Pen.app bundle version (best effort, '' when unreadable) */
  version: string
}

function mcpBinaryName(): string {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'

  if (process.platform === 'win32') {
    return `mcp-server-windows-${arch}.exe`
  }

  if (process.platform === 'darwin') {
    return `mcp-server-darwin-${arch}`
  }

  return `mcp-server-linux-${arch}`
}

/** Candidate install locations, most specific first. */
function penAppCandidates(): string[] {
  if (process.platform === 'darwin') {
    return [
      path.join('/Applications', 'Pen.app'),
      path.join(os.homedir(), 'Applications', 'Pen.app')
    ]
  }

  // Linux/Windows installs land in per-user dirs; resources sit beside the
  // executable. Not wired yet — macOS is the only host we probe today.
  return []
}

function readBundleVersion(appPath: string): string {
  try {
    const plist = fs.readFileSync(path.join(appPath, 'Contents', 'Info.plist'), 'utf8')
    const match = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)

    return match?.[1] ?? ''
  } catch {
    return ''
  }
}

/** Locate the installed pen.dev desktop app, or null. Cheap enough to call on
 *  demand; existence is validated at every layer that relies on it. */
export function findPenInstallation(): PenInstallation | null {
  for (const appPath of penAppCandidates()) {
    const resources = path.join(appPath, 'Contents', 'Resources')
    const asarPath = path.join(resources, 'app.asar')
    const unpackedPath = path.join(resources, 'app.asar.unpacked')
    const mcpServerPath = path.join(unpackedPath, 'out', mcpBinaryName())

    // fs sees INTO the asar from Electron (asar support is patched into fs),
    // but the asar file itself is a real file for existsSync.
    if (!fs.existsSync(asarPath) || !fs.existsSync(mcpServerPath)) {
      continue
    }

    return {
      appPath,
      asarPath,
      unpackedPath,
      editorRoot: path.join(asarPath, 'out', 'editor'),
      templatesRoot: path.join(asarPath, 'out', 'data'),
      mcpServerPath,
      version: readBundleVersion(appPath)
    }
  }

  return null
}

/** Require one of Pen's host-side CJS modules straight out of its asar.
 *  Electron's patched `require`/`fs` read archive members transparently, so
 *  `@ha/ipc`, `@ha/shared`, and `@node-ipc/*` (all plain CJS dists) load as if
 *  they were on disk. The caller owns error handling — a Pen update could in
 *  principle move these, and the integration must degrade to "unavailable",
 *  never crash the app. */
export function requirePenModule(install: PenInstallation, modulePath: string): any {
   
  return require(path.join(install.asarPath, 'node_modules', modulePath))
}

/** Pen's session file — shared with Pen.app so one login covers both. */
export function penSessionFilePath(): string {
  return path.join(os.homedir(), '.pencil', 'session-desktop.json')
}

/** True when a pen.dev login token exists (Pen.app or `pen login`). */
export function penLoggedIn(): boolean {
  try {
    const session = JSON.parse(fs.readFileSync(penSessionFilePath(), 'utf8'))

    return Boolean(session?.email && session?.token)
  } catch {
    return false
  }
}

/** Where hermes keeps its temporary (unsaved) canvas documents. Mirrors Pen's
 *  own ~/.pencil/documents/<uuid>/ layout — same folder family, so pen.dev's
 *  recents/cleanup conventions treat them like any other temporary doc. */
export function penTemporaryDocumentsRoot(): string {
  return path.join(os.homedir(), '.pencil', 'documents')
}
