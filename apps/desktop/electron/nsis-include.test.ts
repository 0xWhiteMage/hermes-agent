// Compiles apps/desktop/electron/nsis-include.nsh with the SAME makensis
// electron-builder uses, so a broken installer script fails here instead of
// three minutes into the Windows release lane.
//
// This is a real compile, not a source-text assertion: it resolves the NSIS
// toolset through app-builder-lib (the identical download + cache the build
// uses), splices our macros into a harness the way NsisTarget splices them
// into its generated script, and runs the compiler.
//
// It exists because of a build break where the include called EnVar::SetHKCU.
// EnVar is the usual answer for editing PATH from NSIS, but electron-builder
// ships no EnVar.dll in either bundle, so the macro could never compile —
// and nothing caught it until a tagged Windows build failed. The guard is
// the compile itself: any plugin the toolset does not carry is a hard
// "Plugin not found" error here.
//
// The compile is skipped (not failed) when the toolset cannot be fetched, so
// an offline checkout still runs the suite.

import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { beforeAll, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const electronDir: string = path.dirname(fileURLToPath(import.meta.url))
const includePath: string = path.join(electronDir, 'nsis-include.nsh')

interface MakensisTool {
  path: string
  env?: Record<string, string>
}

interface NsisToolset {
  getMakeNsisPath: (nsis: unknown, resourcesDir: string) => Promise<MakensisTool>
}

// app-builder-lib's "exports" map does not publish the toolsets subpath, so
// resolve it relative to the package entry rather than by subpath specifier.
// A failure here is a broken test, not a broken environment: it must throw
// rather than turn into a skip, or this guard silently stops guarding.
function loadNsisToolset(): NsisToolset {
  const entry: string = require.resolve('app-builder-lib')

  return require(path.join(path.dirname(entry), 'toolsets', 'nsis.js')) as NsisToolset
}

// The harness stands in for app-builder-lib's generated installer script: it
// inserts customInit into .onInit, customInstall into the install section and
// customUnInstall into the uninstall section, which is the only contract our
// include has with the generator.
const HARNESS = `Unicode true
Name "HermesNsisIncludeCompileCheck"
OutFile "harness.exe"
InstallDir "$TEMP\\HermesNsisIncludeCompileCheck"
RequestExecutionLevel user

!include "nsis-include.nsh"

Page instfiles
UninstPage instfiles

Section "Install"
  !insertmacro customInstall
SectionEnd

Section "Uninstall"
  !insertmacro customUnInstall
SectionEnd

Function .onInit
  !insertmacro customInit
FunctionEnd
`

async function resolveMakensis(): Promise<MakensisTool | null> {
  const toolset: NsisToolset = loadNsisToolset()

  try {
    return await toolset.getMakeNsisPath(undefined, electronDir)
  } catch (error) {
    // Only a fetch/unpack failure earns a skip, so an offline checkout still
    // runs the suite. Anything else is a real regression and must surface.
    const message: string = error instanceof Error ? error.message : String(error)

    if (/network|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|socket|download|getaddrinfo|403|404|502|503/i.test(message)) {
      return null
    }

    throw error
  }
}

async function compile(
  makensis: MakensisTool,
  workDir: string,
  defines: string[]
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(makensis.path, [...defines, 'harness.nsi'], {
      cwd: workDir,
      env: { ...process.env, ...(makensis.env ?? {}) },
      maxBuffer: 16 * 1024 * 1024
    })

    return { stdout, stderr, code: 0 }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number }

    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', code: failure.code ?? 1 }
  }
}

describe('nsis-include.nsh compiles with the electron-builder NSIS toolset', () => {
  let makensis: MakensisTool | null = null
  let workDir = ''

  beforeAll(async () => {
    // Downloading and unpacking the toolset on a cold cache dominates this.
    makensis = await resolveMakensis()
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-nsis-'))
    await fs.copyFile(includePath, path.join(workDir, 'nsis-include.nsh'))
    await fs.writeFile(path.join(workDir, 'harness.nsi'), HARNESS, 'utf8')
  }, 600_000)

  // Both single-arch shapes: each one takes a different branch of the arch
  // guard, and only a compile exercises the branch that is not taken.
  for (const [label, defines] of [
    ['x64', ['-DAPP_64']],
    ['arm64', ['-DAPP_ARM64']],
    ['multi-arch', ['-DAPP_64', '-DAPP_ARM64']]
  ] as const) {
    it(`compiles for ${label}`, async ({ skip }) => {
      if (makensis == null) {
        skip()

        return
      }

      const result = await compile(makensis, workDir, [...defines])
      const output = `${result.stdout}\n${result.stderr}`

      // A missing plugin is the specific failure this test was written for,
      // and makensis reports it in the body rather than only via exit code.
      expect(output).not.toMatch(/Plugin not found/i)
      expect(output, `makensis failed:\n${output}`).not.toMatch(/aborting creation process/i)
      expect(result.code).toBe(0)
    }, 300_000)
  }

  it('edits PATH without depending on an NSIS plugin', async () => {
    const source: string = await fs.readFile(includePath, 'utf8')

    // Plugin calls are `Name::Method` at statement position. System is the
    // one plugin electron-builder's bundle is guaranteed to carry (advapi32
    // is named inside a System::Call string, not called as a plugin), so
    // anything else appearing here is the EnVar failure mode returning.
    const pluginCalls: string[] = [...source.matchAll(/^\s*([A-Za-z_]\w*)::/gm)].map(match => match[1])

    expect(pluginCalls.length).toBeGreaterThan(0)
    expect([...new Set(pluginCalls)]).toEqual(['System'])
  })
})
