import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { IsRoomVideoUrl } from './room-video-url.decorator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * POST /rooms body. Length caps exist because name/description/tags ride
 * every public-rooms listing and room fetch - like videoUrl's cap, they
 * bound store and wire, not just sanity. The caps are generous; the point
 * is that a megabyte can't become a room name.
 */
export class CreateRoomDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  // Identity of the creator. Present here and ONLY here - UpdateRoomDto
  // deliberately omits it (a PATCH must not reassign ownership).
  @IsString()
  @IsNotEmpty()
  userId: string;

  // '' admitted as the "no video yet" sentinel; anything else must pass
  // the shared admission rule. Trimmed first - the rule is strict about
  // surrounding whitespace by design, so the DTO owns the trim.
  @Transform(trim)
  @IsOptional()
  @IsRoomVideoUrl()
  videoUrl?: string;

  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  tags?: string[];

  @IsOptional()
  @IsBoolean()
  allowGuestControl?: boolean;
}
