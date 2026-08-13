/**
 * Bridge: gateway events → group-chat store.
 *
 * Every profile socket funnels through the ONE registry `onEvent` in
 * wiring.tsx. This hook lets the group store claim `message.complete` events
 * whose session id belongs to a group member, fanning the finished turn back
 * into the room (routeGroupMessage → next member's turn). Non-member events
 * pass through untouched; group events STILL pass through, so the member's
 * own session view (open in a tab, say) stays live too.
 */

import type { GatewayEvent } from '@hermes/shared'

import { $groupChats, handleGroupGatewayEvent } from '@/store/group-chat'

/** session_id → { groupId, profile } for every live group member session. */
function memberBySessionId(sessionId: string): { groupId: string; profile: string } | null {
  const groups = $groupChats.get()

  for (const key of Object.keys(groups)) {
    const group = groups[key]

    if (!group) {
      continue
    }

    for (const member of group.members) {
      if (member.sessionId && member.sessionId === sessionId) {
        return { groupId: group.id, profile: member.profile }
      }
    }
  }

  return null
}

/** Call from the registry event path. Returns the event unchanged (tap, not
 *  filter) — group fan-in must never eat an event the session view needs. */
export function tapGroupChatEvents(event: GatewayEvent): void {
  if (event.type !== 'message.complete' || !event.session_id) {
    return
  }

  const hit = memberBySessionId(event.session_id)

  if (hit) {
    handleGroupGatewayEvent(hit.groupId, hit.profile, event)
  }
}
