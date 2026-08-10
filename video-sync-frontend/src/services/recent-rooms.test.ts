import {
  clearRecentRooms,
  forgetRoom,
  listRecentRooms,
  rememberRoom,
} from './recent-rooms';

beforeEach(() => localStorage.clear());

describe('recent rooms', () => {
  it('remembers a visit, newest first', () => {
    rememberRoom({ code: 'AAA', name: 'First' }, 1000);
    rememberRoom({ code: 'BBB', name: 'Second' }, 2000);

    expect(listRecentRooms().map((r) => r.code)).toEqual(['BBB', 'AAA']);
  });

  it('lists a room once, at its most recent visit', () => {
    rememberRoom({ code: 'AAA', name: 'First' }, 1000);
    rememberRoom({ code: 'BBB', name: 'Second' }, 2000);
    rememberRoom({ code: 'AAA', name: 'First again' }, 3000);

    const rooms = listRecentRooms();
    expect(rooms.map((r) => r.code)).toEqual(['AAA', 'BBB']);
    expect(rooms[0].name).toBe('First again');
  });

  it('keeps only the last handful', () => {
    for (let i = 0; i < 20; i++) {
      rememberRoom({ code: `R${i}`, name: `Room ${i}` }, i);
    }
    expect(listRecentRooms()).toHaveLength(6);
    expect(listRecentRooms()[0].code).toBe('R19');
  });

  it('falls back to the code when a room has no name', () => {
    rememberRoom({ code: 'AAA', name: '' }, 1000);
    expect(listRecentRooms()[0].name).toBe('AAA');
  });

  it('forgets one room, and all of them', () => {
    rememberRoom({ code: 'AAA', name: 'a' }, 1);
    rememberRoom({ code: 'BBB', name: 'b' }, 2);

    forgetRoom('AAA');
    expect(listRecentRooms().map((r) => r.code)).toEqual(['BBB']);

    clearRecentRooms();
    expect(listRecentRooms()).toEqual([]);
  });

  it.each([
    ['unparseable JSON', 'not json at all'],
    ['a non-array', '{"code":"AAA"}'],
    ['entries of the wrong shape', '[{"nope":1},null,3]'],
  ])('survives %s in storage', (_name, stored) => {
    // a corrupt entry must not blank the dashboard or throw during render
    localStorage.setItem('mustard:recent-rooms', stored);
    expect(() => listRecentRooms()).not.toThrow();
    expect(listRecentRooms()).toEqual([]);
  });

  it('keeps the good entries when only some are corrupt', () => {
    localStorage.setItem(
      'mustard:recent-rooms',
      JSON.stringify([{ code: 'AAA', name: 'ok', at: 5 }, { junk: true }]),
    );
    expect(listRecentRooms().map((r) => r.code)).toEqual(['AAA']);
  });

  it('ignores a visit with no code', () => {
    rememberRoom({ code: '', name: 'nameless' }, 1);
    expect(listRecentRooms()).toEqual([]);
  });
});
