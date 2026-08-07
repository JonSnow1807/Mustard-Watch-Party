import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { IsRoomVideoUrl } from './room-video-url.decorator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * PATCH /rooms/:code body - flows verbatim into Prisma room.update, so
 * every property here is a column any participant can write.
 *
 * Deliberately NO userId: identity does not belong in an update body, and
 * with whitelist:true the pipe strips it before it can reach room.update
 * as a creator reassignment. If PATCH ever needs authorization it will be
 * the requester's identity from auth context, not a body field.
 */
export class UpdateRoomDto {
  @Transform(trim)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  // '' means "clear the video" - the settings form round-trips
  // `room.videoUrl || ''`, so a save on a room with no video sends ''.
  @Transform(trim)
  @IsOptional()
  @IsRoomVideoUrl()
  videoUrl?: string;
}
