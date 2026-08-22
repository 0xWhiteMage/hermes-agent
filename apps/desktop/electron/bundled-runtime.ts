// bundled-runtime.ts: pure helpers for the embedded desktop runtime.
// An Embedded artifact carries the whole agent runtime in its resources
// and ALWAYS spawns the backend from there — there is no decision contest
// against checkouts. This module only answers: does a payload exist
// (resolvePayload), where is its interpreter (findEmbeddedPython),
// and what update channel applies (resolveChannel).
//
// Design: .hermes/plans/2026-08-07_183000-two-axis-install-model.md.
//
// All functions in this file are pure, and the callers inject the
// dependencies. Thus vitest covers the whole decision surface. The impure
// executors live in main.ts and bootstrap-runner.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// ─── payload discovery ──────────────────────────────────────────────────────

export interface PayloadInfo {
  dir: string
  tag: string | null
  /** Payload-relative path of the CPython binary staging probed and recorded. */
  python: string
}

/**
 * Resolve the agent-payload directory that ships in the resources of the
 * packaged app. Returns null for external builds (a stub manifest with
 * external:true), for dev runs (no resourcesPath), and for unreadable,
 * old-schema, or malformed manifests.
 *
 * The manifest is the ONLY gate here. Payload completeness is a build
 * invariant (staging fails the build on a missing item, and
 * assertPayloadArch verifies every fact's bytes). A duplicate item-walk
 * here was a second copy of the layout, and it broke exactly that way:
 * the store-entry rename (`uv/` → `uv-<version>-<target>/`) landed and
 * the walk rejected every correct payload as damaged. The backend's
 * tools resolve through the payload's runtimes.json
 * (buildDesktopBackendEnv) — the facts are the layout authority; nothing
 * in the shell needs a copy.
 *
 * Schema 4 records the interpreter path (`python`, payload-relative,
 * forward slashes): staging already ran that binary and probed its
 * architecture, so the shell reads the recorded answer instead of
 * re-deriving it with a directory scan. A schema-4 manifest without a
 * usable python path is malformed — that build could not have passed
 * staging — so it reads as no payload, and the caller reports damage.
 */
export function resolvePayload(
  resourcesPath: string | null | undefined,
  readFile: (p: string) => string = p => fs.readFileSync(p, 'utf8')
): PayloadInfo | null {
  if (!resourcesPath) {
    return null
  }

  const dir = path.join(resourcesPath, 'agent-payload')

  let parsed

  try {
    parsed = JSON.parse(readFile(path.join(dir, 'manifest.json')))
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object' || parsed.external === true) {
    return null
  }

  if (parsed.schemaVersion !== PAYLOAD_SCHEMA_VERSION) {
    return null
  }

  if (typeof parsed.python !== 'string' || parsed.python === '' || path.isAbsolute(parsed.python)) {
    return null
  }

  return {
    dir,
    tag: typeof parsed.tag === 'string' ? parsed.tag : null,
    python: parsed.python
  }
}

// The manifest schema this build understands. Staging writes the same
// number (stage-agent-payloads.mjs); the app and its payload travel in the
// same artifact, so a mismatch means a damaged or foreign artifact.
export const PAYLOAD_SCHEMA_VERSION = 4

/**
 * The absolute path of the payload CPython binary, or null when the
 * recorded binary is not on disk. The manifest says where staging put it
 * (and staging executed it there); this only verifies the bytes exist.
 * The interpreter is the one payload byte the shell itself consumes, so
 * a null here is what a damaged artifact looks like from the shell.
 */
export function findEmbeddedPython(
  payload: Pick<PayloadInfo, 'dir' | 'python'>,
  fsImpl: Pick<typeof fs, 'existsSync'> = fs
): string | null {
  // The manifest records forward slashes for cross-host byte-stability;
  // resolve them through the host path module.
  const candidate = path.join(payload.dir, ...payload.python.split('/'))

  return fsImpl.existsSync(candidate) ? candidate : null
}

// ─── update channel ─────────────────────────────────────────────────────────

/**
 * The install id of the tree at `root`: sha16 of the canonical PATH,
 * byte-identical to Python's `boot_bootstrap._install_key` (sha256 of the
 * resolved root, first 16 hex chars). Path-derived so it survives artifact
 * replacement at the same location; the same key names `installs/<sha16>/`.
 */
export function installIdForRoot(root: string, canonicalize: (p: string) => string = p => p): string {
  return createHash('sha256').update(canonicalize(root), 'utf8').digest('hex').slice(0, 16)
}

/**
 * A nightly release tag: `v<major>.<minor>.0-nightly.<YYYYMMDDHHMMSS>`, or
 * the legacy date-only shape. Mirrors `_NIGHTLY_TAG_RE` in
 * hermes_cli/update_channel.py and the nightly test in
 * apps/desktop/product-identity.cjs — all three key off the same tag.
 */
export function isNightlyTag(tag: string | null | undefined): boolean {
  return typeof tag === 'string' && /^v(?:0|[1-9]\d{0,2})\.\d+\.\d+-nightly\.20\d{6}(?:\d{6})?$/.test(tag.trim())
}

