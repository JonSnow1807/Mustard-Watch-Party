function requireInProduction(name: string, devFallback: string): string {
  const value = process.env[name];
  if (value) return value;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(`${name} must be set in production`);
  }
  return devFallback;
}

export default () => ({
  port: parseInt(process.env.PORT || '3000', 10),
  database: {
    url: process.env.DATABASE_URL,
    // Connection pool settings for PostgreSQL
    connectionLimit: parseInt(process.env.DB_POOL_SIZE || '20', 10),
    idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT || '30000', 10),
  },
  jwt: {
    // no fallback secret: a deployment that forgets JWT_SECRET must fail to
    // boot, not silently issue tokens anyone can forge
    secret: requireInProduction('JWT_SECRET', 'dev-only-insecure-secret'),
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3001',
  },
  redis: {
    // set REDIS_URL to enable the multi-instance plane (adapter + Lua store)
    url: process.env.REDIS_URL,
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
  },
});
