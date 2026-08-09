import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { SkipIfAbsent } from './skip-if-absent.decorator';
import { IsRoomVideoUrl } from './room-video-url.decorator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * PATCH /rooms/:code body. Still flows into Prisma room.update, so every
 * property here is a column - but no longer one "any participant can
 * write": the route is behind JwtAuthGuard and updateRoomByCode refuses a
 * caller who is not the room's creator.
 *
 * Deliberately NO userId. It used to be absent so the pipe would strip a
 * creator reassignment; now it is absent because identity is not a body
 * field at all - the creator check reads the verified token.
 */
export class UpdateRoomDto {
  @Transform(trim)
  @SkipIfAbsent()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  // '' means "clear the video" - the settings form round-trips
  // `room.videoUrl || ''`, so a save on a room with no video sends ''.
  @Transform(trim)
  @SkipIfAbsent()
  @IsRoomVideoUrl()
  videoUrl?: string;
}
