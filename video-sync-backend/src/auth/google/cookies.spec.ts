import { readCookie } from './cookies';

describe('readCookie', () => {
  it('finds the cookie among others', () => {
    expect(readCookie('a=1; mw_oauth=sealed; b=2', 'mw_oauth')).toBe('sealed');
    expect(readCookie('mw_oauth=sealed', 'mw_oauth')).toBe('sealed');
  });

  it('does not match on a prefix or suffix of the name', () => {
    // 'not_mw_oauth' and 'mw_oauth_x' are different cookies, and treating
    // either as ours would let a same-site sibling supply the state
    expect(readCookie('not_mw_oauth=x', 'mw_oauth')).toBeUndefined();
    expect(readCookie('mw_oauth_x=x', 'mw_oauth')).toBeUndefined();
  });

  it('decodes the value the way the browser encoded it', () => {
    expect(readCookie('mw_oauth=a%2Bb', 'mw_oauth')).toBe('a+b');
  });

  it.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['a valueless entry', 'mw_oauth'],
    ['a different cookie only', 'session=abc'],
    ['broken percent-encoding', 'mw_oauth=%E0%A4%A'],
  ])('returns nothing for %s', (_name, header) => {
    expect(readCookie(header, 'mw_oauth')).toBeUndefined();
  });

  it('tolerates the whitespace real headers carry', () => {
    expect(readCookie('a=1;   mw_oauth = sealed ', 'mw_oauth')).toBe('sealed');
  });
});
