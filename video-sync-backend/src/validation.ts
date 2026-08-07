import { ValidationPipeOptions } from '@nestjs/common';

/**
 * The ONE ValidationPipe configuration. main.ts passes this object to
 * useGlobalPipes; the DTO spec builds its pipe from the SAME object, so the
 * semantics the spec pins (stripping, transforms) are the semantics
 * production runs - the config cannot drift from its test.
 *
 * whitelist: properties without a decorator are silently stripped. This is
 * load-bearing for PATCH /rooms/:code - the body flows verbatim into
 * Prisma room.update, so an unstripped `userId` would let any client
 * reassign a room's creator (UpdateRoomDto deliberately omits it).
 *
 * transform: bodies become DTO class instances, which runs @Transform
 * (videoUrl/name trim) BEFORE validation - pasted trailing whitespace is
 * a trim away from valid, not a 400.
 */
export const VALIDATION_PIPE_OPTIONS: ValidationPipeOptions = {
  whitelist: true,
  transform: true,
};
