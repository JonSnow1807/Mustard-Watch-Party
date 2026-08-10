import { loginUrlFor, readReturnTo, safeReturnTo } from './return-to';

describe('safeReturnTo', () => {
  it('keeps a path on our own site', () => {
    expect(safeReturnTo('/room/ABC123')).toBe('/room/ABC123');
    expect(safeReturnTo('/')).toBe('/');
  });

  it.each([
    ['an absolute URL', 'https://evil.example/'],
    ['a protocol-relative URL', '//evil.example/'],
    ['a scheme', 'javascript:alert(1)'],
    ['a bare path', 'room/ABC'],
    ['a backslash', '/\\evil.example'],
    ['a newline', '/room\nSet-Cookie: a=b'],
    ['nothing', null],
    ['an empty string', ''],
  ])('refuses %s', (_name, value) => {
    expect(safeReturnTo(value)).toBeNull();
  });

  it('caps the length', () => {
    expect(safeReturnTo(`/${'a'.repeat(1000)}`)).toHaveLength(512);
  });
});

describe('readReturnTo', () => {
  it('reads and decodes the destination', () => {
    expect(readReturnTo('?next=%2Froom%2FABC123')).toBe('/room/ABC123');
  });

  it('is null when absent, and filters a hostile one', () => {
    expect(readReturnTo('')).toBeNull();
    expect(readReturnTo('?other=1')).toBeNull();
    expect(readReturnTo('?next=https%3A%2F%2Fevil.example')).toBeNull();
  });
});

describe('loginUrlFor', () => {
  it('remembers where the person was heading', () => {
    expect(loginUrlFor('/room/ABC123')).toBe('/login?next=%2Froom%2FABC123');
  });

  it('falls back to a plain sign-in rather than carrying junk', () => {
    expect(loginUrlFor('https://evil.example')).toBe('/login');
  });
});
