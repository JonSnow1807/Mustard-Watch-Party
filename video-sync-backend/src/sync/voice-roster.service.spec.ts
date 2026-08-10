import { VoiceRosterService } from './voice-roster.service';

const ada = { userId: 'u1', username: 'ada' };
const grace = { userId: 'u2', username: 'grace' };

describe('VoiceRosterService', () => {
  let roster: VoiceRosterService;
  beforeEach(() => {
    roster = new VoiceRosterService();
  });

  it('lists who is on a call, and nothing for a room with no call', () => {
    roster.join('ROOM', 'sock-1', ada);
    expect(roster.list('ROOM')).toEqual([ada]);
    expect(roster.list('OTHER')).toEqual([]);
  });

  it('keeps rooms apart', () => {
    roster.join('A', 'sock-1', ada);
    roster.join('B', 'sock-2', grace);
    expect(roster.list('A')).toEqual([ada]);
    expect(roster.list('B')).toEqual([grace]);
  });

  it('counts one person once, however many tabs they have open', () => {
    // the same human with the room open twice is one voice on the call, and
    // listing them twice reads as a bug to everyone looking at it
    roster.join('ROOM', 'sock-1', ada);
    roster.join('ROOM', 'sock-2', ada);
    expect(roster.list('ROOM')).toEqual([ada]);
  });

  it('reports which room a leaver was in, so the caller can announce it', () => {
    roster.join('ROOM', 'sock-1', ada);
    expect(roster.leave('sock-1')).toBe('ROOM');
    expect(roster.list('ROOM')).toEqual([]);
  });

  it('says nothing about a socket that was never on a call', () => {
    expect(roster.leave('never-here')).toBeNull();
  });

  it('drops one tab without dropping the person', () => {
    roster.join('ROOM', 'sock-1', ada);
    roster.join('ROOM', 'sock-2', ada);
    roster.leave('sock-1');
    expect(roster.list('ROOM')).toEqual([ada]);
  });

  it('forgets a room once its last caller leaves', () => {
    roster.join('ROOM', 'sock-1', ada);
    roster.leave('sock-1');
    // a room that emptied must not linger as a stale key
    expect(roster.list('ROOM')).toEqual([]);
    expect(roster.leave('sock-1')).toBeNull();
  });
});
