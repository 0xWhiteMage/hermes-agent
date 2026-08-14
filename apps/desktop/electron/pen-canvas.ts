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
  findPenInstallation,
  PEN_SOCKET_APP_NAME,
  type PenInstallation,
  penLoggedIn,
  penSessionFilePath,
  penTemporaryDocumentsRoot,
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
        const info = await createTemporaryDocument(name)
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

async function createTemporaryDocument(templateName = 'pencil-new.pen'): Promise<PenDocumentInfo> {
  const rt = ensureRuntime()

  if (!rt) {
    throw new Error('pen.dev is not installed')
  }

  if (!templateName.endsWith('.pen')) {
    templateName = `pencil-${templateName}.pen`
  }

  const templatePath = path.join(rt.install.templatesRoot, templateName)
  const documentFolder = path.join(penTemporaryDocumentsRoot(), randomUUID())

  await fs.promises.mkdir(documentFolder, { recursive: true })

  const newFilePath = path.join(documentFolder, templateName)

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
  })

  device.on('file-changed', (uri: string) => {
    doc.ipc?.notify('file-changed', uri)
  })

  return describeDocument(doc)
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

export function closeDocument(docId: string): void {
  const doc = documents.get(docId)

  if (!doc) {
    return
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
    void createTemporaryDocument('pencil-new.pen')
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

    const initParams = {
      fileURI: doc.fileURI,
      theme: doc.device.getActiveThemeKind(),
      connectedAgents: rt.deviceManager.getConnectedAgents(),
      isTemporary: doc.device.isTemporary(),
      hostVersion: doc.device.getHostVersion(),
      displayName: describeDocument(doc).displayName
    }

    html = html.replace(
      '<script type="module"',
      `<script>window.PENCIL_INIT_PARAMS = ${JSON.stringify(initParams)};</script>\n    <script type="module"`
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
}

export function penStatus(): PenStatus {
  const install = runtime?.install ?? findPenInstallation()

  return {
    available: Boolean(install),
    loggedIn: penLoggedIn(),
    version: install?.version ?? '',
    running: Boolean(runtime),
    openDocuments: [...documents.values()].map(describeDocument)
  }
}

export async function openPenCanvas(options: { path?: string; template?: string }): Promise<PenDocumentInfo> {
  if (options.path) {
    const resolved = path.resolve(options.path)

    return openDocumentByUri(pathToFileURL(resolved).href)
  }

  return createTemporaryDocument(options.template || 'pencil-new.pen')
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
export async function runPenTool(name: string, payload: Record<string, unknown>): Promise<PenToolResult> {
  // Editor-side handlers are kebab-case (get-app-state); the agent tool layer
  // speaks pen's MCP names (get_app_state). Normalize once for both rungs —
  // the transport router passes names through verbatim.
  name = name.replaceAll('_', '-')

  const fromCanvas = await callFocusedCanvas(name, payload)

  if (fromCanvas) {
    return fromCanvas
  }

  const fromPenApp = await callPenAppSocket(name, payload)

  if (fromPenApp) {
    return fromPenApp
  }

  return {
    success: false,
    error:
      'No pen.dev canvas is available — open a Canvas tab in Hermes, or open a document in the pen.dev desktop app.'
  }
}
