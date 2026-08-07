import { ValidationOptions, registerDecorator } from 'class-validator';
import { isAcceptableVideoUrl } from '../../shared/media-source';

/**
 * videoUrl admission for room DTOs: the shared rule, plus '' - the room's
 * null sentinel ("no video"). '' must stay admitted on PATCH because the
 * settings form round-trips `room.videoUrl || ''`; refusing it would 400
 * every settings save on a room that has no video yet.
 *
 * The shared rule itself lives in shared/media-source.ts (DOM-free, no
 * class-validator dependency - the frontend bundles the same file), so
 * only this thin decorator is backend-specific.
 */
export function IsRoomVideoUrl(options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isRoomVideoUrl',
      target: object.constructor,
      propertyName,
      options: {
        message:
          'videoUrl must be an http(s) URL, a /media/ path, or a YouTube id',
        ...options,
      },
      validator: {
        validate: (value: unknown): boolean =>
          typeof value === 'string' &&
          (value === '' || isAcceptableVideoUrl(value)),
      },
    });
  };
}
