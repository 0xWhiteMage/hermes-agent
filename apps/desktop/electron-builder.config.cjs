// THE electron-builder configuration — the whole thing, one file. There is
// no "build" field in package.json: run-electron-builder.mjs always passes
// --config for this file, so a stray package.json field would be silently
// ignored anyway, and splitting the config across JSON + this overlay is
// how the two halves drift.
//
// A .cjs module (not JSON) for two reasons:
//   * mac.sign.ignore must be a FUNCTION. osx-sign's walk selects files to
//     sign with a generic binary-content probe, which flags plain binary
//     resources (the payload CPython's idlelib GIFs, wheels, .zip) as
//     signable. Signing those is wrong (non-Mach-O resources are covered
//     by the bundle's CodeResources seal) and each bogus signing hits
//     Apple's timestamp service — thousands of payload files flooded it
//     until it refused ("The timestamp service is not available"). The
//     function scopes signing to real Mach-O files.
//   * the variant is decided at require time: HERMES_DESKTOP_VARIANT=light
//     builds "Hermes Light", the remote-only client with no agent payload
//     and no local backend. The whole config derives from the one `light`
//     flag below — a separate app to the OS and to the updater, so both
//     variants install and update side by side.
// @ts-check — typed via JSDoc against app-builder-lib's own declarations;
// enforced by the checkJs pass in npm run typecheck.
'use strict'

const fs = require('node:fs')
const path = require('node:path')

/** @typedef {import("app-builder-lib").Configuration} Configuration */

const light = process.env.HERMES_DESKTOP_VARIANT === 'light'

// master product id, used for all sorts of markers
const variant = light ? ['Hermes', 'Light'] : ['Hermes']
// variant in various cases
const name = {
  display: variant.join(' '),
  kebab: variant.join('-').toLowerCase(),
  train: variant.join('-'),
  pascal: variant.join('')
}

// distinct for the OS (settings, installs, etc)
const appId = `com.nousresearch.${name.kebab}`

// distinct for release channels
const channel = light ? 'light' : 'latest'

// distinct for deep link schemes
const protocolScheme = name.kebab

