// write-shell-stamp.mjs — the app shell's own install stamp (build/).
//
// The ONE knob is HERMES_PAYLOAD_UPDATE_MECHANISM: the win32 release
// build packs twice top-down — an electron-updater pass (nsis) and an
// `external` pass (msix, store-managed) — and each pass regenerates BOTH
// stamps (this shell stamp and the payload repo stamp in
// stage-agent-payloads.mjs) through the canonical writer. Nothing ever
// mutates a stamp after it is written.
//
// A release build (HERMES_PAYLOAD_TAG set) passes the version facts in
// explicitly, exactly as stage-agent-payloads.mjs does for the payload
// stamp. The tag IS the version truth for a nightly: no version-bump
// commit exists, so hermes_cli/__init__.py still reads the previous
// stable and the writer's git fallback would derive the wrong version.
// The release checkout is depth-1 at the tag, so that fallback also
// counts commits over one commit of history and produces an arbitrary
// distance ("0.27.0+1" on a v0.28.0-nightly artifact). Passing the facts
// keeps the shell stamp and the payload stamp byte-identical about the
// version, the commit, and the commit date.
//
// A dev build has no tag. There the writer's git detection describes the
// working tree correctly, which is what a dev stamp must say.
//
// uv first, bare python3 as the POSIX fallback: on Windows `python3`
// resolves to the Microsoft Store alias (exit 9009), and uv is a hard
// prerequisite of the desktop release build anyway. Generic CI runners
// that only validate the bundle carry python3 but not uv.
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const repoRoot = path.dirname(path.dirname(desktopRoot))

const mechanism = process.env.HERMES_PAYLOAD_UPDATE_MECHANISM || 'electron-updater'
const tag = process.env.HERMES_PAYLOAD_TAG || null

/**
 * The release-build version facts, or [] for a dev build.
 *
 * `git rev-list -n 1 <tag>` rather than `rev-parse <tag>^{commit}`: the
 * same call stage-agent-payloads.mjs makes, so both stamps name one
 * commit. distance is 0 because the artifact IS the tag.
 *
 * @param {string | null} releaseTag
 * @returns {string[]}
 */
function releaseVersionArgs(releaseTag) {
  if (!releaseTag) {
    return []
  }

  const git = (/** @type {string[]} */ args) =>
    execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim()

  return [
    '--base-version',
    releaseTag.slice(1),
    '--distance',
    '0',
    '--commit',
    git(['rev-list', '-n', '1', releaseTag]),
    '--commit-date',
    git(['log', '-1', '--format=%ct', releaseTag]),
    '--source',
    'ci',
    '--distribution',
    'desktop-app'
  ]
}

/** @type {string[]} */
const stampArgs = [
  path.join(repoRoot, 'scripts', 'write_install_stamp.py'),
  '--output',
  path.join(desktopRoot, 'build', 'install-stamp.json'),
  '--update-mechanism',
  mechanism,
  ...releaseVersionArgs(tag)
]

// Interpreter ladder: uv first (the desktop release prerequisite; the only
// safe choice on Windows, where bare python3 is the Store alias), then bare
// python3 on POSIX hosts that have no uv (the generic Linux CI runner that
// builds the app for bundle validation). write_install_stamp.py is pure
// stdlib, so any Python 3 runs it. A rung falls through ONLY when the
// interpreter itself is missing (spawn ENOENT); a real stamp failure exits
// with that interpreter's status and its inherited stderr.
/** @type {string[][]} */
const interpreters = [['uv', 'run', '--no-project']]

if (process.platform !== 'win32') {
  interpreters.push(['python3'])
}

/** @type {Error | null} */
let lastSpawnError = null

for (const [command, ...prefix] of interpreters) {
  const result = spawnSync(command, [...prefix, ...stampArgs], {
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })

  if (result.error) {
    // The interpreter did not spawn (ENOENT and friends). Remember why and
    // try the next rung — but never exit silently.
    lastSpawnError = result.error

    continue
  }

  process.exit(result.status ?? 1)
}

console.error(
  `write-shell-stamp: no usable Python launcher found (tried: ${interpreters
    .map(([command]) => command)
    .join(', ')}). Last spawn error: ${lastSpawnError ? lastSpawnError.message : 'unknown'}. ` +
    'Install uv (https://docs.astral.sh/uv/) or ensure python3 is on PATH.'
)
process.exit(1)
