import 'reflect-metadata';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { RoomsController } from './rooms.controller';
import { RoomsService } from './rooms.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DatabaseService } from '../database/database.service';
import type { AuthedUser } from '../auth/token-payload';
import type { UpdateRoomDto } from './dto/update-room.dto';
import type { CreateRoomDto } from './dto/create-room.dto';

/**
 * What this file pins: the REST plane's authorization, end to end from the
 * controller through the real RoomsService (only Prisma is faked).
 *
 * Before this change, /rooms trusted whatever userId the caller put in the
 * body or path. DELETE "checked ownership" against a field the client had
 * just handed it; PATCH did not check at all. So the tests here are the two
 * halves of the fix: a non-owner is refused, and the id the service is
 * given is the TOKEN's - never the body's, never the path's.
 */

const OWNER: AuthedUser = { userId: 'user-owner', username: 'owner' };
const INTRUDER: AuthedUser = { userId: 'user-intruder', username: 'mallory' };

const ROOM = {
  id: 'room-1',
  code: 'CODE1',
  name: 'movie night',
  creatorId: OWNER.userId,
  participants: [],
};

describe('RoomsController authorization', () => {
  let database: DatabaseService;
  let controller: RoomsController;
  let db: {
    room: Record<string, jest.Mock>;
    participant: Record<string, jest.Mock>;
    chatMessage: Record<string, jest.Mock>;
    syncEvent: Record<string, jest.Mock>;
    $transaction: jest.Mock;
  };

  beforeEach(() => {
    db = {
      room: {
        findUnique: jest.fn().mockResolvedValue(ROOM),
        findMany: jest.fn().mockResolvedValue([ROOM]),
        create: jest
          .fn()
          .mockImplementation((args: { data: Record<string, unknown> }) =>
            Promise.resolve({ ...ROOM, ...args.data }),
          ),
        update: jest.fn().mockResolvedValue({ ...ROOM, name: 'renamed' }),
        delete: jest.fn().mockResolvedValue(ROOM),
      },
      participant: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      chatMessage: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      syncEvent: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      $transaction: jest
        .fn()
        .mockImplementation((fn: (tx: unknown) => unknown) => fn(db)),
    };
    database = db as unknown as DatabaseService;
    controller = new RoomsController(new RoomsService(database));
  });

  describe('PATCH /rooms/:code', () => {
    const patch = { name: 'renamed' } as UpdateRoomDto;

    it('refuses a caller who is not the room creator', async () => {
      // PATCH had NO ownership check at all: anyone with a code could
      // rename a room or repoint its video
      await expect(
        controller.updateRoom('CODE1', patch, INTRUDER.userId),
      ).rejects.toThrow(ForbiddenException);
      expect(db.room.update).not.toHaveBeenCalled();
    });

    it('lets the creator through, updating by id', async () => {
      await controller.updateRoom('CODE1', patch, OWNER.userId);
      expect(db.room.update).toHaveBeenCalledWith({
        where: { id: ROOM.id },
        data: patch,
      });
    });

    it('404s on an unknown code without leaking it as a 403', async () => {
      db.room.findUnique.mockResolvedValueOnce(null);
      await expect(
        controller.updateRoom('NOPE', patch, OWNER.userId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('DELETE /rooms/:code', () => {
    it('refuses a caller who is not the room creator', async () => {
      // the old signature took { userId } from the BODY and compared the
      // room's creator to that - self-attested ownership
      await expect(
        controller.deleteRoom('CODE1', INTRUDER.userId),
      ).rejects.toThrow(ForbiddenException);
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(db.room.delete).not.toHaveBeenCalled();
    });

    it('lets the creator through', async () => {
      const result = await controller.deleteRoom('CODE1', OWNER.userId);
      expect(db.room.delete).toHaveBeenCalledWith({ where: { id: ROOM.id } });
      expect(result.deletedRoom.code).toBe('CODE1');
    });
  });

  describe('POST /rooms', () => {
    it('creates the room owned by the token holder, not the body', async () => {
      // whitelist:true already strips a stray userId from the DTO; this
      // pins the other half - the controller reads identity from the guard
      const body = {
        name: 'movie night',
        userId: INTRUDER.userId,
      } as unknown as CreateRoomDto;

      await controller.createRoom(body, OWNER);

      expect(db.room.create).toHaveBeenCalledTimes(1);
      const calls = db.room.create.mock.calls as Array<
        [{ data: { creatorId: string } }]
      >;
      expect(calls[0][0].data.creatorId).toBe(OWNER.userId);
    });
  });

  describe('GET /rooms/user/:userId', () => {
    it("refuses to list another user's rooms", async () => {
      await expect(
        controller.getUserRooms(OWNER.userId, INTRUDER),
      ).rejects.toThrow(ForbiddenException);
      expect(db.room.findMany).not.toHaveBeenCalled();
    });

    it('serves the caller their own rooms', async () => {
      await controller.getUserRooms(OWNER.userId, OWNER);
      expect(db.room.findMany).toHaveBeenCalledTimes(1);
      const calls = db.room.findMany.mock.calls as unknown[][];
      expect(JSON.stringify(calls[0][0])).toContain(OWNER.userId);
    });

    it('GET /rooms/mine queries the token holder, with no id to disagree', async () => {
      await controller.getMyRooms(OWNER.userId);
      const calls = db.room.findMany.mock.calls as unknown[][];
      expect(JSON.stringify(calls[0][0])).toContain(OWNER.userId);
      expect(JSON.stringify(calls[0][0])).not.toContain(INTRUDER.userId);
    });
  });

  describe('which routes carry the guard', () => {
    // Reading the metadata @UseGuards writes is the only way to assert the
    // policy itself: a handler test passes just as happily on a route
    // anyone can reach.
    const guardsOn = (route: keyof RoomsController): unknown[] => {
      const handler = (
        RoomsController.prototype as unknown as Record<string, unknown>
      )[route];
      return (
        (Reflect.getMetadata(GUARDS_METADATA, handler as object) as
          | unknown[]
          | undefined) ?? []
      );
    };

    it.each([
      ['createRoom'],
      ['getMyRooms'],
      ['getUserRooms'],
      ['getRoom'],
      ['updateRoom'],
      ['deleteRoom'],
    ] as Array<[keyof RoomsController]>)(
      '%s requires a verified token',
      (route) => {
        expect(guardsOn(route)).toContain(JwtAuthGuard);
      },
    );

    it('declares the static GET routes before /rooms/:code', () => {
      // Nest matches in declaration order: if getRoom moved up, /rooms/mine
      // and /rooms/public would be looked up as room codes and 404. This is
      // the kind of break that only shows up in the browser.
      const order = Object.getOwnPropertyNames(RoomsController.prototype);
      expect(order.indexOf('getPublicRooms')).toBeLessThan(
        order.indexOf('getRoom'),
      );
      expect(order.indexOf('getMyRooms')).toBeLessThan(
        order.indexOf('getRoom'),
      );
    });

    it('getPublicRooms stays open - it is a public listing', () => {
      // documented decision, not an oversight: the browse page must render
      // for signed-out visitors
      expect(guardsOn('getPublicRooms')).toEqual([]);
    });
  });
});
