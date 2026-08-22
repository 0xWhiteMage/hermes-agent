import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'vitest'

import { auditTree } from '../scripts/audit-bundle-arch.mjs'
import { prunePayloadForeignPlatformLibs } from '../scripts/stage-agent-payloads.mjs'

// ─── prunePayloadForeignPlatformLibs ───────────────────────────────
//
// pvporcupine and discord.py publish py3-none-any wheels that bundle
// EVERY platform's native libraries, so pip installs Windows DLLs and
// Raspberry Pi .so files into a Linux payload. That failed the bundle
// arch audit with 16 mismatches per Linux lane.
//
// These tests build the real wheel layout with real executable headers
// and then run the REAL auditTree over the pruned tree. Asserting "the
// audit passes" is the actual contract; asserting a list of deleted
// filenames would just restate the implementation.

function elf(machine) {
  const buf = Buffer.alloc(64)
  buf.write('\x7fELF', 0, 'latin1')
  buf.writeUInt16LE(machine, 18)
  return buf
}

function macho(cputype) {
  const buf = Buffer.alloc(64)
  buf.writeUInt32BE(0xfeedfacf, 0)
  buf.writeUInt32BE(cputype, 4)
  return buf
}

function pe(machine) {
  // MZ stub pointing at a PE header at 0x40.
  const buf = Buffer.alloc(0x40 + 8)
  buf.write('MZ', 0, 'latin1')
  buf.writeUInt32LE(0x40, 0x3c)
  buf.write('PE\0\0', 0x40, 'latin1')
  buf.writeUInt16LE(machine, 0x44)
  return buf
}

const ELF_X64 = 0x3e
const ELF_ARM64 = 0xb7
const ELF_ARM = 0x28
const MACHO_X64 = 0x01000007
const MACHO_ARM64 = 0x0100000c
const PE_X64 = 0x8664
const PE_ARM64 = 0xaa64
const PE_IA32 = 0x014c

function write(root, rel, bytes) {
  const full = path.join(root, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, bytes)
}

/** The site-packages layout as the real wheels install it, everywhere. */
function mkPayload() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-foreign-'))
  // Nest under resources/agent-payload: the audit's exemption patterns are
  // anchored at that segment, so a flat fixture would silently bypass them.
  const out = path.join(root, 'resources', 'agent-payload')
  fs.mkdirSync(out, { recursive: true })
  const sp = 'site-packages'

  // pvporcupine: one dir per supported platform, all present on every host.
  const pv = `${sp}/pvporcupine/lib`
  write(out, `${pv}/linux/x86_64/libpv_porcupine.so`, elf(ELF_X64))
  write(out, `${pv}/mac/x86_64/libpv_porcupine.dylib`, macho(MACHO_X64))
  write(out, `${pv}/mac/arm64/libpv_porcupine.dylib`, macho(MACHO_ARM64))
  write(out, `${pv}/windows/amd64/libpv_porcupine.dll`, pe(PE_X64))
  write(out, `${pv}/windows/arm64/libpv_porcupine.dll`, pe(PE_ARM64))
  for (const cortex of ['arm11', 'cortex-a53', 'cortex-a72', 'cortex-a76']) {
    write(out, `${pv}/raspberry-pi/${cortex}/libpv_porcupine.so`, elf(ELF_ARM))
  }
  for (const cortex of ['cortex-a53', 'cortex-a72', 'cortex-a76']) {
    write(out, `${pv}/raspberry-pi/${cortex}-aarch64/libpv_porcupine.so`, elf(ELF_ARM64))
  }
  // Platform-neutral model data the loader always reads. Never a victim.
  write(out, `${pv}/common/porcupine_params.pv`, Buffer.alloc(32, 0x61))

  // discord.py: Windows-only opus DLLs, loaded only under sys.platform win32.
  write(out, `${sp}/discord/bin/libopus-0.x64.dll`, pe(PE_X64))
  write(out, `${sp}/discord/bin/libopus-0.x86.dll`, pe(PE_IA32))
  write(out, `${sp}/discord/bin/COPYING`, Buffer.from('license text'))

  // setuptools: Windows console-script launcher stub templates.
  for (const [name, machine] of [
    ['cli.exe', PE_IA32],
    ['cli-32.exe', PE_IA32],
    ['cli-64.exe', PE_X64],
    ['cli-arm64.exe', PE_ARM64],
    ['gui.exe', PE_IA32],
    ['gui-32.exe', PE_IA32],
    ['gui-64.exe', PE_X64],
    ['gui-arm64.exe', PE_ARM64],
  ]) {
    write(out, `${sp}/setuptools/${name}`, pe(machine))
  }
  write(out, `${sp}/setuptools/__init__.py`, Buffer.from('# python'))

  // `root` is what the audit scans (relative paths then include the
  // resources/agent-payload prefix its exemptions key off); `out` is what
  // the pruner is handed, exactly as stage-agent-payloads passes OUT_DIR.
  return { root, out }
}

const TARGETS = [
  { platform: 'linux', arch: 'x64' },
  { platform: 'linux', arch: 'arm64' },
  { platform: 'darwin', arch: 'x64' },
  { platform: 'darwin', arch: 'arm64' },
  { platform: 'win32', arch: 'x64' },
  { platform: 'win32', arch: 'arm64' },
]