/** @type {Configuration} */
module.exports = {
  electronVersion: '40.10.2',
  appId,
  productName: name.display,
  executableName: name.display,
  protocols: [
    {
      name: `${name.display} Protocol`,
      schemes: [protocolScheme]
    }
  ],
  // separate variants for release filenames
  artifactName: `${name.train}-\${version}-\${os}-\${arch}.\${ext}`,
  icon: 'assets/icon',
  publish: [
    {
      provider: 'github',
      owner: 'NousResearch',
      repo: 'hermes-agent',
      channel
    }
  ],
  extraMetadata: {
    // separate variants for electron-updater download cache dirs
    name: name.kebab
  },
  directories: {
    output: 'release'
  },
  files: ['dist/**', 'assets/**', 'public/**', 'package.json'],
  beforeBuild: 'scripts/before-build.mjs',
  beforePack: 'scripts/before-pack.mjs',
  afterPack: 'scripts/after-pack.mjs',
  extraResources: [
    {
      from: 'build/agent-payload',
      to: 'agent-payload'
    },
    {
      from: 'assets/icon.ico',
      to: 'icon.ico'
    }
  ],
  asar: {
    unpack: ['**/*.node', '**/prebuilds/**', 'dist/**']
  },
  mac: {
    category: 'public.app-category.developer-tools',
    extendInfo: {
      CFBundleDisplayName: name.display,
      CFBundleExecutable: name.display,
      CFBundleName: name.display,
      NSAudioCaptureUsageDescription: `${name.display} uses audio capture for voice conversations.`,
      NSCameraUsageDescription: `${name.display} uses the camera when a plugin or feature you enable requests it.`,
      NSMicrophoneUsageDescription: `${name.display} uses the microphone for voice input and voice conversations.`
    },
    target: ['dmg', 'zip'],
    sign: {
      entitlements: 'electron/entitlements.mac.plist',
      entitlementsInherit: 'electron/entitlements.mac.inherit.plist',
      hardenedRuntime: true,
      // (gatekeeperAssess is gone: osx-sign v3 dropped the --gatekeeper-assess
      // pass entirely, and the v27 ElectronSignOptions type rejects the key.)
      // true → skip. Directories pass through (the walk hands over .app and
      // .framework bundles, which codesign must see whole); every regular
      // file must prove it is Mach-O to be signed individually.
      ignore: (/** @type {string} */ file) => {
        try {
          if (fs.lstatSync(file).isDirectory()) {
            return false
          }
          return !isMachO(file)
        } catch {
          // Unreadable/vanished: nothing to sign either way.
          return true
        }
      }
    }
  },
  dmg: {
    title: `Install ${name.display}`,
    backgroundColor: '#f5f5f7',
    iconSize: 96,
    window: {
      width: 560,
      height: 360
    },
    contents: [
      {
        x: 160,
        y: 170,
        type: 'file'
      },
      {
        x: 400,
        y: 170,
        type: 'link',
        path: '/Applications'
      }
    ]
  },
  win: {
    legalTrademarks: name.display,
    target: ['nsis', 'msix'],
    ...windowsSigning()
  },
  // MSIX ships beside NSIS: the exe keeps electron-updater and normal
  // distribution; the MSIX exists for Store/sideload installs and for the
  // Windows Copilot hardware key.
  // electron-updater does not update MSIX installs.
  msix: {
    identityName: `NousResearch.${name.pascal}`,
    applicationId: name.pascal,
    displayName: name.display,
    publisher: 'CN=Nous Research Inc., O=Nous Research Inc., L=Austin, S=Texas, C=US',
    publisherDisplayName: 'Nous Research',
    customManifestPath: msixManifestTemplatePath(),
    customExtensionsPath: copilotKeyFragmentPath()
  },
  linux: {
    category: 'Development',
    maintainer: 'Nous Research <support@nousresearch.com>',
    synopsis: light ? 'Remote-only desktop client for Hermes Agent.' : 'Native desktop shell for Hermes Agent.',
    target: ['AppImage']
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    installerIcon: 'assets/icon.ico',
    uninstallerIcon: 'assets/icon.ico',
    installerHeaderIcon: 'assets/icon.ico',
    shortcutName: name.display,
    uninstallDisplayName: name.display,
    warningsAsErrors: false
  }
}

// ── copilot key provider fragment + manifest template ───────────────────────

// The uap3:AppExtension fragment that registers the app as a Windows
// Copilot hardware key provider.
// The press activates <scheme>://copilot-key/start.
//
// Namespace rules (each violation is an opaque makeappx 0x80080204):
//   * uap3 is NOT declared here — manifest namespaces belong on the root
//     <Package> element, which is why msixManifestTemplatePath ships a
//     template with uap3 added at the root. A mid-document declaration
//     passes plain XSD validation but not makeappx.
//   * children of uap3:Properties are UNPREFIXED (xs:any content, per
//     Microsoft's copilot-key-state sample).
function copilotKeyFragmentPath() {
  const fragment = `<uap3:Extension Category="windows.appExtension">
  <uap3:AppExtension
      Name="com.microsoft.windows.copilotkeyprovider"
      Id="${name.pascal}CopilotKeyProvider"
      DisplayName="${name.display}"
      Description="Launch ${name.display} with the Copilot key"
      PublicFolder="Public">
    <uap3:Properties>
      <SingleTap>${protocolScheme}://copilot-key/start?state=Tap</SingleTap>
      <PressAndHoldStart>${protocolScheme}://copilot-key/start?state=Down</PressAndHoldStart>
      <PressAndHoldStop>${protocolScheme}://copilot-key/stop?state=Up</PressAndHoldStop>
    </uap3:Properties>
  </uap3:AppExtension>
</uap3:Extension>
`
  const rel = path.join('build', 'msix-copilot-key-extensions.xml')
  const abs = path.join(__dirname, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, fragment)
  return rel
}

