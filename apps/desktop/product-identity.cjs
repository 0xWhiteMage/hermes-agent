// The desktop product identity — THE single source for every name-shaped
// value a variant owns. HERMES_DESKTOP_VARIANT=light builds "Hermes
// Light", the remote-only client; everything else is full "Hermes".
//
// Consumed at build time by electron-builder.config.cjs (packaging
// identity) and bundle-electron-main.mjs (which bakes this object into
// the main bundle as the __HERMES_PRODUCT_IDENTITY__ define, the same
// mechanism as the install stamp) — so the packaged artifact and the
// runtime code can never disagree about who they are.
//
// electron/product-identity.ts is the typed runtime accessor; its
// ProductIdentity interface mirrors the object shape here.
// @ts-check
/// <reference types="node" />
"use strict"

const light = process.env.HERMES_DESKTOP_VARIANT === "light"

// master product id, used for all sorts of markers
const variant = light ? ["Hermes", "Light"] : ["Hermes"]

const name = {
  display: variant.join(" "),
  kebab: variant.join("-").toLowerCase(),
  pascal: variant.join(""),
}

/** @typedef {import("./product-identity.d.cts")} ProductIdentity */

/** @type {ProductIdentity} */
const identity = {
  light,
  displayName: name.display,
  appIdKebab: `com.nousresearch.${name.kebab}`,
  channel: light ? "light" : "latest",
  protocolScheme: name.kebab,
  appIdPascal: name.pascal,
  msixAppIdWithOrg: `NousResearch.${name.pascal}`
}

module.exports = identity