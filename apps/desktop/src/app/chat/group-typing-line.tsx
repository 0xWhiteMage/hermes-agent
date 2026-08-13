/**
 * Working-members line for a normal chat that has become a room: "builder is
 * typing…" dots above the composer, tinted per profile. Renders nothing for
 * plain (non-group) sessions — the overwhelmingly common case costs one
 * store read.
 */

import { useStore } from '@nanostores/react'
import type { FC } from 'react'

import { profileColorSoft, resolveProfileColor } from '@/lib/profile-color'
import { $groupTyping } from '@/store/group-chat'
import { $profileColors } from '@/store/profile'

export const GroupTypingLine: FC<{ sessionId: null | string }> = ({ sessionId }) => {
  const typing = useStore($groupTyping)
  const overrides = useStore($profileColors)

  const working = sessionId ? (typing[`session:${sessionId}`] ?? []) : []

  if (working.length === 0) {
    return null
  }

  return (
    <div className="flex items-center gap-3 px-4 pb-1" data-slot="group-typing-line">
      {working.map(profile => {
        const color = resolveProfileColor(profile, overrides) ?? 'var(--ui-text-secondary)'

        return (
          <span
            className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium"
            key={profile}
            style={{ backgroundColor: profileColorSoft(color, 12), color }}
          >
            {profile}
            <span className="inline-flex gap-0.5">
              <span className="size-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
              <span className="size-1 animate-bounce rounded-full bg-current [animation-delay:120ms]" />
              <span className="size-1 animate-bounce rounded-full bg-current [animation-delay:240ms]" />
            </span>
          </span>
        )
      })}
    </div>
  )
}
