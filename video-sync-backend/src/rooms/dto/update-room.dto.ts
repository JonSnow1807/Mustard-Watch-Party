import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
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

  // The settings form has offered these three since it was written, and the
  // pipe's whitelist silently dropped every one of them: toggling "List
  // publicly" or changing the participant cap did nothing and said it had
  // worked. They are real columns with real behaviour behind them -
  // allowGuestControl gates who may drive playback (timeline.service.ts) and
  // maxUsers is enforced at join (sync.gateway.ts) - so they belong here.
  @SkipIfAbsent()
  @IsBoolean()
  isPublic?: boolean;

  @SkipIfAbsent()
  @IsBoolean()
  allowGuestControl?: boolean;

  // Floor of 2: a one-person watch party is a contradiction, and a cap below
  // the people already in the room would only strand the next reconnect.
  @SkipIfAbsent()
  @IsInt()
  @Min(2)
  @Max(500)
  maxUsers?: number;
}
