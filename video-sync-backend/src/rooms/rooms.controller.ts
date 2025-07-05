import { Controller, Get, Post, Body, Param, Patch } from '@nestjs/common';
import { RoomsService } from './rooms.service';

@Controller('rooms')
export class RoomsController {
  constructor(private roomsService: RoomsService) {}

  @Post()
  async createRoom(
    @Body() createRoomDto: { name: string; videoUrl?: string; userId: string },
  ) {
    return await this.roomsService.createRoom(
      createRoomDto.userId,
      createRoomDto.name,
      createRoomDto.videoUrl,
    );
  }

  @Get(':code')
  async getRoom(@Param('code') code: string) {
    return await this.roomsService.getRoomByCode(code);
  }

  @Patch(':id')
  async updateRoom(
    @Param('id') id: string,
    @Body() updateRoomDto: { name?: string; videoUrl?: string },
  ) {
    return await this.roomsService.updateRoom(id, updateRoomDto);
  }

  @Get('user/:userId')
  async getUserRooms(@Param('userId') userId: string) {
    return await this.roomsService.getUserRooms(userId);
  }
}
