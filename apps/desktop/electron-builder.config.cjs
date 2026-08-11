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
"use strict"

const fs = require("node:fs")

/** @typedef {import("app-builder-lib").Configuration} Configuration */

// ── the one variant switch ──────────────────────────────────────────────────

const light = process.env.HERMES_DESKTOP_VARIANT === "light"

// Product identity, derived once. Every name-shaped string below comes from
// these; nothing else may hardcode "Hermes" / "Hermes Light".
const productName = light ? "Hermes Light" : "Hermes"
// appId separates the two apps for the OS (side-by-side installs, own
// settings); pkgName separates them for electron-updater, whose cache dir
// derives from the packaged package.json name (appInfo.updaterCacheDirName
// = sanitized name + '-updater') — with a shared name both apps stage
// downloads in the same <cache>/hermes-updater dir and can install each
// other's artifacts. artifactPrefix keys the release file names, and
// channel: 'light' → the light*.yml feed, so both variants share one
// GitHub release without colliding feed files. A packaged light app
// follows its own channel automatically: electron-builder writes it into
// app-update.yml at package time.
const appId = light ? "com.nousresearch.hermes-light" : "com.nousresearch.hermes"
const pkgName = light ? "hermes-light" : "hermes"
const artifactPrefix = light ? "Hermes-Light" : "Hermes"
const channel = light ? "light" : undefined

// ── mac signing scope ───────────────────────────────────────────────────────

// The four magics that open a Mach-O or universal (fat) binary, in both
// byte orders: MH_MAGIC(_64) and FAT_MAGIC read big-endian at offset 0.
const MACHO_MAGICS = new Set([
  0xfeedface, // MH_MAGIC (32-bit)
  0xcefaedfe, // MH_CIGAM
  0xfeedfacf, // MH_MAGIC_64
  0xcffaedfe, // MH_CIGAM_64
  0xcafebabe, // FAT_MAGIC (universal)
  0xbebafeca, // FAT_CIGAM
])

/** @param {string} file */
function isMachO(file) {
  const buf = Buffer.alloc(4)
  const fd = fs.openSync(file, "r")
  try {
    if (fs.readSync(fd, buf, 0, 4, 0) !== 4) {
      return false
    }
  } finally {
    fs.closeSync(fd)
  }
  return MACHO_MAGICS.has(buf.readUInt32BE(0))
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
      type: "azure",
      endpoint: process.env.AZURE_SIGN_ENDPOINT,
      codeSigningAccountName: process.env.AZURE_SIGN_ACCOUNT,
      certificateProfileName: process.env.AZURE_SIGN_PROFILE,
      publisherName: process.env.AZURE_SIGN_PUBLISHER,
    },
  }
}

// ── the configuration ───────────────────────────────────────────────────────

/** @type {Configuration} */
module.exports = {
  electronVersion: "40.10.2",
  appId,
  productName,
  executableName: productName,
  protocols: [
    {
      name: "Hermes Protocol",
      schemes: ["hermes"],
    },
  ],
  artifactName: `${artifactPrefix}-\${version}-\${os}-\${arch}.\${ext}`,
  icon: "assets/icon",
  publish: [
    {
      provider: "github",
      owner: "NousResearch",
      repo: "hermes-agent",
      // channel omitted for the full app → the default latest*.yml feed.
      ...(channel ? { channel } : {}),
    },
  ],
  // The packaged package.json 'name' — see pkgName above. Everything else
  // runtime keys on productName/appId.
  extraMetadata: { name: pkgName },
  directories: {
    output: "release",
  },
  files: ["dist/**", "assets/**", "public/**", "package.json"],
  beforeBuild: "scripts/before-build.mjs",
  beforePack: "scripts/before-pack.mjs",
  afterPack: "scripts/after-pack.mjs",
  extraResources: [
    {
      from: "build/agent-payload",
      to: "agent-payload",
    },
    {
      from: "assets/icon.ico",
      to: "icon.ico",
    },
  ],
  asar: {
    unpack: ["**/*.node", "**/prebuilds/**", "dist/**"],
  },
  mac: {
    category: "public.app-category.developer-tools",
    extendInfo: {
      CFBundleDisplayName: productName,
      CFBundleExecutable: productName,
      CFBundleName: productName,
      NSAudioCaptureUsageDescription: `${productName} uses audio capture for voice conversations.`,
      NSCameraUsageDescription: `${productName} uses the camera when a plugin or feature you enable requests it.`,
      NSMicrophoneUsageDescription: `${productName} uses the microphone for voice input and voice conversations.`,
    },
    target: ["dmg", "zip"],
    sign: {
      entitlements: "electron/entitlements.mac.plist",
      entitlementsInherit: "electron/entitlements.mac.inherit.plist",
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
      },
    },
  },
  dmg: {
    title: `Install ${productName}`,
    backgroundColor: "#f5f5f7",
    iconSize: 96,
    window: {
      width: 560,
      height: 360,
    },
    contents: [
      {
        x: 160,
        y: 170,
        type: "file",
      },
      {
        x: 400,
        y: 170,
        type: "link",
        path: "/Applications",
      },
    ],
  },
  win: {
    legalTrademarks: productName,
    target: ["nsis", "msix"],
    ...windowsSigning(),
  },
  // MSIX ships beside NSIS: the exe keeps electron-updater and normal
  // distribution; the MSIX exists for Store/sideload installs and for the
  // Windows Copilot hardware key, whose provider registration is only
  // readable from an MSIX manifest (customExtensionsPath splices the
  // uap3:AppExtension fragment into the generated <Extensions> block; the
  // hermes:// protocol extension itself is auto-generated from the
  // protocols config above). Signing rides the same Azure Trusted Signing
  // chain as the exe (MsixTarget → packager.signIf), so `publisher` must
  // byte-match the certificate subject. electron-updater does not update
  // MSIX installs.
  msix: {
    identityName: light ? "NousResearch.HermesLight" : "NousResearch.Hermes",
    applicationId: light ? "HermesLight" : "Hermes",
    displayName: productName,
    publisher: "CN=Nous Research Inc., O=Nous Research Inc., L=Austin, S=Texas, C=US",
    publisherDisplayName: "Nous Research",
    customExtensionsPath: light
      ? "electron/msix/copilot-key-extensions-light.xml"
      : "electron/msix/copilot-key-extensions.xml",
  },
  linux: {
    category: "Development",
    maintainer: "Nous Research <support@nousresearch.com>",
    synopsis: light ? "Remote-only desktop client for Hermes Agent." : "Native desktop shell for Hermes Agent.",
    target: ["AppImage", "deb", "rpm"],
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    installerIcon: "assets/icon.ico",
    uninstallerIcon: "assets/icon.ico",
    installerHeaderIcon: "assets/icon.ico",
    shortcutName: productName,
    uninstallDisplayName: productName,
    warningsAsErrors: false,
  },
}
