/**
 * Member strip: the room's roster, rendered as ProfileGlyphs beside the
 * session's own ProfileTag once a chat has become a group. Invisible until
 * then — a plain chat pays one store read and renders nothing.
 *
 * Each glyph carries the per-member actions on its context menu (mute /
 * remove), mirroring ProfileSquare in the rail — the square/glyph IS the home
 * for per-profile actions everywhere in the app.
 */

import { useStore } from '@nanostores/react'
import type { FC } from 'react'

import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { ProfileGlyph } from '@/components/ui/profile-glyph'
import { Tip } from '@/components/ui/tooltip'
import { resolveProfileColor } from '@/lib/profile-color'
import { cn } from '@/lib/utils'
import { $groupChats, removeGroupMember, setMemberMuted } from '@/store/group-chat'
import { $profileColors } from '@/store/profile'

export const GroupMemberStrip: FC<{ sessionId: null | string }> = ({ sessionId }) => {
  const groups = useStore($groupChats)
  const colors = useStore($profileColors)

  const groupId = sessionId ? `session:${sessionId}` : null
  const group = groupId ? groups[groupId] : null
  const members = group ? group.members.filter(member => !member.host) : []

  if (!groupId || members.length === 0) {
    return null
  }

  return (
    <span className="inline-flex items-center gap-1" data-slot="group-member-strip">
      {members.map(member => (
        <ContextMenu key={member.profile}>
          <ContextMenuTrigger asChild>
            <span className={cn('inline-flex', member.muted && 'opacity-40')}>
              <Tip label={member.muted ? `${member.profile} (muted)` : member.profile}>
                <ProfileGlyph
                  aria-label={member.profile}
                  color={resolveProfileColor(member.profile, colors)}
                  isDefault={false}
                  name={member.profile}
                  role="img"
                />
              </Tip>
            </span>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onSelect={() => setMemberMuted(groupId, member.profile, !member.muted)}>
              {member.muted ? 'Unmute' : 'Mute'}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => removeGroupMember(groupId, member.profile)}>
              Remove from chat
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ))}
    </span>
  )
}
