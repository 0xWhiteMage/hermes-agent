// app/connection/modes/local/index.ts — run the agent on this machine.
//
// The only mode with nothing to configure: choosing it IS the configuration,
// so it declares an empty draft and no panel. What "choose local" DOES
// differs per surface (Settings applies a local connection; first-run runs
// the installer through the bootstrap gate) — that lives in the surface's
// commit, never here.
//
// Availability is a constant of the artifact, decided in electron
// (backends/local.ts): a light build ships no runtime and cannot bootstrap
// one, so its card renders disabled with that reason.

import type { DesktopConnectionConfigInput } from '@/global'
import { Monitor } from '@/lib/icons'

import type { ConnectionCardContext, ConnectionModeCard, ConnectionModeModule } from '../../types'

import { LocalPanel } from './panel'

/** Local has no fields. The empty object keeps the module shape uniform. */
export type LocalDraft = Record<string, never>

export const localMode: ConnectionModeModule<'local', LocalDraft> = {
  mode: 'local',

  emptyDraft: (): LocalDraft => ({}),

  fromSaved: (): LocalDraft => ({}),

  toPayload: (_draft: LocalDraft, scope: null | string): DesktopConnectionConfigInput => ({
    mode: 'local',
    profile: scope ?? undefined
  }),

  card: ({ copy }: ConnectionCardContext): ConnectionModeCard => ({
    icon: Monitor,
    title: copy.localTitle,
    description: copy.localDesc
  }),

  ConfigPanel: LocalPanel
}
