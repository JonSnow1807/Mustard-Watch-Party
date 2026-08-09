import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsString,
  MaxLength,
} from 'class-validator';
import { SkipIfAbsent } from './skip-if-absent.decorator';
import { IsRoomVideoUrl } from './room-video-url.decorator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * POST /rooms body. Length caps exist because name/description/tags ride
 * every public-rooms listing and room fetch - like videoUrl's cap, they
 * bound store and wire, not just sanity. The caps are generous; the point
 * is that a megabyte can't become a room name.
 *
 * Deliberately NO userId, same as UpdateRoomDto. The creator is the caller,
 * taken from the verified bearer token by JwtAuthGuard - a body field would
 * have let anyone create rooms as anyone. With whitelist:true a legacy
 * client that still sends `userId` is not rejected, it is ignored.
 */
export class CreateRoomDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  // '' admitted as the "no video yet" sentinel; anything else must pass
  // the shared admission rule. Trimmed first - the rule is strict about
  // surrounding whitespace by design, so the DTO owns the trim.
  @Transform(trim)
  @SkipIfAbsent()
  @IsRoomVideoUrl()
  videoUrl?: string;

  @SkipIfAbsent()
  @IsBoolean()
  isPublic?: boolean;

  @Transform(trim)
  @SkipIfAbsent()
  @IsString()
  @MaxLength(500)
  description?: string;

  @SkipIfAbsent()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  tags?: string[];

  @SkipIfAbsent()
  @IsBoolean()
  allowGuestControl?: boolean;
}
