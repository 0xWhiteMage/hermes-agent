// Pen canvas host — hermes as a pen.dev host application.
//
// The pen.dev editor is a self-contained web bundle that speaks one JSON IPC
// protocol to whatever hosts it (their Electron app, the VS Code webview, the
// headless CLI). This module makes hermes one of those hosts:
//
//   - serves the editor bundle out of the USER'S INSTALLED Pen.app over the
//     hermes-pen:// protocol (upstream wins — nothing vendored, hermes always
//     runs the version the user has)
//   - implements the host side of the editor IPC (ResourceDevice) for
//     documents opened in hermes Canvas tabs
//   - runs Pen's transport socket as app name "hermes"
//     (~/.pencil/socket/pencil-hermes.sock) so Pen's own MCP server binary and
//     `pen interactive -a hermes` drive OUR canvas live — this is the seam the
//     hermes agent designs through
//   - proxies pen tool calls (execute / get_app_state / get_guidelines) from
//     the agent bridge to the focused canvas, falling back to the user's
//     RUNNING Pen.app socket when hermes has no canvas open (HUD mode)
//
// Everything here degrades to "unavailable" when Pen.app is missing; nothing
// throws at import time and nothing runs until the first canvas opens.

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  deletePenFromLibrary,
  findPenInstallation,
  listPenLibrary,
  PEN_SOCKET_APP_NAME,
  type PenInstallation,
  penLibraryPathFor,
  type PenLibraryEntry,
  penLibraryRoot,
  penLoggedIn,
  penSessionFilePath,
  penTemporaryDocumentsRoot,
  renamePenInLibrary,
  requirePenModule
} from './pen-host'

// ---------------------------------------------------------------------------
// Logging — quiet by default; pen host chatter is debug-only noise.
// ---------------------------------------------------------------------------

const log = {
  debug: (..._args: unknown[]) => {},
  info: (...args: unknown[]) => console.log('[pen]', ...args),
  warn: (...args: unknown[]) => console.warn('[pen]', ...args),
  error: (...args: unknown[]) => console.error('[pen]', ...args)
}

// ---------------------------------------------------------------------------
// Document registry — one entry per open canvas document.
// ---------------------------------------------------------------------------

export interface PenDocumentInfo {
  docId: string
  fileURI: string
  displayName: string
  isTemporary: boolean
}

interface PenDocument {
  docId: string
  fileURI: string
  device: any // HermesPenResourceDevice
  ipc: any | null // @ha/shared IPCHost bound to the webview guest
  guestWebContentsId: number | null
}

interface PenRuntime {
  install: PenInstallation
  shared: any // @ha/shared (IPCHost, getDocumentDisplayName, URI helpers)
  ipcLib: any // @ha/ipc (TransportServerManager, IPCDeviceManager, …)
  mcpLib: any // @ha/mcp (getMcpConfiguration)
  transportServer: any
  deviceManager: any
}

let runtime: PenRuntime | null = null
const documents = new Map<string, PenDocument>()
const events = new EventEmitter()

/** Renderer-facing change feed (documents opened/closed, agents connected). */
export function onPenEvent(event: string, listener: (...args: any[]) => void): () => void {
  events.on(event, listener)

  return () => events.off(event, listener)
}

// ---------------------------------------------------------------------------
// Runtime bring-up (lazy — first canvas open)
// ---------------------------------------------------------------------------

function ensureRuntime(): PenRuntime | null {
  if (runtime) {
    return runtime
  }

  const install = findPenInstallation()

  if (!install) {
    return null
  }

  try {
    const shared = requirePenModule(install, '@ha/shared/dist/cjs/index.js')
    const ipcLib = requirePenModule(install, '@ha/ipc/dist/index.cjs')
    const mcpLib = requirePenModule(install, '@ha/mcp/dist/cjs/index.js')

    const penLogger = {
      debug: log.debug,
      info: log.debug,
      warn: log.warn,
      error: log.error
    }

    // The transport socket IS hermes's pen identity: pencil-hermes.sock.
    // Pen's MCP server binary (spawned by the agent bridge with
    // `--app hermes`) and `pen interactive -a hermes` both dial it.
    const transportServer = new ipcLib.TransportServerManager(penLogger, PEN_SOCKET_APP_NAME)

    const deviceManager = new ipcLib.IPCDeviceManager(
      transportServer,
      penLogger,
      install.unpackedPath,
      PEN_SOCKET_APP_NAME
    )

    transportServer.start()
    deviceManager.proxyMcpToolCallRequests()

    deviceManager.on?.('open-temporary-document', async (name: string) => {
      try {
        const info = await createLibraryDocument(name)
        events.emit('open-document', info)
      } catch (error) {
        log.warn('open-temporary-document failed', error)
      }
    })

    runtime = { install, shared, ipcLib, mcpLib, transportServer, deviceManager }
    log.info(`pen host up (Pen.app ${install.version || '?'}, socket app "${PEN_SOCKET_APP_NAME}")`)
  } catch (error) {
    log.warn('pen host bring-up failed — canvas unavailable', error)
    runtime = null
  }

  return runtime
}

export function shutdownPenHost(): void {
  if (!runtime) {
    return
  }

  // Flush before teardown. This ran `documents.clear()` on quit with no save,
  // which is how unsaved canvas work was lost on restart — pen only writes on
  // an explicit ⌘S, so anything since the last one lived in memory and died
  // here. Synchronous so it completes inside the quit handler; a canvas is a
  // small JSON document, not a big write.
  for (const timer of penAutosaveTimers.values()) {
    clearTimeout(timer)
  }

  penAutosaveTimers.clear()

  for (const doc of documents.values()) {
    try {
      if (doc.device.getIsDirty()) {
        void doc.device.saveResource({ userAction: false })
      }
    } catch (error) {
      log.warn('save-on-quit failed', error)
    }
  }

  try {
    runtime.transportServer.stop()
  } catch {
    // socket already gone
  }

  documents.clear()
  runtime = null
}

// ---------------------------------------------------------------------------
// ResourceDevice — the host contract the editor + device manager program
// against. Semantics ported from Pen.app's DesktopResourceDevice, minus the
// BrowserWindow (our canvas lives in a hermes webview) and minus the embedded
// chat agent auth (hermes IS the designer here).
// ---------------------------------------------------------------------------