/**
 * The channel an install with no per-install record tracks.
 *
 * A bundled/light artifact follows the feed it was itself published to:
 * `product-identity.cjs` bakes `channel: 'nightly'` into app-update.yml for
 * a nightly tag, so defaulting a nightly artifact to stable makes the app
 * ask for its nightly feed file under the newest STABLE release, where it
 * does not exist — a 404 that leaves the install permanently unable to
 * update. Everything else defaults to main, the source-checkout default.
 */
export function defaultUpdateChannel(
  stampTag: string | null | undefined,
  mechanism: string | null | undefined
): 'stable' | 'main' | 'nightly' {
  if (mechanism !== 'electron-updater') {
    return 'main'
  }

  return isNightlyTag(stampTag) ? 'nightly' : 'stable'
}

/**
 * The update channel of the install with id `installId`, read from
 * config.yaml text (`update.installs.<sha16>.channel` — the per-install
 * record `hermes update --set-channel` writes; there is no home-global
 * channel key). The CLI owns this shape; Electron only mirrors it for the
 * version pill and the stable-channel check path. With no explicit record
 * for THIS install, the answer is the artifact's own default channel
 * (`defaultUpdateChannel`) — callers pass the stamp facts so a nightly
 * bundle tracks nightly; omitting them keeps the source-checkout `main`.
 *
 * The parser is deliberately narrow: find the top-level `update:` block,
 * the `installs:` block inside it, then the `<installId>:` block, then its
 * `channel:`. config.yaml is machine-written here, so this shape is stable.
 */
export function updateChannelFromConfig(
  configText: string | null | undefined,
  installId: string,
  stampTag: string | null = null,
  mechanism: string | null = null
): 'stable' | 'main' | 'nightly' {
  const fallback = defaultUpdateChannel(stampTag, mechanism)

  if (!configText || !installId) {
    return fallback
  }

  // Depth by indentation: update: (0) → installs: (>0) → <sha16>: (deeper) →
  // channel: (deeper still). Track the indent at which each block opened so
  // a sibling key at the same depth closes it.
  let updateIndent: number | null = null
  let installsIndent: number | null = null
  let idIndent: number | null = null

  for (const raw of configText.split('\n')) {
    const line = raw.replace(/\s+$/, '')

    if (!line || /^\s*#/.test(line)) {
      continue
    }

    const indent = line.length - line.replace(/^\s+/, '').length
    const key = line.replace(/^\s+/, '')

    if (updateIndent === null) {
      if (/^update:\s*$/.test(line)) {
        updateIndent = indent
      }

      continue
    }

    if (indent <= updateIndent) {
      break // the update block ended
    }

    if (installsIndent === null) {
      if (/^installs:\s*$/.test(key)) {
        installsIndent = indent
      }

      continue
    }

    if (indent <= installsIndent) {
      installsIndent = null
      idIndent = null

      continue
    }

    if (idIndent === null) {
      if (new RegExp(`^${installId}:\\s*$`).test(key)) {
        idIndent = indent
      }

      continue
    }

    if (indent <= idIndent) {
      idIndent = null

      continue
    }

    const match = key.match(/^channel:\s*["']?(stable|main|nightly)["']?\s*(#.*)?$/)

    if (match) {
      return match[1] as 'stable' | 'main' | 'nightly'
    }
  }

  return fallback
}

/**
 * Pick the newest final release tag (vX.Y.Z, no prerelease suffix) from
 * `git ls-remote --tags` output. Numeric ordering, so v0.10.0 > v0.9.0.
 * Returns null when the output has no final release tag.
 *
 * A peeled entry (`refs/tags/v1.2.3^{}`) resolves the commit that an
 * annotated tag points at. It wins over the unpeeled line of the same tag.
 */
export function latestReleaseFromLsRemote(output: string): { tag: string; sha: string } | null {
  const versions = new Map<string, { key: [number, number, number]; sha: string; peeled: boolean }>()

  for (const line of output.split('\n')) {
    // The major component is capped at three digits: the historical CalVer
    // tags (v2026.7.20) would win every numeric sort. This mirrors
    // _RELEASE_TAG_RE in hermes_cli/update_cmd.py and _SEMVER_TAG_RE in
    // scripts/write_install_stamp.py.
    const m = line.match(/^([0-9a-f]{40})\trefs\/tags\/(v(?:0|[1-9]\d{0,2})\.\d+\.\d+)(\^\{\})?$/)

    if (!m) {
      continue
    }

    const [, sha, tag, peel] = m
    const existing = versions.get(tag)

    if (!existing || (peel && !existing.peeled)) {
      const [major, minor, patch] = tag.slice(1).split('.').map(Number)

      versions.set(tag, { key: [major, minor, patch], sha, peeled: Boolean(peel) })
    }
  }

  let best: { tag: string; sha: string; key: [number, number, number] } | null = null

  for (const [tag, { key, sha }] of versions) {
    const newer =
      !best ||
      key[0] > best.key[0] ||
      (key[0] === best.key[0] && (key[1] > best.key[1] || (key[1] === best.key[1] && key[2] > best.key[2])))

    if (newer) {
      best = { tag, sha, key }
    }
  }

  return best ? { tag: best.tag, sha: best.sha } : null
}
