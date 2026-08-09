import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Patch,
  Query,
  Delete,
  ForbiddenException,
  UseGuards,
} from '@nestjs/common';
import { RoomsService } from './rooms.service';
import { CreateRoomDto } from './dto/create-room.dto';
import { UpdateRoomDto } from './dto/update-room.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthedUser } from '../auth/token-payload';

/**
 * Authorization policy for this controller, stated once:
 *
 *   POST   /rooms             auth - the creator is the caller, full stop
 *   GET    /rooms/public      OPEN  - a public listing is public
 *   GET    /rooms/mine        auth - the caller's own rooms
 *   GET    /rooms/user/:id    auth + :id must BE the caller
 *   GET    /rooms/:code       auth, but NOT membership. Deliberate: a room
 *                             code is a share link, and a signed-in user
 *                             who was handed one must be able to look the
 *                             room up before joining it. Requiring auth
 *                             still ends anonymous enumeration of rooms
 *                             (and of their creator/participant lists) by
 *                             anyone who guesses a code.
 *   PATCH  /rooms/:code       auth + creator only
 *   DELETE /rooms/:code       auth + creator only
 *
 * The guard is listed per route rather than on the class so that leaving a
 * route open is a visible decision in the diff, not an omission.
 *
 * Identity comes from the bearer token via @CurrentUser(). No handler here
 * reads a userId out of a body or trusts one from a path.
 */
@Controller('rooms')
export class RoomsController {
  constructor(private roomsService: RoomsService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  async createRoom(
    @Body() createRoomDto: CreateRoomDto,
    @CurrentUser() user: AuthedUser,
  ) {
    return await this.roomsService.createRoom(
      user.userId,
      createRoomDto.name,
      createRoomDto.videoUrl,
      createRoomDto.isPublic,
      createRoomDto.description,
      createRoomDto.tags,
      createRoomDto.allowGuestControl,
    );
  }

  // The one unauthenticated route: the browse/discovery listing.
  // IMPORTANT: this route must come BEFORE the :code route.
  @Get('public')
  async getPublicRooms(@Query('filter') filter?: string) {
    return await this.roomsService.getPublicRooms(filter);
  }

  // Same listing, addressed by nobody: with no id in the path there is
  // nothing that can disagree with the token, so there is nothing to
  // forbid. This is what the web client calls. Like 'public', it MUST stay
  // above @Get(':code') or 'mine' gets read as a room code.
  @Get('mine')
  @UseGuards(JwtAuthGuard)
  async getMyRooms(@CurrentUser('userId') userId: string) {
    return await this.roomsService.getUserRooms(userId);
  }

  @Get('user/:userId')
  @UseGuards(JwtAuthGuard)
  async getUserRooms(
    @Param('userId') userId: string,
    @CurrentUser() user: AuthedUser,
  ) {
    // The path param is now redundant with the token, and redundancy that
    // disagrees is an attempt: reject it rather than quietly serving the
    // caller their own rooms under someone else's id (which would hide a
    // broken client) or someone else's rooms (which is the bug we came for).
    if (userId !== user.userId) {
      throw new ForbiddenException('You can only list your own rooms');
    }
    return await this.roomsService.getUserRooms(user.userId);
  }

  @Get(':code')
  @UseGuards(JwtAuthGuard)
  async getRoom(@Param('code') code: string) {
    // Auth, not membership - see the policy note above: join-by-link works.
    return await this.roomsService.getRoomByCode(code);
  }

  @Patch(':code')
  @UseGuards(JwtAuthGuard)
  async updateRoom(
    @Param('code') code: string,
    @Body() updateRoomDto: UpdateRoomDto,
    @CurrentUser('userId') userId: string,
  ) {
    return await this.roomsService.updateRoomByCode(
      code,
      userId,
      updateRoomDto,
    );
  }

  @Delete(':code')
  @UseGuards(JwtAuthGuard)
  async deleteRoom(
    @Param('code') code: string,
    @CurrentUser('userId') userId: string,
  ) {
    // No body: the old { userId } was the caller telling us who they were,
    // and deleteRoom then compared the room's creator against that.
    return await this.roomsService.deleteRoom(code, userId);
  }
}