function createResourceDevice(rt: PenRuntime, fileURI: string, fileContent: string, hostWindow: () => any) {
  let isDirty = false
  let latestContent = fileContent
  const watched = new Map<string, { refCount: number; close: () => void }>()
  const emitter = new EventEmitter()

  const isTemporary = () => fileURI.startsWith(pathToFileURL(penTemporaryDocumentsRoot()).href)

  const resourceFolder = () => path.dirname(fileURLToPath(fileURI))

  const readSession = () => {
    try {
      return JSON.parse(fs.readFileSync(penSessionFilePath(), 'utf8'))
    } catch {
      return undefined
    }
  }

  let onSave: (uri: string, options?: Record<string, unknown>) => Promise<string> = async () => latestContent

  const device: any = {
    // -- wiring used by the manager in this module (not part of the pen contract)
    __emitter: emitter,
    __setOnSave: (fn: typeof onSave) => {
      onSave = fn
    },
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    emit: emitter.emit.bind(emitter),

    // -- identity
    getResourceURI: () => fileURI,
    getResourceContents: () => fileContent,
    getIsDirty: () => isDirty,
    getDeviceId: () => {
      const machineId = os.hostname() + os.platform() + os.arch()

       
      return require('node:crypto').createHash('md5').update(machineId).digest('hex')
    },
    getHostVersion: () => rt.install.version || '1.0.0',
    isTemporary,
    getResourceFolderPath: async () => resourceFolder(),

    // -- pen.dev login (shared file with Pen.app — one login covers both)
    getSession: () => {
      const session = readSession()

      return session?.email && session?.token ? { email: session.email, token: session.token } : undefined
    },
    setSession: (email: string, token: string) => {
      const existing = readSession() ?? {}

      fs.mkdirSync(path.dirname(penSessionFilePath()), { recursive: true })
      fs.writeFileSync(penSessionFilePath(), JSON.stringify({ ...existing, email, token }, null, 2))
    },
    signOut: () => {
      try {
        fs.unlinkSync(penSessionFilePath())
      } catch {
        // already signed out
      }
    },
    getLastOnlineAt: () => readSession()?.lastOnlineAt,
    setLastOnlineAt: (timestamp: number) => {
      const existing = readSession()

      if (existing) {
        fs.writeFileSync(penSessionFilePath(), JSON.stringify({ ...existing, lastOnlineAt: timestamp }, null, 2))
      }
    },
    getCurrentWorkspace: () => readSession()?.currentWorkspace,
    setCurrentWorkspace: (selection: unknown) => {
      const existing = readSession()

      if (existing) {
        fs.writeFileSync(
          penSessionFilePath(),
          JSON.stringify({ ...existing, currentWorkspace: selection }, null, 2)
        )
      }
    },

    // -- file I/O relative to the document
    readFile: async (filePath: string) => {
      const resolved = path.isAbsolute(filePath) ? filePath : path.join(resourceFolder(), filePath)

      return new Uint8Array(await fs.promises.readFile(resolved))
    },
    statFile: async (filePath: string) => {
      const resolved = path.isAbsolute(filePath) ? filePath : path.join(resourceFolder(), filePath)

      try {
        const stats = await fs.promises.stat(resolved)

        return { exists: true, isFile: stats.isFile(), mtimeMs: stats.mtimeMs }
      } catch (error: any) {
        if (error?.code === 'ENOENT') {
          return { exists: false, isFile: false }
        }

        throw error
      }
    },
    ensureDir: async (dirPath: string) => {
      fs.mkdirSync(dirPath, { recursive: true })
    },
    writeFile: async (filePath: string, contents: Uint8Array) => {
      fs.writeFileSync(filePath, contents)
    },
    watchFile: (uri: string) => {
      const existing = watched.get(uri)

      if (existing) {
        existing.refCount++

        return
      }

      if (!uri.startsWith('file:')) {
        return
      }

      try {
        const watcher = fs.watch(fileURLToPath(uri), { persistent: false }, () => {
          emitter.emit('file-changed', uri)
        })

        watched.set(uri, { refCount: 1, close: () => watcher.close() })
      } catch (error) {
        log.warn(`watchFile failed for ${uri}`, error)
      }
    },
    unwatchFile: (uri: string) => {
      const entry = watched.get(uri)

      if (!entry) {
        return
      }

      entry.refCount--

      if (entry.refCount <= 0) {
        entry.close()
        watched.delete(uri)
      }
    },

    // -- save / dirty lifecycle
    fileChanged: () => {
      if (!isDirty) {
        isDirty = true
        emitter.emit('dirty-changed', true)
      }
    },
    saveResource: async (params: { userAction: boolean; saveAs?: boolean; destinationPath?: string }) => {
      let destination = fileURI

      if (params.saveAs || isTemporary()) {
         
        const { dialog } = require('electron')

        const response = await dialog.showSaveDialog(hostWindow() ?? undefined, {
          title: isTemporary() ? 'Save new .pen file' : 'Save .pen file as…',
          defaultPath: isTemporary() ? 'untitled.pen' : fileURLToPath(fileURI),
          filters: [
            { name: 'Pen Design Files', extensions: ['pen'] },
            { name: 'All Files', extensions: ['*'] }
          ]
        })

        if (response.canceled || !response.filePath) {
          return true // cancelled
        }

        destination = pathToFileURL(response.filePath).href
      }

      try {
        fileContent = await onSave(destination, { assignNewFileToken: params.saveAs })
        latestContent = fileContent
        fs.writeFileSync(fileURLToPath(destination), fileContent, 'utf8')
      } catch (error) {
        log.error('save failed', error)

        return false
      }

      if (destination !== fileURI) {
        // Saved-as: hand the new location back through the load-file path so
        // the tab re-homes onto the real file.
        emitter.emit('load-file', { fileURI: destination, zoomToFit: false, closeCurrent: true })
      }

      if (isDirty) {
        isDirty = false
        emitter.emit('dirty-changed', false)
      }

      return false
    },
    loadFile: (uri: string) => {
      emitter.emit('load-file', { fileURI: uri, zoomToFit: true })
    },

    // -- imports (drag/drop + paste land through these)
    importFiles: async (files: { fileName: string; fileContents: ArrayBufferLike }[]) => {
      const baseDirectory = resourceFolder()
      const imagesDirectory = isTemporary() ? path.join(baseDirectory, 'images') : baseDirectory

      await fs.promises.mkdir(imagesDirectory, { recursive: true })

      const result: { filePath: string }[] = []

      for (const { fileName, fileContents } of files) {
        const ext = path.extname(fileName)
        const base = path.basename(fileName, ext)
        const buffer = Buffer.from(fileContents)
        let candidate = path.join(imagesDirectory, `${base}${ext}`)
        let counter = 0

        for (;;) {
          try {
            await fs.promises.writeFile(candidate, buffer, { flag: 'wx' })
            result.push({ filePath: path.relative(baseDirectory, candidate) })

            break
          } catch (error: any) {
            if (error?.code !== 'EEXIST') {
              throw error
            }
          }

          const existing = await fs.promises.readFile(candidate).catch(() => null)

          if (existing?.equals(buffer)) {
            result.push({ filePath: path.relative(baseDirectory, candidate) })

            break
          }

          counter++
          candidate = path.join(imagesDirectory, `${base}-${counter}${ext}`)
        }
      }

      return result
    },
    importFileByName: async (fileName: string, fileContents: ArrayBufferLike) => {
      const imported = await device.importFiles([{ fileName, fileContents }])

      if (!imported[0]) {
        throw new Error('Failed to import file')
      }

      return imported[0]
    },
    importFileByUri: async (fileUriString: string) => {
      const sourceFile = fileURLToPath(fileUriString)
      const fileContents = fs.readFileSync(sourceFile)
      const imported = await device.importFileByName(path.basename(sourceFile), fileContents.buffer)

      return { filePath: imported.filePath, fileContents: fileContents.buffer }
    },

    // -- appearance / window
    getActiveThemeKind: () => {
      // Follow HERMES's theme, not the OS's. The canvas blends with the app it
      // sits beside; nativeTheme diverges the moment the user themes hermes
      // differently from macOS (dark canvas + black chrome inside a light
      // app). Luminance of the host window background is the ground truth the
      // app itself paints with.
      const hex = penHostBackground().replace('#', '')

      if (hex.length >= 6) {
        const r = parseInt(hex.slice(0, 2), 16)
        const g = parseInt(hex.slice(2, 4), 16)
        const b = parseInt(hex.slice(4, 6), 16)

        return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128 ? 'dark' : 'light'
      }

      const { nativeTheme } = require('electron')

      return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
    },
    toggleDesignMode: () => {},
    setLeftSidebarVisible: () => {},
    openExternalUrl: (url: string, options?: { showInFolder?: boolean }) => {
       
      const { shell } = require('electron')

      let scheme = ''

      try {
        scheme = new URL(url).protocol.toLowerCase()
      } catch {
        return
      }

      if (options?.showInFolder && scheme === 'file:') {
        shell.showItemInFolder(fileURLToPath(url))

        return
      }

      if (scheme === 'http:' || scheme === 'https:' || scheme === 'file:') {
        shell.openExternal(url)
      }
    },

    // -- the editor's own chat panel (Claude/Codex in-canvas). Hermes is the
    // designer here; the panel degrades to not-connected without these.
    submitPrompt: async (prompt: string) => {
      // "Add to chat" from the canvas — forward into the hermes composer.
      events.emit('add-to-chat', { fileURI, prompt })
    },
    getAgentPackagePath: () => undefined,
    getAgentLoginType: () => undefined,
    getAgentApiKey: () => undefined,
    getAgentEnv: () => undefined,
    agentIncludePartialMessages: () => true,

    // -- temp files (clipboard paste path)
    saveTempFile: async (base64Data: string, ext: string, name?: string) => {
      const tmpDir = path.join(os.tmpdir(), 'pencil-clipboard')

      await fs.promises.mkdir(tmpDir, { recursive: true })

      const filePath = path.join(tmpDir, name || `clipboard-${Date.now()}.${ext}`)

      await fs.promises.writeFile(filePath, Buffer.from(base64Data, 'base64'))

      return filePath
    },
    cleanupTempFiles: async (paths: string[]) => {
      const tmpDir = path.resolve(os.tmpdir(), 'pencil-clipboard')

      for (const p of paths) {
        const resolved = path.resolve(p)

        if (path.dirname(resolved) === tmpDir) {
          await fs.promises.unlink(resolved).catch(() => {})
        }
      }
    },

    // -- workspace folder (the agent cwd for canvas work)
    getWorkspaceFolderPath: async () => resourceFolder(),
    setWorkspaceFolderPath: async () => {},

    // -- libraries
    findLibraries: async () => {
      if (!fileURI.startsWith('file:')) {
        return []
      }

      const libraries: string[] = []
      const ignored = new Set(['node_modules', '.git'])
      const visited = new Set<string>()

      const collect = async (target: string) => {
        let entries: string[]

        try {
          let stats = await fs.promises.stat(target)

          if (stats.isSymbolicLink()) {
            target = await fs.promises.realpath(target)
            stats = await fs.promises.stat(target)
          }

          if (visited.has(target)) {
            return
          }

          visited.add(target)

          if (stats.isDirectory()) {
            entries = await fs.promises.readdir(target)
          } else {
            if (stats.isFile() && target.toLowerCase().endsWith('.lib.pen')) {
              libraries.push(target)
            }

            return
          }
        } catch {
          return
        }

        for (const entry of entries) {
          if (!ignored.has(entry)) {
            await collect(path.join(target, entry))
          }
        }
      }

      await collect(resourceFolder())

      return libraries
    },
    turnIntoLibrary: async () => {
      throw new Error('turn-into-library is not supported in the hermes canvas yet')
    },
    browseLibraries: async (multiple: boolean) => {
       
      const { dialog } = require('electron')

      const result = await dialog.showOpenDialog(hostWindow() ?? undefined, {
        filters: [{ name: 'Pen Libraries', extensions: ['lib.pen'] }],
        properties: multiple ? ['multiSelections'] : undefined
      })

      return result.canceled ? undefined : result.filePaths
    },

    // -- share snapshot import
    pickSnapshotExtractDirectory: async () => {
       
      const { dialog } = require('electron')

      const result = await dialog.showOpenDialog(hostWindow() ?? undefined, {
        properties: ['openDirectory', 'createDirectory'],
        title: 'Choose folder to extract snapshot'
      })

      if (result.canceled || result.filePaths.length === 0) {
        return { cancelled: true }
      }

      return { cancelled: false, directoryPath: result.filePaths[0] }
    },
    writeSnapshotImport: async (
      destinationDir: string,
      items: { relativePath: string; data: Uint8Array | ArrayBufferLike }[],
      rootPenRelativePath: string
    ) => {
      for (const item of items) {
        const outputPath = path.join(destinationDir, item.relativePath)

        await fs.promises.mkdir(path.dirname(outputPath), { recursive: true })
        await fs.promises.writeFile(
          outputPath,
          item.data instanceof Uint8Array ? item.data : new Uint8Array(item.data)
        )
      }

      return { rootFilePath: path.join(destinationDir, rootPenRelativePath) }
    },

    dispose: async () => {
      for (const entry of watched.values()) {
        entry.close()
      }

      watched.clear()
      emitter.removeAllListeners()
    }
  }

  return device
}

