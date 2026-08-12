interface ProductIdentity {
  /** True when this artifact is Hermes Light (remote-only client). */
  light: boolean
  /** Display name. e.g. "Hermes Light" */
  displayName: string
  /** OS-level app identity in kebab case. e.g. "com.nousresearch.hermes-light" */
  appIdKebab: string
    /** app identity in pascal case. e.g. "HermesLight" */
  appIdPascal: string
  /** msix OS-level app identity w/ org prefix. e.g. "NousResearch.HermesLight" */
  msixAppIdWithOrg: string
  /** electron-updater feed channel. e.g. "light" | "latest". */
  channel: string
  /** Deep-link scheme this artifact owns. e.g. "hermes-light" | "hermes". */
  protocolScheme: string
}

declare const identity: ProductIdentity
export = identity
