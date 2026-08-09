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
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
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