// ---------------------------------------------------------------------------
// Document lifecycle
// ---------------------------------------------------------------------------

/**
 * A brand-new canvas, created in the LIBRARY (~/.hermes/pens/<name>/<name>.pen)
 * rather than pen's temporary-documents folder.
 *
 * Temporary documents are invisible and effectively disposable — nothing lists
 * them, and a restart strands whatever you drew. Writing a real file up front
 * means every canvas is browsable, reopenable, renameable, and deletable from
 * the moment it exists, and there's no "unsaved draft" state to lose.
 */
async function createLibraryDocument(templateName = 'pencil-new.pen', name?: string): Promise<PenDocumentInfo> {
  const rt = ensureRuntime()

  if (!rt) {
    throw new Error('pen.dev is not installed')
  }

  if (!templateName.endsWith('.pen')) {
    templateName = `pencil-${templateName}.pen`
  }

  const templatePath = path.join(rt.install.templatesRoot, templateName)
  const newFilePath = penLibraryPathFor(name || 'Untitled')

  await fs.promises.mkdir(path.dirname(newFilePath), { recursive: true })
  await fs.promises.copyFile(templatePath, newFilePath)

  return openDocumentByUri(pathToFileURL(newFilePath).href)
}

async function openDocumentByUri(fileURI: string): Promise<PenDocumentInfo> {
  const rt = ensureRuntime()

  if (!rt) {
    throw new Error('pen.dev is not installed')
  }

  // One tab per document — reopening an open file re-fronts its tab.
  for (const doc of documents.values()) {
    if (doc.fileURI === fileURI) {
      return describeDocument(doc)
    }
  }

  const filePath = fileURLToPath(fileURI)
  const fileContent = await fs.promises.readFile(filePath, 'utf8')
  const docId = randomUUID()

  const device = createResourceDevice(rt, fileURI, fileContent, () => {
     
    const { BrowserWindow } = require('electron')

    return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
  })

  const doc: PenDocument = { docId, fileURI, device, ipc: null, guestWebContentsId: null }

  documents.set(docId, doc)

  device.on('load-file', async (ev: { fileURI: string; zoomToFit?: boolean; closeCurrent?: boolean }) => {
    try {
      const info = await openDocumentByUri(ev.fileURI)

      events.emit('open-document', info)

      if (ev.closeCurrent) {
        closeDocument(docId)
        events.emit('close-document', { docId })
      }
    } catch (error) {
      log.warn('load-file failed', error)
    }
  })

  device.on('dirty-changed', (dirty: boolean) => {
    doc.ipc?.notify('dirty-changed', dirty)
    events.emit('dirty-changed', { docId, dirty })

    // AUTOSAVE. pen has no autosave of its own — its save path only runs on an
    // explicit ⌘S (userAction) or save-as, so closing the drawer, switching
    // sessions, or quitting silently discarded everything since the last
    // manual save. Hermes opens canvases on the user's behalf and reopens them
    // across restarts, so it owns this: a canvas that comes back empty is the
    // worst possible outcome.
    //
    // Debounced, because dirty-changed fires on the first edit of each burst;
    // a drag produces a continuous stream and every write is a full document
    // serialize + fsync.
    if (dirty) {
      schedulePenAutosave(doc)
    }
  })

  device.on('file-changed', (uri: string) => {
    doc.ipc?.notify('file-changed', uri)
  })

  return describeDocument(doc)
}

// ---------------------------------------------------------------------------
// Autosave
// ---------------------------------------------------------------------------

// Long enough that a drag or a burst of agent edits collapses into one write,
// short enough that nothing meaningful is ever more than a couple of seconds
// from disk.
const PEN_AUTOSAVE_DEBOUNCE_MS = 1_500

const penAutosaveTimers = new Map<string, NodeJS.Timeout>()

/**
 * Persist a dirty document.
 *
 * Goes through the device's own `saveResource` so it takes exactly the path
 * ⌘S takes — same serializer, same dirty bookkeeping — rather than writing
 * the file behind the editor's back and leaving it thinking it's still dirty.
 *
 * `userAction: false` matters: a document that has never been saved would
 * otherwise raise a save dialog, and an autosave must never steal focus with
 * a modal. Untitled canvases don't need one anyway — hermes already created
 * them as real files in the library.
 */
export async function savePenDocument(doc: PenDocument): Promise<boolean> {
  penAutosaveTimers.delete(doc.docId)

  try {
    if (!doc.device.getIsDirty()) {
      return true
    }

    await doc.device.saveResource({ userAction: false })

    return true
  } catch (error) {
    log.warn('autosave failed', error)

    return false
  }
}

function schedulePenAutosave(doc: PenDocument): void {
  const existing = penAutosaveTimers.get(doc.docId)

  if (existing) {
    clearTimeout(existing)
  }

  penAutosaveTimers.set(
    doc.docId,
    setTimeout(() => void savePenDocument(doc), PEN_AUTOSAVE_DEBOUNCE_MS)
  )
}

