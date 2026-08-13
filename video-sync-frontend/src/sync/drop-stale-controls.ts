import { SYNC_EVENTS } from '../shared/sync-protocol';

/**
 * Remove queued SYNC CONTROL packets from a socket.io send buffer, keeping
 * everything else.
 *
 * The no-buffering contract the dedup TTL's soundness rests on applies to
 * control traffic and control traffic only: a play/pause/seek that flushes
 * arbitrarily late re-commands the room from the past, which is the exact
 * hazard formal/SyncExactlyOnce.tla's RetryWindow bounds. A CHAT message
 * flushing late is the opposite case - it is the message the person typed,
 * arriving; ChatPanel clears its input on emit and has no recovery, so
 * dropping it loses it permanently. The first version of this cleared the
 * whole buffer and would have eaten exactly those messages.
 *
 * Clock pings may also sit here; they are kept because they are harmless
 * late - each pong is matched by its echoed t0, and an unmatched pong is
 * ignored.
 *
 * socket.io buffer entries are packets whose data array starts with the
 * event name; anything shaped differently is not a control and is kept.
 */
export function dropStaleControls<T extends { data?: unknown[] }>(
  buffer: T[],
): T[] {
  return buffer.filter((packet) => packet?.data?.[0] !== SYNC_EVENTS.control);
}
