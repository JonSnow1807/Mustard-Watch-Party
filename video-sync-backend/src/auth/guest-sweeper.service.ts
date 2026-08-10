import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DatabaseService } from '../database/database.service';

/** How long a guest account outlives its last sign of life. */
const GUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class GuestSweeperService {
  private readonly logger = new Logger(GuestSweeperService.name);

  constructor(private readonly database: DatabaseService) {}

  /**
   * Delete guest accounts nobody is using any more.
   *
   * Guests are cheap to make by design, so without this the users table
   * grows forever with rows that will never be signed into again - their
   * token expires in 12 hours and there is no password to get back in with.
   *
   * A week, not a day: a guest who was in a room yesterday should still
   * appear in its participant list and its chat history tomorrow. Deleting
   * them sooner would blank names out of conversations people are still
   * reading.
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async sweep(now: number = Date.now()): Promise<number> {
    const cutoff = new Date(now - GUEST_TTL_MS);
    try {
      // Only guests with no trace left. A guest who created a room or is
      // still an active participant is load-bearing for someone else's
      // screen - the FK would refuse the delete anyway, and catching that
      // as an error every night is worse than not asking.
      const { count } = await this.database.user.deleteMany({
        where: {
          isGuest: true,
          createdAt: { lt: cutoff },
          roomsCreated: { none: {} },
          participants: { none: {} },
          chatMessages: { none: {} },
        },
      });
      if (count > 0) this.logger.log(`swept ${count} expired guest account(s)`);
      return count;
    } catch (err) {
      // A failed sweep is not worth taking the process down for: the rows
      // are inert, and the next run will find them again.
      this.logger.warn(
        `guest sweep failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
      return 0;
    }
  }
}