/** Flush every dirty canvas right now — before a close, a session swap, or
 *  app quit, where waiting out the debounce would lose the tail of the work. */
export async function flushPenAutosaves(): Promise<void> {
  const pending = [...documents.values()]

  for (const timer of penAutosaveTimers.values()) {
    clearTimeout(timer)
  }

  penAutosaveTimers.clear()

  await Promise.all(pending.map(doc => savePenDocument(doc)))
}

function describeDocument(doc: PenDocument): PenDocumentInfo {
  const isTemporary = doc.device.isTemporary()
  const basename = path.basename(doc.fileURI)

  return {
    docId: doc.docId,
    fileURI: doc.fileURI,
    displayName: isTemporary && basename === 'pencil-new.pen' ? 'Untitled' : basename.replace(/\.pen$/, ''),
    isTemporary
  }
}

/** Whether the embedded canvas hides pen's OWN agent — the floating chat
 *  panel, its composer, and the toolbar button that reopens it. Hermes is the
 *  agent for this canvas, so a second one is a duplicate that can also drive
 *  the document behind hermes's back; hidden by default, but a toggle, since
 *  pen's agent is a real feature.
 *
 *  This is the value baked into each canvas as it loads; flipping an
 *  already-open canvas is the host's job (it owns the WebContents). */
let penAgentHidden = true

export function setPenAgentHidden(hidden: boolean): void {
  penAgentHidden = hidden
}

export function isPenAgentHidden(): boolean {
  return penAgentHidden
}

/** The one-liner that flips an already-loaded canvas, so the host doesn't
 *  hand-roll the attribute name. */
export function penAgentScript(hidden: boolean): string {
  return `document.documentElement.dataset.hermesPenAgent = ${JSON.stringify(hidden ? 'hidden' : 'shown')}`
}

/** The theme kind last delivered to live editors, so repaint only nudges them
 *  when the host's kind actually flipped — 'toggle-theme' is a blind flip
 *  (it's pen's own menu verb), so an idempotent repaint must gate it. */
let lastPenThemeKind: null | string = null

/** Re-theme every live editor to the CURRENT host chrome. Pen takes its theme
 *  once at boot (initParams.theme ← getActiveThemeKind), so a hermes theme
 *  flip must push: notify 'toggle-theme' — the same signal Pen.app's own menu
 *  sends — which makes the editor flip dark/light, and re-run the chrome
 *  script so the page background follows. Call AFTER setPenHostChrome. */
export async function repaintPenTheme(): Promise<void> {
  const doc = [...documents.values()][0]

  if (doc) {
    // What SHOULD the editors show now? (host background luminance)
    const kind = doc.device.getActiveThemeKind()

    if (kind !== lastPenThemeKind) {
      lastPenThemeKind = kind

      for (const live of documents.values()) {
        try {
          live.ipc?.notify('toggle-theme', {})
        } catch {
          // Cosmetic.
        }
      }
    }
  }

  await runPenGuestScript(penHostChromeScript())
}

/** Run a script in every live canvas guest (webview-hosted editor pages).
 *  Presence, chrome re-theme, agent visibility — all cosmetic, all
 *  fire-and-forget; failures never surface. */
export async function runPenGuestScript(script: string): Promise<void> {
  const { webContents } = require('electron')

  for (const doc of documents.values()) {
    if (!doc.guestWebContentsId) {
      continue
    }

    const target = webContents.fromId(doc.guestWebContentsId)

    if (target && !target.isDestroyed()) {
      await target.executeJavaScript(script, true).catch(() => {})
    }
  }
}

/** Close every live document except `keepDocId` (pass null to close all).
 *  THE single-canvas invariant, enforced where documents live — every open
 *  path (pill, ⌘K, agent, restore, session swap) funnels through open/restore
 *  in main, and those call this. Each close autosaves first (closeDocument).
 *  Returns the docIds closed so callers can prune ties. */
export function closeOtherPenDocuments(keepDocId: null | string): string[] {
  const closed: string[] = []

  for (const docId of [...documents.keys()]) {
    if (docId !== keepDocId) {
      closeDocument(docId)
      closed.push(docId)
    }
  }

  return closed
}

/** Is this document still open in THIS launch? A temporary (never-saved)
 *  canvas exists only as a live document, so session restore uses this to
 *  tell "reattach to the draft" from "reopen the file". */
export function documentIsOpen(docId: string): boolean {
  return Boolean(docId) && documents.has(docId)
}

export function closeDocument(docId: string): void {
  const doc = documents.get(docId)

  if (!doc) {
    return
  }

  // Save BEFORE teardown. Closing the drawer, swapping sessions, and deleting
  // all route through here, and the debounce may not have fired yet — this is
  // the last moment the document still exists to be written.
  //
  // Synchronous-ish by design: kicked off before removeResource so the device
  // is still live, and awaited by flushPenAutosaves on the quit path.
  const timer = penAutosaveTimers.get(docId)

  if (timer) {
    clearTimeout(timer)
    penAutosaveTimers.delete(docId)
  }

  try {
    if (doc.device.getIsDirty()) {
      void doc.device.saveResource({ userAction: false })
    }
  } catch (error) {
    log.warn('save-on-close failed', error)
  }

  documents.delete(docId)

  try {
    runtime?.deviceManager.removeResource(doc.fileURI)
  } catch (error) {
    log.warn('removeResource failed', error)
  }
}

export function getDocument(docId: string): PenDocument | undefined {
  return documents.get(docId)
}

// ---------------------------------------------------------------------------
// Webview attach — bind the editor guest to its document's IPC host.
// ---------------------------------------------------------------------------

/** Wire a freshly attached <webview> guest showing hermes-pen://editor?doc=…
 *  to its document. Called from main.ts's did-attach-webview handler. */
export function bindPenWebview(guestContents: any): boolean {
  const url = guestContents.getURL?.() || ''

  if (!url.startsWith('hermes-pen://')) {
    return false
  }

  const rt = ensureRuntime()

  if (!rt) {
    return false
  }

  let docId = ''

  try {
    docId = new URL(url).searchParams.get('doc') || ''
  } catch {
    return false
  }

  const doc = documents.get(docId)

  if (!doc) {
    log.warn(`webview attached for unknown pen doc ${docId}`)

    return false
  }

  // Idempotent per guest: a reload rebinds, a duplicate event is a no-op.
  if (doc.ipc && doc.guestWebContentsId === guestContents.id) {
    return true
  }

   
  const { ipcMain } = require('electron')

  const penLogger = { debug: log.debug, info: log.debug, warn: log.warn, error: log.error }

  const onMessage = (callback: (message: unknown) => void) => {
    const listener = (event: any, message: unknown) => {
      if (event.sender.id === guestContents.id) {
        callback(message)
      }
    }

    ipcMain.on('ipc-message', listener)

    return () => {
      ipcMain.off('ipc-message', listener)
    }
  }

  const sendMessage = (message: unknown) => {
    if (!guestContents.isDestroyed()) {
      guestContents.send('ipc-message', message)
    }
  }

  const ipc = new rt.shared.IPCHost(onMessage, sendMessage, penLogger)

  doc.ipc = ipc
  doc.guestWebContentsId = guestContents.id

  // Editor → host: pull document content through the save round-trip (the
  // editor serializes the canvas and hands it back).
  doc.device.__setOnSave((uri: string, options?: Record<string, unknown>) =>
    ipc.request('save', { uri, ...options })
  )

  // App-level handlers Pen's PencilApp registers beside the device manager's.
  ipc.handle('get-fullscreen', () => false)
  ipc.handle('get-active-integrations', () => ({ active: [], supported: [] }))
  ipc.handle('get-mcp-config', () => {
    const config = rt.mcpLib.getMcpConfiguration({
      folderPath: rt.install.unpackedPath,
      appName: PEN_SOCKET_APP_NAME
    })

    return JSON.stringify(config)
  })
  ipc.on('save-preview', () => {})
  ipc.on('set-native-theme', () => {})
  ipc.on('toggle-theme', () => {})
  ipc.on('desktop-open-terminal', () => {})
  ipc.on('agent-text-size-changed', () => {})
  ipc.on('share-upload-changed', () => {})
  ipc.on('show-about', () => {})
  ipc.on('open-new-file-picker', () => {
    void createLibraryDocument('pencil-new.pen')
      .then(info => events.emit('open-document', info))
      .catch(error => log.warn('new-file-picker open failed', error))
  })
  ipc.on('add-to-chat', (message: unknown) => {
    events.emit('add-to-chat', { fileURI: doc.fileURI, message })
  })

  // The device manager wires the whole editor contract (get-session,
  // read-file, initialized → file-update, agent probes, chat sessions, …).
  rt.deviceManager.addResource(ipc, doc.device)
  rt.deviceManager.updateLastResource(doc.fileURI)

  guestContents.once('destroyed', () => {
    closeDocument(docId)
  })

  guestContents.on('focus', () => {
    rt.deviceManager.updateLastResource(doc.fileURI)
  })

  log.info(`canvas bound: ${path.basename(doc.fileURI)} (guest ${guestContents.id})`)

  return true
}