// The manifest template for MsixTarget.writeManifest: the STOCK template
// from the installed app-builder-lib with xmlns:uap3 injected into the
// root <Package> element, so the fragment's uap3 prefix resolves from the
// root (see the namespace rule above). Deriving from the installed
// template at require time keeps us tracking upstream template changes
// instead of pinning a stale copy; ${...} macro substitution applies to a
// custom manifest identically.
function msixManifestTemplatePath() {
  // app-builder-lib's exports map blocks require.resolve of any file path
  // (even ./package.json); resolve the entry module and walk up to the
  // package root — same pattern as scripts/run-electron-builder.mjs.
  let libRoot = path.dirname(require.resolve('app-builder-lib'))
  while (!fs.existsSync(path.join(libRoot, 'package.json'))) {
    const parent = path.dirname(libRoot)
    if (parent === libRoot) {
      throw new Error('app-builder-lib package root not found')
    }
    libRoot = parent
  }
  const stock = path.join(libRoot, 'templates', 'msix', 'appxmanifest.xml')
  const template = fs.readFileSync(stock, 'utf8')
  if (template.includes('xmlns:uap3=')) {
    throw new Error('stock msix template now declares uap3 itself — drop msixManifestTemplatePath')
  }
  const marker = 'xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"'
  if (!template.includes(marker)) {
    throw new Error('stock msix template changed shape — cannot inject the uap3 namespace')
  }
  const patched = template.replace(
    marker,
    `${marker}\n   xmlns:uap3="http://schemas.microsoft.com/appx/manifest/uap/windows10/3"`
  )
  const rel = path.join('build', 'msix-appxmanifest.xml')
  const abs = path.join(__dirname, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, patched)
  return rel
}

// ── windows signing ─────────────────────────────────────────────────────────

// Azure Trusted Signing. Composed here, not as -c.win.sign.* CLI arguments:
// the publisherName holds spaces and commas that do not survive cmd.exe
// argument hops. This file loads inside the electron-builder process, so
// the values pass from the environment verbatim.
//
// Do NOT put ExcludeCredentials in additionalMetadata: the v27 schema
// types it Record<string,string> while the dlib deserializes it as
// List<string> — no value satisfies both. The credential chain is
// narrowed with the AZURE_TOKEN_CREDENTIALS env var instead (set in the
// release workflow), which Azure.Identity reads directly.
function windowsSigning() {
  if (!process.env.AZURE_SIGN_ENDPOINT || !process.env.AZURE_CLIENT_ID) {
    return {}
  }
  return {
    sign: {
      type: 'azure',
      endpoint: process.env.AZURE_SIGN_ENDPOINT,
      codeSigningAccountName: process.env.AZURE_SIGN_ACCOUNT,
      certificateProfileName: process.env.AZURE_SIGN_PROFILE,
      publisherName: process.env.AZURE_SIGN_PUBLISHER
    }
  }
}

// ── mac signing scope ───────────────────────────────────────────────────────

// The four magics that open a Mach-O or universal (fat) binary, in both
// byte orders: MH_MAGIC(_64) and FAT_MAGIC read big-endian at offset 0.
const MACHO_MAGICS = new Set([
  0xfeedface, // MH_MAGIC (32-bit)
  0xcefaedfe, // MH_CIGAM
  0xfeedfacf, // MH_MAGIC_64
  0xcffaedfe, // MH_CIGAM_64
  0xcafebabe, // FAT_MAGIC (universal)
  0xbebafeca // FAT_CIGAM
])

/** @param {string} file */
function isMachO(file) {
  const buf = Buffer.alloc(4)
  const fd = fs.openSync(file, 'r')
  try {
    if (fs.readSync(fd, buf, 0, 4, 0) !== 4) {
      return false
    }
  } finally {
    fs.closeSync(fd)
  }
  return MACHO_MAGICS.has(buf.readUInt32BE(0))
}
