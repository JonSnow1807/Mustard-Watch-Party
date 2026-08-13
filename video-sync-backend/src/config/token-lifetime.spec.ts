import { tokenLifetime } from './configuration';

describe('JWT_EXPIRES_IN, once it actually does something', () => {
  it('defaults to 12h when unset or blank', () => {
    expect(tokenLifetime(undefined)).toBe('12h');
    expect(tokenLifetime('')).toBe('12h');
    expect(tokenLifetime('   ')).toBe('12h');
  });

  it('passes ms-style durations through', () => {
    expect(tokenLifetime('12h')).toBe('12h');
    expect(tokenLifetime('30m')).toBe('30m');
    expect(tokenLifetime('7d')).toBe('7d');
  });

  it('reads a bare number as SECONDS, not milliseconds', () => {
    // The hazard that arrived with making this config live: jsonwebtoken
    // parses strings with `ms`, where a unitless string is milliseconds. So
    // JWT_EXPIRES_IN=3600 - which anyone would read as an hour - would issue
    // tokens good for 3.6 seconds, killing every session instantly with
    // nothing in the logs to say why. A number is unambiguous: jsonwebtoken
    // reads it as seconds.
    expect(tokenLifetime('3600')).toBe(3600);
    expect(typeof tokenLifetime('3600')).toBe('number');
  });

  it('refuses nonsense at boot rather than issuing something surprising', () => {
    expect(() => tokenLifetime('twelve hours')).toThrow(/JWT_EXPIRES_IN/);
    expect(() => tokenLifetime('12 fortnights')).toThrow(/JWT_EXPIRES_IN/);
    expect(() => tokenLifetime('-5')).toThrow(/JWT_EXPIRES_IN/);
  });

  it('refuses anything under a second, which expires on arrival', () => {
    // jsonwebtoken floors a duration to whole seconds, so these land on
    // exp === iat - a token expired the instant it is issued, and nothing in
    // the logs would say why. Both look like reasonable configuration.
    expect(() => tokenLifetime('0.5s')).toThrow(/already expired/);
    expect(() => tokenLifetime('999ms')).toThrow(/already expired/);
    expect(() => tokenLifetime('0.9s')).toThrow(/already expired/);
    expect(() => tokenLifetime('0')).toThrow(/already expired/);
    // and the boundary holds from the other side
    expect(tokenLifetime('1s')).toBe('1s');
    expect(tokenLifetime('1000ms')).toBe('1000ms');
    expect(tokenLifetime('1')).toBe(1);
  });

  it('refuses values too large to be an expiry at all', () => {
    // a digit string long enough overflows to Infinity, and an expiry of
    // Infinity is not an expiry
    const huge = '9'.repeat(400);
    expect(() => tokenLifetime(huge)).toThrow(/too large/);
    expect(() => tokenLifetime(`${huge}d`)).toThrow(/too large/);
  });

  it('refuses uppercase rather than guessing what it meant', () => {
    // The `ms` library is case-insensitive and has no unit for months, so
    // "6M" - six months to anyone writing it - parses as six MINUTES, a
    // factor of about forty thousand. My first version of this validator had
    // a case-insensitive regex and would have passed it straight through.
    // Refusing the whole uppercase space removes the reading instead of
    // guessing which uppercase letters were innocent.
    expect(() => tokenLifetime('6M')).toThrow(/lowercase/);
    expect(() => tokenLifetime('12H')).toThrow(/lowercase/);
  });
});