// ---------------------------------------------------------------------------
// hermes-pen:// protocol — serve the editor bundle from the installed Pen.app.
// ---------------------------------------------------------------------------

export const PEN_PROTOCOL = 'hermes-pen'

/** Host chrome the canvas should match: hermes's window background. Set by
 *  main (which owns the theme) so the canvas can blend instead of theming
 *  itself. NO scale plumbing: the editor renders 1:1 in its pane — a
 *  fullscreen canvas in a tile, nothing more. */
const penHostChrome = { background: '#1e1e1e' }

/** The host window's background — also the theme oracle for the editor
 *  (getActiveThemeKind derives dark/light from its luminance). */
export function penHostBackground(): string {
  return penHostChrome.background
}

export function setPenHostChrome(next: { background?: string }): void {
  if (next.background) {
    penHostChrome.background = next.background
  }
}

/** Apply host chrome to an already-open canvas, so a theme flip or a zoom
 *  change doesn't wait for a reopen. */
export function penHostChromeScript(): string {
  return `(() => {
    document.documentElement.dataset.hermesPenBg = ''
    document.documentElement.style.setProperty('--hermes-host-bg', ${JSON.stringify(penHostChrome.background)})
    // Keep the editor's own persisted theme in agreement (localStorage wins
    // over boot params in pen's resolution order).
    try {
      const kind = ${JSON.stringify(lastPenThemeKind || 'light')}
      localStorage.setItem('theme', kind)
      document.documentElement.classList.remove('dark', 'light')
      document.documentElement.classList.add(kind)
    } catch {}
  })()`
}

/**
 * Host chrome suppression for the embedded canvas.
 *
 * The drawer is a CANVAS, not a second app: hermes already owns the window,
 * the titlebar, the traffic lights, and the chat. So pen's own app chrome is
 * hidden — its left panel (Agent / Layers / Slides / Components / Libraries),
 * the layer-list, new-file, and settings buttons, its Agents menu, and the
 * titlebar drag strip (which would otherwise fight hermes's drag region and
 * move the window when you meant to draw).
 *
 * What STAYS is anything that acts on the design: Share, present, and
 * open-in-browser, plus the whole toolbar and the canvas itself.
 *
 * Targeted by pen's own stable aria-labels rather than its hashed utility
 * classes, and injected as a stylesheet — pen's markup and bundle are never
 * modified, so an upstream update can't be broken by this, only ignored.
 */
const PEN_HOST_CHROME_STYLE = `<style id="hermes-pen-host-chrome">
      /* Pen's own app chrome — hermes already owns the window and the chat. */
      [aria-label="toggle-layer-list"],
      [aria-label="toggle-new-file"],
      [aria-label="open-settings"],
      [aria-label="Agent sessions"],
      [aria-label="Agent panel controls"] {
        display: none !important;
      }

      /* Pen's LEFT PANEL — the Agent/Layers/Slides/Components/Libraries rail
         and everything it hosts. This is a ~320px column, which on a drawer
         is most of the canvas; hiding only its buttons left the column itself
         sitting there. Tagged at runtime by its tab rail (below). */
      html[data-hermes-pen-agent='hidden'] [data-hermes-pen-side-panel] {
        display: none !important;
      }

      /* Pen's agent, in full: the floating chat panel, its header bar, its
         composer, and the toolbar button that reopens it. Tagged at runtime
         (see the tagger below) because these carry hashed utility classes,
         not stable hooks.

         Hermes IS the agent here — a second chat inside the canvas is a
         duplicate that can also drive the document behind hermes's back. Kept
         as a toggle rather than a deletion: pen's agent is a real feature. */
      html[data-hermes-pen-agent='hidden'] [data-hermes-pen-agent-chat],
      html[data-hermes-pen-agent='hidden'] [data-hermes-pen-agent-launcher] {
        display: none !important;
      }

      /* The canvas lives INSIDE a hermes pane now — pen's own titlebar drag
         strip must not fight the embedding window's drag regions. */
      .drag,
      [style*="app-region: drag"] {
        -webkit-app-region: no-drag !important;
      }

      /* Pen's example-prompt chips ("Control panel for a humanoid robotics
         factory floor", …). They're pen's agent onboarding; hermes is the
         agent here, so they're noise that eats the top of a narrow canvas. */
      html[data-hermes-pen-agent='hidden'] [data-hermes-pen-examples] {
        display: none !important;
      }

      /* The bottom bar: rotating preset prompts + the zoom pill. Chromeless
         means chromeless — pan/zoom stay on trackpad and keyboard. */
      html[data-hermes-pen-agent='hidden'] [data-hermes-pen-bottom-bar] {
        display: none !important;
      }

      /* BACKGROUND — blend with hermes.
         pen's own html/body are transparent, so the canvas shows whatever the
         native view paints behind it. Painting the host's window colour here
         means the drawer reads as part of the app instead of a pasted-in
         rectangle with its own theme. */
      html[data-hermes-pen-bg],
      html[data-hermes-pen-bg] body {
        background: var(--hermes-host-bg) !important;
      }

    </style>`

/**
 * Runtime tagger for pen's agent surface.
 *
 * Pen's chat panel is styled with hashed utility classes, so there's nothing
 * stable to write a CSS selector against. What IS stable is its accessible
 * labels ("Minimize chat", "Open agent tab", "New agent"), so we find those
 * and tag their panel — CSS above does the hiding. Runs on load and on any
 * DOM change, because the panel mounts late and remounts per document.
 *
 * Never edits pen's markup: it only adds data-attributes on the host side,
 * so an upstream update can ignore this rather than break on it.
 */
