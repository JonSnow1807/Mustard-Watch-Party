import { ValidateIf, ValidationOptions } from 'class-validator';

/**
 * Like @IsOptional(), except null is NOT admitted. @IsOptional() skips
 * every validator for null AND undefined - which would let `name: null`
 * reach Prisma as a write to a non-nullable column (a 500, not a 400)
 * and let `videoUrl: null` clear the video while '' is the documented
 * clear sentinel. Only an ABSENT field skips validation; an explicit
 * null must argue with the validators like any other value.
 */
export function SkipIfAbsent(options?: ValidationOptions) {
  return ValidateIf((_object, value) => value !== undefined, options);
}
