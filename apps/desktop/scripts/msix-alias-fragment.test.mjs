/**
 * MSIX AppExecutionAlias fragment contract.
 *
 * The CLI aliases ship inside msix.customExtensionsPath, which
 * app-builder-lib pastes verbatim into the ${extensions} macro of the
 * AppxManifest. makeappx reports every manifest problem as a bare
 * 0x80080204, so a wrong element family here costs a full Windows CI lane
 * to discover. The real error text behind that code (C00CE015, read by
 * packing a staged directory with the 26100 kit) drove these assertions:
 *
 *   * "The attribute {...desktop/windows10/4}Subsystem on the element
 *     {...uap/windows10/3}Extension is not defined in the DTD/Schema."
 *     uap3:AppExecutionAlias takes no attributes and its children are
 *     uap3:ExecutionAliasChoice; the uap5:ExecutionAlias form belongs to
 *     uap5:Extension.
 *   * "The AppExecutionAlias element cannot declare the attribute
 *     Subsystem with value console without declaring the attribute
 *     SupportsMultipleInstances with value true in element Application."
 *     The fragment cannot reach Application, so it declares no Subsystem.
 *
 * These are behavior contracts about which schema family the fragment
 * uses, not a snapshot of its text — the alias names are read back from
 * the generated file rather than frozen in the test.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'vitest'

const desktop = path.resolve(__dirname, '..')
const fragmentPath = path.join(desktop, 'build', 'msix-copilot-key-extensions.xml')

// Requiring the config writes the fragment, exactly as an electron-builder
// run does. HERMES_DESKTOP_VARIANT selects the bundled/light shape, but the
// `light` flag itself is resolved at require time inside
// product-identity.cjs — so BOTH modules must leave the require cache or the
// second variant re-reads the first one's frozen flag.
function generateFragment(variant) {
  const previous = process.env.HERMES_DESKTOP_VARIANT
  process.env.HERMES_DESKTOP_VARIANT = variant
  try {
    const require = createRequire(__filename)
    for (const mod of ['./product-identity.cjs', './electron-builder.config.cjs']) {
      delete require.cache[require.resolve(path.join(desktop, mod))]
    }
    require(path.join(desktop, 'electron-builder.config.cjs'))
    return fs.readFileSync(fragmentPath, 'utf8')
  } finally {
    if (previous === undefined) {
      delete process.env.HERMES_DESKTOP_VARIANT
    } else {
      process.env.HERMES_DESKTOP_VARIANT = previous
    }
  }
}

test('the bundled alias uses the uap5 element family, never uap3', () => {
  const fragment = generateFragment('bundled')

  assert.match(fragment, /<uap5:Extension\b/, 'alias extension must be uap5:Extension')
  assert.match(fragment, /<uap5:AppExecutionAlias\b/, 'alias element must be uap5:AppExecutionAlias')
  assert.doesNotMatch(
    fragment,
    /<uap3:AppExecutionAlias\b/,
    'uap3:AppExecutionAlias does not accept uap5:ExecutionAlias children — makeappx rejects it'
  )

  // Every ExecutionAlias must sit under the uap5 AppExecutionAlias parent.
  const aliasBlock = fragment.slice(
    fragment.indexOf('<uap5:AppExecutionAlias'),
    fragment.indexOf('</uap5:AppExecutionAlias>')
  )
  const aliases = [...aliasBlock.matchAll(/<uap5:ExecutionAlias Alias="([^"]+)"/g)].map(m => m[1])
  assert.ok(aliases.length > 0, 'no execution aliases were emitted')
  assert.equal(
    aliases.length,
    [...fragment.matchAll(/<uap5:ExecutionAlias\b/g)].length,
    'an ExecutionAlias escaped the uap5:AppExecutionAlias parent'
  )
  for (const alias of aliases) {
    assert.match(alias, /\.exe$/, `alias ${alias} must name an .exe`)
  }
})

test('the alias declares no Subsystem, which would require Application@SupportsMultipleInstances', () => {
  const fragment = generateFragment('bundled')

  assert.doesNotMatch(
    fragment,
    /Subsystem=/,
    'Subsystem="console" is only valid alongside SupportsMultipleInstances="true" on the ' +
      'Application element, which this fragment cannot reach'
  )
  assert.doesNotMatch(
    fragment,
    /SupportsMultipleInstances=/,
    'SupportsMultipleInstances is rejected on the extension — makeappx demands it on Application'
  )
})

test('every namespace prefix the fragment uses is declared within the fragment', () => {
  // The stock app-builder-lib template declares none of these prefixes, so
  // an undeclared one is an XML parse failure inside the assembled manifest.
  for (const variant of ['bundled', 'light']) {
    const fragment = generateFragment(variant)
    const used = new Set([...fragment.matchAll(/<\/?([A-Za-z0-9]+):/g)].map(m => m[1]))
    const declared = new Set([...fragment.matchAll(/xmlns:([A-Za-z0-9]+)=/g)].map(m => m[1]))
    const attrPrefixes = new Set(
      [...fragment.matchAll(/\s([A-Za-z0-9]+):[A-Za-z]+="/g)].map(m => m[1]).filter(p => p !== 'xmlns')
    )
    for (const prefix of [...used, ...attrPrefixes]) {
      assert.ok(declared.has(prefix), `${variant}: prefix "${prefix}" is used but never declared`)
    }
  }
})

test('the light variant ships the copilot key extension but no CLI aliases', () => {
  const fragment = generateFragment('light')

  assert.match(fragment, /com\.microsoft\.windows\.copilotkeyprovider/, 'copilot key extension missing')
  assert.doesNotMatch(
    fragment,
    /appExecutionAlias/,
    'the light variant ships no agent payload, so it must register no CLI aliases'
  )
})
