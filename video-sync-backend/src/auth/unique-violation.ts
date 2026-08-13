import { Prisma } from '@prisma/client';

/**
 * True when a write failed because it collided with a unique constraint on
 * `field`. The one place the P2002 shape and the target-array probing live,
 * so the several callers that race on a unique column - username, email,
 * providerAccountId, jti - cannot disagree about what "already taken" looks
 * like.
 */
export const isUniqueViolation = (err: unknown, field: string): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError &&
  err.code === 'P2002' &&
  ((err.meta?.target as string[] | undefined) ?? []).some((t) =>
    t.includes(field),
  );

/** True when a write failed because the target row does not exist (P2025). */
export const isNotFound = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025';