const PEN_HOST_CHROME_TAGGER = `<script id="hermes-pen-host-tagger">
      (() => {
        // Set from the host on every load. Done HERE rather than by patching
        // the <html> tag in the served markup: that replace silently no-ops if
        // the tag doesn't match byte-for-byte, and it did — the flag never
        // arrived and nothing was hidden.
        document.documentElement.dataset.hermesPenAgent = '__HERMES_PEN_AGENT__'

        // THEME, at the editor's real source of truth. Pen resolves theme as
        // localStorage("theme") ?? "dark" — localStorage BEATS the host's
        // initParams.theme (verified in the shipped bundle), and the default
        // is dark. So a stale/absent localStorage value paints pen's whole
        // workspace near-black inside a light hermes no matter what boot
        // params say. This script runs before the editor's module scripts:
        // writing the host's kind here makes every later read agree.
        try {
          localStorage.setItem('theme', '__HERMES_PEN_THEME__')
          document.documentElement.classList.remove('dark', 'light')
          document.documentElement.classList.add('__HERMES_PEN_THEME__')
        } catch {}

        // Blend with hermes: paint the host window's own background colour
        // instead of pen's, so the drawer doesn't read as a pasted-in panel.
        document.documentElement.dataset.hermesPenBg = ''
        document.documentElement.style.setProperty('--hermes-host-bg', '__HERMES_PEN_BG__')

        const CHAT_MARKS = ['Minimize chat', 'Open agent tab', 'New agent', 'Send message', 'Agent panel controls', 'Agent sessions', 'New conversation']

        const tagChat = () => {
          // The drawing surface — the one thing hiding must never touch.
          const canvas = document.querySelector('canvas')

          for (const mark of CHAT_MARKS) {
            for (const el of document.querySelectorAll('[aria-label="' + mark + '"]')) {
              // The agent panel has a real boundary in pen's own markup: a
              // <section> wrapping the whole panel (measured live: one
              // section holds Agent panel controls / Agent sessions / Send
              // message). Prefer that boundary — climbing "as far as
              // possible" swallowed the wrapper that also hosts the floating
              // TOOL RAIL, which is how manual design controls vanished.
              const section = el.closest('section')

              if (section && !(canvas && section.contains(canvas))) {
                section.dataset.hermesPenAgentChat = ''
                continue
              }

              // Fallback (no section boundary): bounded walk, tight area cap
              // so it can never swallow toolbar-bearing wrappers.
              let node = el.parentElement
              let panel = el

              for (let hops = 0; node && node !== document.body && hops < 10; hops += 1) {
                if (canvas && node.contains(canvas)) break

                const rect = node.getBoundingClientRect()

                if (rect.width * rect.height > innerWidth * innerHeight * 0.35) break

                if (rect.width > 80 || rect.height > 40) panel = node

                node = node.parentElement
              }

              if (panel) panel.dataset.hermesPenAgentChat = ''
            }
          }

          // The BOTTOM BAR — preset prompt chips + the zoom pill. Located
          // structurally: the zoom readout is the only "NN%" text on the
          // page, so climb from it to the outermost bottom-anchored strip.
          // No text-matching of preset copy (it rotates per launch).
          for (const el of document.querySelectorAll('button, span, div')) {
            if (el.children.length > 0) continue
            if (!/^\\d{1,3}%$/.test((el.textContent || '').trim())) continue

            let node = el.parentElement
            let bar = null

            for (let hops = 0; node && node !== document.body && hops < 10; hops += 1) {
              if (canvas && node.contains(canvas)) break

              const rect = node.getBoundingClientRect()

              // Bottom-anchored, shallow, not the whole page: the bar.
              if (rect.height < 140 && rect.bottom > innerHeight - 16) bar = node

              node = node.parentElement
            }

            if (bar) bar.dataset.hermesPenBottomBar = ''
          }

          // The preset-prompt strip that FLOATS over the canvas bottom (its
          // live fingerprint: absolute + bottom-anchored + z-40 + select-text,
          // measured in the running canvas). Structural, not text: any
          // absolutely-positioned bottom-anchored layer that only contains
          // buttons/text, sits above the canvas, and is not the zoom pill.
          for (const el of document.querySelectorAll('div')) {
            if ('hermesPenBottomBar' in el.dataset || 'hermesPenExamples' in el.dataset) continue

            const style = getComputedStyle(el)

            if (style.position !== 'absolute') continue
            if (canvas && el.contains(canvas)) continue

            const rect = el.getBoundingClientRect()

            if (rect.height < 8 || rect.height > 160) continue
            // anchored to the bottom edge of the viewport (within 96px)
            if (innerHeight - rect.bottom > 96) continue
            // pure text/button content — a strip of prompt pills
            if (el.querySelector('canvas, input, [contenteditable="true"]')) continue
            if (!el.querySelector('button') && !/\\S/.test(el.textContent || '')) continue
            // never the zoom pill itself (NN%)
            if (/^\\s*[-+]?\\s*\\d{1,3}%/.test((el.textContent || '').trim())) continue

            el.dataset.hermesPenExamples = ''
          }

          // The toolbar button that reopens the agent. Matched on its own text
          // because it carries no aria-label.
          for (const button of document.querySelectorAll('button')) {
            if ((button.textContent || '').trim() === 'Agents') button.dataset.hermesPenAgentLauncher = ''
          }

          // Pen's left panel. Identified by its tab rail — the row holding
          // Layers/Slides/Components, which is stable naming even though the
          // classes are hashed. From the rail we climb to the column that
          // OWNS it (tall, and a real fraction of the viewport), so the whole
          // panel goes rather than just the tabs.
          const TABS = ['Layers', 'Slides', 'Components', 'Libraries']

          for (const button of document.querySelectorAll('button')) {
            if ((button.textContent || '').trim() !== 'Layers') continue

            const rail = button.parentElement
            if (!rail) continue

            const labels = [...rail.children].map(c => (c.textContent || '').trim())
            if (TABS.filter(tab => labels.includes(tab)).length < 3) continue

            let node = rail
            let panel = null

            for (let hops = 0; node && node !== document.body && hops < 8; hops += 1) {
              const rect = node.getBoundingClientRect()

              // A tall column that is NOT the whole editor: that's the panel.
              if (rect.height > innerHeight * 0.5 && rect.width > 80 && rect.width < innerWidth * 0.9) {
                panel = node
              }

              node = node.parentElement
            }

            if (panel) panel.dataset.hermesPenSidePanel = ''
          }
        }

        // Pen's example-prompt chips. They live in TWO places (the agent
        // panel's column and the canvas's bottom bar), so tag every chip
        // directly and every container holding two or more — a single-return
        // walk here left the bottom-bar set visible.
        const tagExamples = () => {
          const chips = [...document.querySelectorAll('button')].filter(b =>
            /humanoid robotics|Lisbon coworking|matcha|Retro-futuristic|meditation app|trading|magazine-style|reservation app/i.test(b.textContent || '')
          )

          for (const chip of chips) chip.dataset.hermesPenExamples = ''

          for (const chip of chips) {
            let node = chip.parentElement
            for (let hops = 0; node && node !== document.body && hops < 6; hops += 1) {
              const inside = chips.filter(c => node.contains(c)).length
              if (inside >= 2 && inside === node.querySelectorAll('button').length) {
                node.dataset.hermesPenExamples = ''
                break
              }
              node = node.parentElement
            }
          }
        }

        // Each step isolated: one selector churning under pen's re-renders
        // must not starve the others.
        const boot = () => {
          try { tagChat() } catch {}
          try { tagExamples() } catch {}
        }

        boot()
        document.addEventListener('DOMContentLoaded', boot)
        new MutationObserver(boot).observe(document.documentElement, { childList: true, subtree: true })
      })()
    </script>`

/**
 * AGENT PRESENCE — the "Hermes is here" cursor.
 *
 * pen drives the canvas through MCP operations, not synthetic input, so there
 * is no real pointer to mirror. This draws one: a labelled cursor that parks
 * over whatever hermes is touching, plus a status chip, so the user can see
 * WHERE the agent is working instead of watching nodes appear from nowhere.
 *
 * Positioning is driven from the editor's own selection bounds
 * (selectionBoundsWorld → screen), so it tracks the real thing rather than a
 * guess, and it rides pen's viewport transform: pan/zoom and it stays put.
 *
 * Injected into the canvas page; pen's own markup is never modified.
 */
