import { dropStaleControls } from './drop-stale-controls';
import { SYNC_EVENTS } from '../shared/sync-protocol';

// The predicate the disconnect handler applies to socket.io's sendBuffer.
// The first version cleared the WHOLE buffer, which enforced the control
// no-buffering contract by also eating any chat message typed during a
// half-open socket - ChatPanel clears its input on emit and has no
// recovery, so those were lost permanently. Caught in review.

const packet = (event: string, ...args: unknown[]) => ({
  type: 2,
  data: [event, ...args],
});

test('drops queued sync controls - the stale re-command hazard', () => {
  const buffer = [
    packet(SYNC_EVENTS.control, { intent: 'play', mediaTime: 3 }),
    packet(SYNC_EVENTS.control, { intent: 'seek', mediaTime: 500 }),
  ];
  expect(dropStaleControls(buffer)).toEqual([]);
});

test('keeps everything that is not a control', () => {
  // the chat message is the case that was being eaten; clock pings are
  // matched by echoed t0 and harmless late; join-room is idempotent
  const chat = packet('send-message', { message: 'typed during the blip' });
  const clock = packet(SYNC_EVENTS.clock, { t0: 123 });
  const join = packet('join-room', { roomCode: 'r1' });
  const control = packet(SYNC_EVENTS.control, { intent: 'pause' });

  expect(dropStaleControls([chat, control, clock, join])).toEqual([
    chat,
    clock,
    join,
  ]);
});

test('keeps packets with no recognizable shape rather than guessing', () => {
  const odd = [{ type: 2 }, { data: [] }, {}] as { data?: unknown[] }[];
  expect(dropStaleControls(odd)).toEqual(odd);
});
