/**
 * How long a token is good for, in a form jsonwebtoken reads the way a person
 * meant it.
 *
 * `ms`-style strings ('12h', '30m', '7d') pass through. A digit-only string
 * becomes a NUMBER, because jsonwebtoken reads numbers as seconds and
 * unitless strings as milliseconds - the two readings differ by a thousand,
 * and the intuitive one is seconds. Anything else throws, at boot, where
 * somebody is watching.
 */
const UNIT_SECONDS: Record<string, number> = {
  ms: 0.001,
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
  // what `ms` uses for a year: 365.25 days
  y: 31557600,
};

export const tokenLifetime = (raw: string | undefined): string | number => {
  const value = (raw ?? '').trim();
  if (!value) return '12h';

  const reject = (why: string): never => {
    throw new Error(`JWT_EXPIRES_IN ${why}, got "${value}"`);
  };

  const digitsOnly = /^\d+$/.test(value);
  let seconds: number;

  if (digitsOnly) {
    seconds = Number(value);
    // A digit string long enough to overflow becomes Infinity, and an expiry
    // of Infinity is not an expiry.
    if (!Number.isFinite(seconds)) reject('is too large to be a duration');
  } else {
    // Lowercase units only, which is stricter than the `ms` library and
    // deliberately so. ms is case-insensitive and has no unit for months, so
    // "6M" - which reads as six months to anyone writing it - is parsed as
    // six MINUTES. Refusing the whole uppercase space removes that reading
    // rather than guessing which uppercase letters were meant innocently.
    const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w|y)$/.exec(value);
    if (!match) {
      reject(
        'must be a lowercase duration like "12h" or "30m", or a plain number of seconds',
      );
    }
    const [, amount, unit] = match as RegExpExecArray;
    seconds = Number(amount) * UNIT_SECONDS[unit];
    if (!Number.isFinite(seconds)) reject('is too large to be a duration');
  }

  // jsonwebtoken floors a duration to whole seconds, so anything under one
  // second lands on exp === iat: a token expired the instant it is issued,
  // with nothing in the logs to say so. "0.5s" and "999ms" both do it, and
  // both look like perfectly reasonable configuration.
  if (Math.floor(seconds) < 1) {
    reject('is under one second, which issues tokens that are already expired');
  }

  // Numbers are unambiguous to jsonwebtoken - it reads them as seconds.
  // Unitless STRINGS are milliseconds, which is the trap all of this exists
  // for, so a digit-only value is handed back as a number.
  return digitsOnly ? seconds : value;
};

/**
 * Fail closed. A dev fallback is only safe where the environment says
 * explicitly that it is local: keying off `NODE_ENV === 'production'` meant
 * any unset or typo'd NODE_ENV (staging, preview, a container that forgot
 * it) silently got a known secret.
 */
const LOCAL_ENVS = ['development', 'test'];
function requireOutsideLocal(name: string, devFallback: string): string {
  const value = process.env[name];
  if (value) return value;
  const env = process.env.NODE_ENV ?? '';
  if (!LOCAL_ENVS.includes(env)) {
    throw new Error(
      `${name} must be set (NODE_ENV='${env}' is not a local environment)`,
    );
  }
  return devFallback;
}

export default () => ({
  port: parseInt(process.env.PORT || '3000', 10),
  // Exposed so features can fail closed outside a local environment the
  // same way requireOutsideLocal does, without each of them re-reading
  // NODE_ENV and drifting on what counts as "local".
  isLocalEnv: LOCAL_ENVS.includes(process.env.NODE_ENV ?? ''),
  database: {
    url: process.env.DATABASE_URL,
    // Connection pool settings for PostgreSQL
    connectionLimit: parseInt(process.env.DB_POOL_SIZE || '20', 10),
    idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT || '30000', 10),
  },
  jwt: {
    // no fallback secret: a deployment that forgets JWT_SECRET must fail to
    // boot, not silently issue tokens anyone can forge
    secret: requireOutsideLocal('JWT_SECRET', 'dev-only-insecure-secret'),
    // 12h by DEFAULT, matching what auth.module issued while this value sat
    // unread. A configured value now changes the lifetime; nothing else does.
    //
    // Validated rather than passed through, because making dead config live
    // turns a harmless typo into a live hazard: jsonwebtoken parses a string
    // with the `ms` library, and a UNITLESS string is milliseconds. So
    // JWT_EXPIRES_IN=3600, which anyone would read as an hour, would issue
    // tokens good for 3.6 SECONDS - every session dying instantly, with
    // nothing in the logs to say why. A digit-only value is therefore
    // converted to a number, which jsonwebtoken reads as seconds, and
    // anything it cannot parse stops the boot instead of quietly becoming
    // nonsense.
    expiresIn: tokenLifetime(process.env.JWT_EXPIRES_IN),
  },
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3001',
  },
  // Where this API answers from the public internet. Needed because the
  // OAuth redirect_uri must be an absolute URL that Google can match
  // character-for-character against the console entry, and a server behind
  // a proxy cannot reliably derive its own external origin from a request.
  publicApiUrl: (process.env.PUBLIC_API_URL || 'http://localhost:3000').replace(
    /\/+$/,
    '',
  ),
  google: {
    // Absent credentials are not an error: Google sign-in is optional, and
    // an install without it (CI, the sync harness, a local checkout) must
    // boot and keep serving password auth. `enabled` is derived, never set
    // by hand, so there is no way to advertise a provider we cannot run.
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  },
  redis: {
    // set REDIS_URL to enable the multi-instance plane (adapter + Lua store)
    url: process.env.REDIS_URL,
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
  },
});