const PEN_AGENT_CURSOR = `<script id="hermes-pen-agent-cursor">
      (() => {
        const NS = 'hermesPenCursor'
        if (window[NS]) return

        const ACCENT = '#7c5cff'
        let el = null
        let hideTimer = 0

        const build = () => {
          if (el || !document.body) return el

          el = document.createElement('div')
          el.setAttribute('data-hermes-pen-cursor', '')
          el.style.cssText = [
            'position:fixed',
            'left:0','top:0',
            'z-index:2147483600',
            'pointer-events:none',
            'opacity:0',
            'display:flex',
            'align-items:flex-start',
            'gap:4px',
            'transform:translate3d(-100px,-100px,0)',
            'transition:transform 320ms cubic-bezier(.22,1,.36,1), opacity 160ms ease-out',
            'will-change:transform'
          ].join(';')

          // Arrow + label, the shape every multiplayer cursor uses.
          el.innerHTML =
            '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))">' +
            '<path d="M3 2.5 L14 8.2 L9.1 9.6 L7.3 14.3 Z" fill="' + ACCENT + '" stroke="#fff" stroke-width="1.1" stroke-linejoin="round"/>' +
            '</svg>' +
            '<span data-label style="' +
            'background:' + ACCENT + ';color:#fff;font:500 11px/1.45 ui-sans-serif,system-ui,sans-serif;' +
            'padding:2px 7px;border-radius:999px;white-space:nowrap;margin-top:10px;' +
            'box-shadow:0 1px 3px rgba(0,0,0,.28)">Hermes</span>'

          document.body.append(el)
          return el
        }

        // The editor's live viewport transform, so canvas coords land on the
        // right pixels at any pan/zoom.
        const toScreen = (x, y) => {
          try {
            const app = window.pencilApp || window.app || null
            const vp = app && (app.viewport || app.camera)
            if (vp && typeof vp.worldToScreen === 'function') {
              const p = vp.worldToScreen({ x: x, y: y })
              return [p.x, p.y]
            }
            if (vp && typeof vp.zoom === 'number') {
              return [x * vp.zoom + (vp.x || 0), y * vp.zoom + (vp.y || 0)]
            }
          } catch {}
          return null
        }

        const place = (label, point) => {
          const node = build()
          if (!node) return

          if (label) node.querySelector('[data-label]').textContent = label

          if (point) {
            const screen = toScreen(point.x, point.y)
            if (screen) {
              node.style.transform = 'translate3d(' + Math.round(screen[0]) + 'px,' + Math.round(screen[1]) + 'px,0)'
            }
          }

          node.style.opacity = '1'
          clearTimeout(hideTimer)
        }

        const idle = () => {
          if (!el) return
          clearTimeout(hideTimer)
          // Linger briefly so a fast op is still visible, then fade.
          hideTimer = setTimeout(() => { if (el) el.style.opacity = '0' }, 1400)
        }

        window[NS] = { place: place, idle: idle }
      })()
    </script>`

/** Handler body for protocol.handle(PEN_PROTOCOL, …). Serves the editor's
 *  static files out of Pen.app's asar; index.html gets the document's boot
 *  params injected as `window.PENCIL_INIT_PARAMS` (the same fallback global
 *  the editor reads in Pen's own VS Code webview host). */
export async function handlePenProtocolRequest(request: any, electronNet: any): Promise<any> {
  const rt = ensureRuntime()

  if (!rt) {
    return new Response('pen.dev is not installed', { status: 404 })
  }

  let url: URL

  try {
    url = new URL(request.url)
  } catch {
    return new Response('Bad request', { status: 400 })
  }

  const cleanPath = url.pathname.replace(/^\/+/, '')

  if (cleanPath === '' || cleanPath === 'index.html') {
    const docId = url.searchParams.get('doc') || ''
    const doc = documents.get(docId)

    if (!doc) {
      return new Response('Unknown canvas document', { status: 404 })
    }

    let html = await fs.promises.readFile(path.join(rt.install.editorRoot, 'index.html'), 'utf8')

    // Seed the repaint gate with the theme this editor BOOTS with, so the
    // first host theme flip toggles it exactly once (see repaintPenTheme).
    lastPenThemeKind = doc.device.getActiveThemeKind()

    const initParams = {
      fileURI: doc.fileURI,
      theme: lastPenThemeKind,
      connectedAgents: rt.deviceManager.getConnectedAgents(),
      isTemporary: doc.device.isTemporary(),
      // Pen's own host sends this (see ext-host.js: {fileURI, theme,
      // connectedAgents, isTemporary, isFirstLaunch, displayName,
      // hostVersion}) and it gates the first-run onboarding — the example
      // prompt chips. A hermes canvas is never pen's first launch: hermes is
      // the onboarding.
      isFirstLaunch: false,
      hostVersion: doc.device.getHostVersion(),
      displayName: describeDocument(doc).displayName
    }

    html = html.replace(
      '<script type="module"',
      [
        `<script>window.PENCIL_INIT_PARAMS = ${JSON.stringify(initParams)};</script>`,
        PEN_HOST_CHROME_STYLE,
        PEN_HOST_CHROME_TAGGER.replace('__HERMES_PEN_AGENT__', penAgentHidden ? 'hidden' : 'shown')
          .replace('__HERMES_PEN_BG__', penHostChrome.background)
          .replaceAll('__HERMES_PEN_THEME__', lastPenThemeKind || doc.device.getActiveThemeKind()),
        PEN_AGENT_CURSOR,
        '    <script type="module"'
      ].join('\n    ')
    )

    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
  }

  const targetFile = path.join(rt.install.editorRoot, cleanPath)

  // Never escape the editor root (asar paths still normalize).
  if (!targetFile.startsWith(rt.install.editorRoot)) {
    return new Response('Forbidden', { status: 403 })
  }

  return electronNet.fetch(pathToFileURL(targetFile).toString(), {
    bypassCustomProtocolHandlers: true
  })
}

// ---------------------------------------------------------------------------
// Status + doors for the renderer
// ---------------------------------------------------------------------------

export interface PenStatus {
  available: boolean
  loggedIn: boolean
  version: string
  running: boolean
  openDocuments: PenDocumentInfo[]
  /** pen.dev's own app icon as a data URL, read at RUNTIME from the user's
   *  installed Pen.app — never bundled (their asset, upstream wins). Null
   *  when pen isn't installed; consumers fall back to a house glyph. */
  icon: null | string
}

let penIconCache: null | string = null
let penIconPending: null | Promise<null | string> = null

/** pen.dev's app icon as a data URL, decoded by macOS from the user's
 *  installed Pen.app (app.getFileIcon). Cached forever after the first hit —
 *  the icon can't change without a pen update, which relaunches us anyway. */
export function penIconDataUrl(installPath: null | string | undefined): Promise<null | string> {
  if (penIconCache || !installPath) {
    return Promise.resolve(penIconCache)
  }

  if (!penIconPending) {
    penIconPending = (async () => {
      try {
        const { app: electronApp } = require('electron')
        const image = await electronApp.getFileIcon(installPath, { size: 'normal' })

        if (image && !image.isEmpty()) {
          penIconCache = image.toDataURL()
        }
      } catch {
        // Icon is decoration; never let it break status.
      }

      return penIconCache
    })()
  }

  return penIconPending
}

export function penStatus(): PenStatus {
  const install = runtime?.install ?? findPenInstallation()

  // Kick the async prime; the resolved value rides the NEXT status call.
  // hermes:pen:status in main awaits properly, so renderers see it on the
  // first call anyway — this sync path only serves in-process callers.
  void penIconDataUrl(install?.appPath)

  return {
    available: Boolean(install),
    loggedIn: penLoggedIn(),
    version: install?.version ?? '',
    running: Boolean(runtime),
    icon: penIconCache,
    openDocuments: [...documents.values()].map(describeDocument)
  }
}

export async function openPenCanvas(options: {
  name?: string
  path?: string
  template?: string
}): Promise<PenDocumentInfo> {
  if (options.path) {
    const resolved = path.resolve(options.path)

    return openDocumentByUri(pathToFileURL(resolved).href)
  }

  return createLibraryDocument(options.template || 'pencil-new.pen', options.name)
}

// ---------------------------------------------------------------------------
// Canvas library — browse / rename / delete the user's canvases.
// ---------------------------------------------------------------------------

export interface PenLibraryItem extends PenLibraryEntry {
  /** Open in the drawer right now (so the UI can show it as active and
   *  refuse to delete it out from under itself). */
  open: boolean
  /** The live document id, when open. */
  docId: null | string
}

export function penLibrary(): { items: PenLibraryItem[]; root: string } {
  const openByPath = new Map<string, string>()

  for (const doc of documents.values()) {
    try {
      openByPath.set(path.resolve(fileURLToPath(doc.fileURI)), doc.docId)
    } catch {
      // Non-file URI — can't collide with a library path.
    }
  }

  const items = listPenLibrary().map(entry => {
    const docId = openByPath.get(path.resolve(entry.path)) ?? null

    return { ...entry, docId, open: Boolean(docId) }
  })

  return { items, root: penLibraryRoot() }
}

/** Delete a canvas. Closes the live document first — deleting the file out
 *  from under an open editor is how you get a save that resurrects it. */
export function deletePenCanvas(target: string): boolean {
  const resolved = path.resolve(target)

  for (const doc of documents.values()) {
    try {
      if (path.resolve(fileURLToPath(doc.fileURI)) === resolved) {
        closeDocument(doc.docId)
        break
      }
    } catch {
      // Not a file URI.
    }
  }

  return deletePenFromLibrary(resolved)
}

