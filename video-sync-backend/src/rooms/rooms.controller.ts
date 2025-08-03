import { Controller, Get, Post, Body, Param, Patch, Query, Delete, HttpException, HttpStatus } from '@nestjs/common';
import { RoomsService } from './rooms.service';

@Controller('rooms')
export class RoomsController {
  constructor(private roomsService: RoomsService) {}

  @Post()
  async createRoom(
    @Body() createRoomDto: { 
      name: string; 
      videoUrl?: string; 
      userId: string;
      isPublic?: boolean;
      description?: string;
      tags?: string[];
    },
  ) {
    return await this.roomsService.createRoom(
      createRoomDto.userId,
      createRoomDto.name,
      createRoomDto.videoUrl,
      createRoomDto.isPublic,
      createRoomDto.description,
      createRoomDto.tags,
    );
  }
  
  // IMPORTANT: This route must come BEFORE the :code route
  @Get('public')
  async getPublicRooms(@Query('filter') filter?: string) {
    return await this.roomsService.getPublicRooms(filter);
  }

  @Get('user/:userId')
  async getUserRooms(@Param('userId') userId: string) {
    return await this.roomsService.getUserRooms(userId);
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

  @Delete(':code')
  async deleteRoom(
    @Param('code') code: string,
    @Body() deleteRoomDto: { userId: string },
  ) {
    return await this.roomsService.deleteRoom(code, deleteRoomDto.userId);
  }
}