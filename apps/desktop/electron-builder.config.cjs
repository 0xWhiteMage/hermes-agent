// The electron-builder configuration. It IS package.json's "build" field —
// this file exists only because one option cannot be expressed in JSON:
// mac.sign.ignore as a FUNCTION. osx-sign's walk selects files to sign with
// a generic binary-content probe, which flags plain binary resources (the
// payload CPython's idlelib GIFs, wheels, .zip) as signable. Signing those
// is wrong (non-Mach-O resources are covered by the bundle's CodeResources
// seal) and each bogus signing hits Apple's timestamp service — thousands
// of payload files flooded it until it refused ("The timestamp service is
// not available"). The function scopes signing to real Mach-O files.
"use strict"

const fs = require("node:fs")

const build = require("./package.json").build

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

// Windows signing with Azure Trusted Signing. Composed here, not as
// -c.win.sign.* CLI arguments: the publisherName holds spaces and commas
// that do not survive cmd.exe argument hops. This file loads inside the
// electron-builder process, so the values pass from the environment
// verbatim.
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

// MSIX packaging. Ships beside NSIS: the exe keeps electron-updater and
// normal distribution; the MSIX exists for Store/sideload installs and for
// the Windows Copilot hardware key, whose provider registration is only
// readable from an MSIX manifest (customExtensionsPath splices the
// uap3:AppExtension fragment into the generated <Extensions> block; the
// hermes:// protocol extension itself is auto-generated from the top-level
// protocols config). Signing rides the same Azure Trusted Signing chain as
// the exe (MsixTarget → packager.signIf), so `publisher` must byte-match
// the certificate subject. electron-updater does not update MSIX installs.
function msixOptions(light) {
  return {
    identityName: light ? "NousResearch.HermesLight" : "NousResearch.Hermes",
    applicationId: light ? "HermesLight" : "Hermes",
    displayName: light ? "Hermes Light" : "Hermes",
    publisher: "CN=Nous Research Inc., O=Nous Research Inc., L=Austin, S=Texas, C=US",
    publisherDisplayName: "Nous Research",
    customExtensionsPath: light
      ? "electron/msix/copilot-key-extensions-light.xml"
      : "electron/msix/copilot-key-extensions.xml",
  }
}

// Light variant identity overlay. HERMES_DESKTOP_VARIANT=light builds
// "Hermes Light": the remote-only client with no agent payload and no
// local backend. It is a SEPARATE app to the OS and to the updater —
// its own appId (installs beside full Hermes, never over it), its own
// product/executable names, its own artifact names, and its own
// electron-updater channel ('light' → light*.yml) so both variants can
// share one GitHub release without colliding feed files. A packaged
// light app follows its own channel automatically: electron-builder
// writes the channel into app-update.yml at package time.
function lightOverlay(base) {
  if (process.env.HERMES_DESKTOP_VARIANT !== "light") {
    return null
  }
  return {
    appId: "com.nousresearch.hermes-light",
    productName: "Hermes Light",
    executableName: "Hermes Light",
    artifactName: "Hermes-Light-${version}-${os}-${arch}.${ext}",
    // channel: 'light' → the light*.yml feed, so both variants share one
    // GitHub release without colliding feed files.
    publish: (base.publish || []).map((entry) => ({ ...entry, channel: "light" })),
    // The packaged package.json 'name'. Everything runtime keys on
    // productName/appId, which the overlay already renames — but
    // electron-updater's cache dir derives from THIS field
    // (appInfo.updaterCacheDirName = sanitized name + '-updater'), and
    // both variants can live on one machine: with the shared name they
    // stage downloads in the same <cache>/hermes-updater dir and can
    // install each other's artifacts.
    extraMetadata: { name: "hermes-light" },
    mac: {
      ...base.mac,
      extendInfo: {
        ...base.mac.extendInfo,
        CFBundleDisplayName: "Hermes Light",
        CFBundleExecutable: "Hermes Light",
        CFBundleName: "Hermes Light",
      },
    },
    dmg: {
      ...base.dmg,
      title: "Install Hermes Light",
    },
    win: {
      ...base.win,
      legalTrademarks: "Hermes Light",
    },
    linux: {
      ...base.linux,
      synopsis: "Remote-only desktop client for Hermes Agent.",
    },
    nsis: {
      ...base.nsis,
      shortcutName: "Hermes Light",
      uninstallDisplayName: "Hermes Light",
    },
  }
}

const light = lightOverlay(build)

module.exports = {
  ...build,
  ...light,
  msix: msixOptions(Boolean(light)),
  win: {
    ...build.win,
    ...(light ? light.win : {}),
    ...windowsSigning(),
  },
  mac: {
    ...(light ? light.mac : build.mac),
    sign: {
      ...build.mac.sign,
      // true → skip. Directories pass through (the walk hands over .app and
      // .framework bundles, which codesign must see whole); every regular
      // file must prove it is Mach-O to be signed individually.
      ignore: (file) => {
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
}
