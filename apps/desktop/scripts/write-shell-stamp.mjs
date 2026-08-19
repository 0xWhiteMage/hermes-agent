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
// uv run, not bare python3: on Windows `python3` resolves to the
// Microsoft Store alias (exit 9009); uv is a hard prerequisite of the
// desktop build anyway.
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

const result = spawnSync(
  'uv',
  [
    'run',
    '--no-project',
    path.join(repoRoot, 'scripts', 'write_install_stamp.py'),
    '--output',
    path.join(desktopRoot, 'build', 'install-stamp.json'),
    '--update-mechanism',
    mechanism,
    ...releaseVersionArgs(tag)
  ],
  { stdio: 'inherit', shell: process.platform === 'win32' }
)

process.exit(result.status ?? 1)