/** Rename a canvas. Refuses while it's open, for the same reason as delete:
 *  the editor holds the old path and would write it back. */
export function renamePenCanvas(target: string, nextName: string): null | string {
  const resolved = path.resolve(target)

  for (const doc of documents.values()) {
    try {
      if (path.resolve(fileURLToPath(doc.fileURI)) === resolved) {
        return null
      }
    } catch {
      // Not a file URI.
    }
  }

  return renamePenInLibrary(resolved, nextName)
}

/** Canvas URL for a document — what the renderer webview loads. */
export function penCanvasUrl(docId: string): string {
  return `${PEN_PROTOCOL}://editor/index.html?doc=${encodeURIComponent(docId)}`
}

// ---------------------------------------------------------------------------
// Agent tool proxy — pen tools for the hermes agent.
//
// Rung 1: a canvas open in hermes → route through the focused document's IPC
//         (same wire the MCP server uses, minus the socket hop).
// Rung 2: no hermes canvas, but the user's Pen.app is running → dial ITS
//         socket (pencil-desktop.sock) as an MCP client. This is HUD mode:
//         hermes designs into the Pen window under the bar without ever
//         showing its own canvas.
// ---------------------------------------------------------------------------

interface PenToolResult {
  success: boolean
  result?: unknown
  error?: string
}

async function callFocusedCanvas(name: string, payload: Record<string, unknown>): Promise<PenToolResult | null> {
  const rt = runtime

  if (!rt || documents.size === 0) {
    return null
  }

  const { ipc } = rt.deviceManager.getFocusedResourceAndIPC()
  const target = ipc ?? [...documents.values()].find(doc => doc.ipc)?.ipc

  if (!target) {
    return null
  }

  try {
    const response: any = await target.request(name, payload)

    return {
      success: response?.success ?? true,
      result: response?.success ? response.result : undefined,
      error: response?.error
    }
  } catch (error: any) {
    return { success: false, error: error?.message || String(error) }
  }
}

/** node-ipc client for Pen's transport socket. Speaks the same framing
 *  @node-ipc/node-ipc uses: JSON messages `{type, data}` delimited by \f. */
function callPenAppSocket(name: string, payload: Record<string, unknown>, timeoutMs = 30000): Promise<PenToolResult | null> {
  const socketPath = path.join(os.homedir(), '.pencil', 'socket', 'pencil-desktop.sock')

  if (!fs.existsSync(socketPath)) {
    return Promise.resolve(null)
  }

  return new Promise(resolve => {
    const socket = net.createConnection(socketPath)
    let buffer = ''
    let clientId = ''
    const requestId = randomUUID()
    let settled = false

    const settle = (value: PenToolResult | null) => {
      if (!settled) {
        settled = true
        socket.destroy()
        resolve(value)
      }
    }

    const timer = setTimeout(() => settle({ success: false, error: 'pen.dev tool call timed out' }), timeoutMs)

    socket.on('error', () => {
      clearTimeout(timer)
      settle(null)
    })

    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')

      const frames = buffer.split('\f')

      buffer = frames.pop() ?? ''

      for (const frame of frames) {
        let message: any

        try {
          message = JSON.parse(frame)
        } catch {
          continue
        }

        if (message.type !== 'tool_response') {
          continue
        }

        const data = message.data

        if (data?.request_id === 'client-id-assignment') {
          clientId = data.client_id

          socket.write(
            `${JSON.stringify({ type: 'tool_request', data: { client_id: clientId, request_id: requestId, name, payload } })}\f`
          )

          continue
        }

        if (data?.request_id === requestId) {
          clearTimeout(timer)
          settle({ success: Boolean(data.success), result: data.result, error: data.error })
        }
      }
    })
  })
}

/** The agent door: run a pen tool against whatever canvas is live. */
/** Human phrasing for the cursor label, from pen's operation names. */
const PEN_OP_LABELS: Record<string, string> = {
  copy: 'Hermes is duplicating…',
  delete: 'Hermes is deleting…',
  execute: 'Hermes is designing…',
  'export-html': 'Hermes is exporting…',
  'export-nodes': 'Hermes is exporting…',
  'get-app-state': 'Hermes is looking…',
  'get-guidelines': 'Hermes is reading…',
  'get-screenshot': 'Hermes is looking…',
  insert: 'Hermes is adding…',
  move: 'Hermes is moving…',
  replace: 'Hermes is replacing…',
  update: 'Hermes is editing…'
}

/** The live canvas WebContents, via the guest id bindPenWebview recorded.
 *  Keeps presence inside this module instead of reaching into main's drawer
 *  state — the document registry already knows who is rendering it. */
function penCanvasWebContents(): any {
  const { webContents } = require('electron')

  for (const doc of documents.values()) {
    if (!doc.guestWebContentsId) {
      continue
    }

    const target = webContents.fromId(doc.guestWebContentsId)

    if (target && !target.isDestroyed()) {
      return target
    }
  }

  return null
}

/**
 * Show the agent cursor over whatever the operation just touched, and pan the
 * viewport to it.
 *
 * Both come from the editor's own state rather than anything we track: the
 * selection after an op IS what the op affected, so its world bounds place
 * the cursor, and pen's zoom-to-selection brings it on screen. Failure is
 * silent by design — presence is a nicety and must never break the edit.
 */
async function showPenAgentCursor(name: string, follow: boolean): Promise<void> {
  const view = penCanvasWebContents()

  if (!view) {
    return
  }

  const label = PEN_OP_LABELS[name] ?? 'Hermes is working…'

  try {
    await view.executeJavaScript(
      `(() => {
        const api = window.hermesPenCursor
        if (!api) return

        // Where is the selection? The editor owns this; we only read it.
        let point = null
        try {
          const app = window.pencilApp || window.app || null
          const sel = app && app.selectionManager
          const bounds = sel && (sel.selectionBoundsWorld || sel.getSelectionBounds?.())
          if (bounds) {
            point = { x: bounds.x ?? bounds.left ?? 0, y: bounds.y ?? bounds.top ?? 0 }
          }
        } catch {}

        api.place(${JSON.stringify(label)}, point)

        ${
          follow
            ? `try {
          const app = window.pencilApp || window.app || null
          if (app && typeof app.zoomToSelection === 'function') app.zoomToSelection()
          else if (app && app.viewport && typeof app.viewport.zoomToFit === 'function') app.viewport.zoomToFit()
        } catch {}`
            : ''
        }
      })()`,
      true
    )
  } catch {
    // Presence is cosmetic: never let it surface as a tool failure.
  }
}

/** Park the cursor once the operation settles. */
async function idlePenAgentCursor(): Promise<void> {
  const view = penCanvasWebContents()

  if (!view) {
    return
  }

  try {
    await view.executeJavaScript(`window.hermesPenCursor && window.hermesPenCursor.idle()`, true)
  } catch {
    // Cosmetic.
  }
}

export async function runPenTool(name: string, payload: Record<string, unknown>): Promise<PenToolResult> {
  // Editor-side handlers are kebab-case (get-app-state); the agent tool layer
  // speaks pen's MCP names (get_app_state). Normalize once for both rungs —
  // the transport router passes names through verbatim.
  name = name.replaceAll('_', '-')

  // Presence BEFORE the op, so the cursor is already there when nodes start
  // appearing rather than catching up afterwards.
  void showPenAgentCursor(name, false)

  const fromCanvas = await callFocusedCanvas(name, payload)

  if (fromCanvas) {
    // Writes move the selection, so re-place the cursor and follow it — that's
    // the auto-pan. Reads don't move anything, so they don't yank the view.
    const write = !name.startsWith('get-') && !name.startsWith('export-')

    void showPenAgentCursor(name, write).then(idlePenAgentCursor)

    return fromCanvas
  }

  const fromPenApp = await callPenAppSocket(name, payload)

  if (fromPenApp) {
    return fromPenApp
  }

  void idlePenAgentCursor()

  return {
    success: false,
    error:
      'No pen.dev canvas is available — open a Canvas tab in Hermes, or open a document in the pen.dev desktop app.'
  }
}
