import { Injectable } from '@nestjs/common';

export interface VoiceMember {
  userId: string;
  username: string;
}

/**
 * Who is on the voice call, per room.
 *
 * A service rather than state inside VoiceGateway because two gateways need
 * it and they cannot inject each other: VoiceGateway already depends on
 * SyncGateway to reach the main namespace, so SyncGateway asking VoiceGateway
 * for the roster would close the loop. This is the shared fact both of them
 * read, and it belongs to neither.
 *
 * In-memory and per-instance, like the voice peer map it mirrors. Voice is
 * already single-instance in practice - the WebRTC signalling is relayed
 * through whichever server holds both sockets - so a roster that does not
 * span instances tells no lie that voice itself does not already tell.
 */
@Injectable()
export class VoiceRosterService {
  private readonly byRoom = new Map<string, Map<string, VoiceMember>>();

  join(roomCode: string, socketId: string, member: VoiceMember): void {
    const room = this.byRoom.get(roomCode) ?? new Map<string, VoiceMember>();
    room.set(socketId, member);
    this.byRoom.set(roomCode, room);
  }

  /** Returns the room the socket was in, so the caller can announce it. */
  leave(socketId: string): string | null {
    for (const [roomCode, room] of this.byRoom) {
      if (!room.delete(socketId)) continue;
      if (room.size === 0) this.byRoom.delete(roomCode);
      return roomCode;
    }
    return null;
  }

  /**
   * De-duplicated by user, not by socket: the same person with the room open
   * in two tabs is one voice on the call, and listing them twice would read
   * as a bug to everyone looking at it.
   */
  list(roomCode: string): VoiceMember[] {
    const room = this.byRoom.get(roomCode);
    if (!room) return [];
    const byUser = new Map<string, VoiceMember>();
    for (const member of room.values()) byUser.set(member.userId, member);
    return Array.from(byUser.values());
  }
}