test.each(TARGETS)('pruning leaves an arch-clean payload for $platform-$arch', (target) => {
  const { root, out } = mkPayload()
  try {
    const before = auditTree(root, target.arch)
    assert.ok(before.mismatches.length > 0, 'fixture must start dirty or it proves nothing')

    prunePayloadForeignPlatformLibs(out, target)

    const after = auditTree(root, target.arch)
    assert.deepEqual(
      after.mismatches.map((m) => m.file),
      [],
      `foreign-arch binaries survived for ${target.platform}-${target.arch}`
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the library each platform actually loads survives', () => {
  // Read off pvporcupine/_util.py::pv_library_path. Getting this wrong
  // deletes a library the app needs and only fails at runtime.
  const expected = [
    [{ platform: 'linux', arch: 'x64' }, 'linux/x86_64'],
    [{ platform: 'darwin', arch: 'x64' }, 'mac/x86_64'],
    [{ platform: 'darwin', arch: 'arm64' }, 'mac/arm64'],
    [{ platform: 'win32', arch: 'x64' }, 'windows/amd64'],
    [{ platform: 'win32', arch: 'arm64' }, 'windows/arm64'],
  ]
  for (const [target, rel] of expected) {
    const { root, out } = mkPayload()
    try {
      prunePayloadForeignPlatformLibs(out, target)
      const lib = path.join(out, 'site-packages/pvporcupine/lib', rel)
      assert.ok(fs.existsSync(lib), `${target.platform}-${target.arch} lost ${rel}`)
      // The model file is platform-neutral and must never be pruned.
      assert.ok(fs.existsSync(path.join(out, 'site-packages/pvporcupine/lib/common/porcupine_params.pv')))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
})

test('linux-arm64 keeps every aarch64 cortex variant', () => {
  // pvporcupine picks the cortex from /proc/cpuinfo on the USER's machine,
  // so a build-time prune cannot narrow this to one directory. It must
  // also not keep `linux/`, which is x86_64-only despite the name.
  const { root, out } = mkPayload()
  try {
    prunePayloadForeignPlatformLibs(out, { platform: 'linux', arch: 'arm64' })
    const pv = path.join(out, 'site-packages/pvporcupine/lib')
    for (const cortex of ['cortex-a53', 'cortex-a72', 'cortex-a76']) {
      assert.ok(
        fs.existsSync(path.join(pv, 'raspberry-pi', `${cortex}-aarch64`)),
        `${cortex}-aarch64 is chosen at runtime from /proc/cpuinfo and must survive`
      )
    }
    assert.ok(!fs.existsSync(path.join(pv, 'linux')), 'lib/linux is x86_64-only')
    assert.ok(!fs.existsSync(path.join(pv, 'raspberry-pi', 'cortex-a53')), '32-bit variant is unreachable')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('opus survives only on Windows, where the loader reads it', () => {
  // discord/opus.py::_load_default touches bin/ only under win32; POSIX
  // goes to ctypes.util.find_library('opus').
  for (const target of TARGETS) {
    const { root, out } = mkPayload()
    try {
      prunePayloadForeignPlatformLibs(out, target)
      const x64 = path.join(out, 'site-packages/discord/bin/libopus-0.x64.dll')
      const x86 = path.join(out, 'site-packages/discord/bin/libopus-0.x86.dll')
      assert.equal(
        fs.existsSync(x64),
        target.platform === 'win32',
        `x64 opus presence wrong for ${target.platform}-${target.arch}`
      )
      // The 32-bit DLL is unreachable everywhere: the payload interpreter
      // is always 64-bit, so discord's bitness test never selects x86.
      assert.ok(!fs.existsSync(x86), 'x86 opus is never loadable')
      // Non-binary package data is not the pruner's business.
      assert.ok(fs.existsSync(path.join(out, 'site-packages/discord/bin/COPYING')))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
})

test('setuptools keeps the launcher stubs its host would stamp', () => {
  // get_win_launcher picks by host platform when writing a console script.
  const cases = [
    [{ platform: 'win32', arch: 'x64' }, ['cli-64.exe', 'gui-64.exe']],
    [{ platform: 'win32', arch: 'arm64' }, ['cli-arm64.exe', 'gui-arm64.exe']],
    [{ platform: 'linux', arch: 'x64' }, []],
    [{ platform: 'darwin', arch: 'arm64' }, []],
  ]
  for (const [target, survivors] of cases) {
    const { root, out } = mkPayload()
    try {
      prunePayloadForeignPlatformLibs(out, target)
      const dir = path.join(out, 'site-packages/setuptools')
      const left = fs.readdirSync(dir).filter((f) => f.endsWith('.exe')).sort()
      assert.deepEqual(left, [...survivors].sort(), `${target.platform}-${target.arch}`)
      // Python sources are untouched.
      assert.ok(fs.existsSync(path.join(dir, '__init__.py')))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
})

test('a payload without these packages is a no-op, not a crash', () => {
  // Not every payload installs the wake-word or discord extras.
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-foreign-empty-'))
  try {
    fs.mkdirSync(path.join(out, 'site-packages'), { recursive: true })
    assert.equal(prunePayloadForeignPlatformLibs(out, { platform: 'linux', arch: 'x64' }), 0)
  } finally {
    fs.rmSync(out, { recursive: true, force: true })
  }
})
