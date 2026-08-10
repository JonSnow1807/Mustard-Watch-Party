import {
  Controller,
  Get,
  Post,
  Body,
  HttpException,
  HttpStatus,
  Query,
  Req,
  Res,
  UseGuards,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { CurrentUser } from './current-user.decorator';
import {
  GoogleAuthError,
  GoogleOAuthService,
  OAUTH_COOKIE,
  OAUTH_COOKIE_PATH,
} from './google/google-oauth.service';
import { readCookie } from './google/cookies';
import { Interval } from '@nestjs/schedule';
import { RateBucket, clientIp } from './rate-bucket';

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private authService: AuthService,
    private google: GoogleOAuthService,
  ) {}

  /** 10 guests per IP per hour, refilling steadily rather than all at once. */
  private readonly guestBucket = new RateBucket(10, 10 / 3600);

  /**
   * A cap on guest creation for the WHOLE instance, on top of the per-caller
   * one.
   *
   * The per-caller bucket is only as good as our ability to tell callers
   * apart, and in production that turned out not to work: the same test that
   * held locally (ten allowed, then 429) let twenty-two through against the
   * deployed service, with and without a forged header. Whatever key the
   * proxy chain is yielding, it is not stable per caller.
   *
   * This bucket has no key, so nothing a caller sends can move them out of
   * it. It is deliberately loose - a real room of people joining a film must
   * not trip it - and exists to bound the damage while the per-caller key is
   * diagnosed rather than guessed at again.
   */
  private readonly guestGlobalBucket = new RateBucket(300, 300 / 3600);

  /** Logged once, so the next fix is based on what the proxy actually sends. */
  private loggedForwardShape = false;

  /**
   * Nothing swept the bucket map, so it retained a key per distinct caller
   * forever - which turns a rate limiter into a slow memory leak that an
   * attacker controls the size of. Hourly, off the request path, because
   * scanning the map on every request to defend against growth would be
   * paying the cost the growth was going to charge anyway.
   */
  @Interval(3_600_000)
  sweepRateBuckets(): void {
    this.guestBucket.sweep(Date.now());
    this.guestGlobalBucket.sweep(Date.now());
  }

  @Post('register')
  async register(
    @Body() registerDto: { username: string; email: string; password: string },
  ) {
    return await this.authService.register(
      registerDto.username,
      registerDto.email,
      registerDto.password,
    );
  }

  @Post('login')
  async login(@Body() loginDto: { username: string; password: string }) {
    return await this.authService.login(loginDto.username, loginDto.password);
  }

  /**
   * Sign in as a guest.
   *
   * Rate limited per IP, unlike register: register is at least a form
   * someone has to fill in, while this is one unauthenticated request that
   * creates a row, so an unbounded version is a way to fill the users table
   * from a shell loop. The window is generous enough that a household behind
   * one address can all join the same film.
   */
  @Post('guest')
  async guest(@Req() req: Request) {
    const now = Date.now();

    if (!this.loggedForwardShape) {
      this.loggedForwardShape = true;
      // The SHAPE, not the addresses: how many hops arrive and what the
      // socket peer looks like is all that is needed to key correctly, and
      // logging people's IPs to answer it would be a poor trade.
      const xff = req.headers['x-forwarded-for'];
      const raw = Array.isArray(xff) ? xff.join(',') : (xff ?? '');
      this.logger.log(
        `guest key diagnostic: xff hops=${raw ? raw.split(',').length : 0} ` +
          `headerPresent=${Boolean(xff)} peerIsPrivate=${/^(10\.|127\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|::1|::ffff:10\.)/.test(req.socket?.remoteAddress ?? '')} ` +
          `otherForwardHeaders=${
            Object.keys(req.headers)
              .filter(
                (h) =>
                  h.includes('forward') ||
                  h.includes('real-ip') ||
                  h.includes('client-ip'),
              )
              .join('|') || 'none'
          }`,
      );
    }

    if (!this.guestGlobalBucket.take('all', now)) {
      throw new HttpException(
        'Too many guests right now - try again shortly',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const ip = clientIp(req);
    if (!this.guestBucket.take(ip, now)) {
      throw new HttpException(
        'Too many guests from this connection - try again shortly',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return await this.authService.createGuest();
  }

  /**
   * What this deployment can actually sign you in with. The frontend renders
   * its buttons from this rather than from its own build-time flag, so an
   * install without Google credentials simply does not offer the button -
   * and no build has to be rebuilt to turn the provider on.
   */
  @Get('providers')
  providers() {
    return { google: this.google.enabled };
  }

  /**
   * Who the bearer token says you are. The OAuth callback hands the browser
   * a token and nothing else, so there has to be one place to exchange it
   * for the profile the UI shows.
   */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser('userId') userId: string) {
    return await this.authService.me(userId);
  }

  /** Step one: bounce to Google, carrying a sealed CSRF/PKCE cookie. */
  @Get('google/start')
  start(
    @Query('returnTo') returnTo: string | undefined,
    @Res() res: Response,
  ): void {
    const { authUrl, cookie } = this.google.start(returnTo);
    res.cookie(OAUTH_COOKIE, cookie, this.cookieOptions());
    res.redirect(authUrl);
  }

  /**
   * Step two: Google sends the browser back here. Everything ends in a
   * redirect to the frontend - a person who lands on this URL is mid
   * sign-in, and an API error body would strand them on a blank page at an
   * origin they have never seen.
   */
  @Get('google/callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // 404 before anything else, exactly like /start. Falling into the
    // redirect below when the provider is off would be wrong twice: it
    // logs a disabled route as an unexpected error on every stray hit,
    // and - when the provider is off BECAUSE the origin is loopback - it
    // would redirect the visitor to that loopback address, which is the
    // hazard the guard exists to prevent. No flow was started, so there
    // is no one mid sign-in to land gently.
    this.google.assertEnabled();

    // Single use, cleared before anything can fail: a replayed cookie is a
    // replayed flow.
    res.clearCookie(OAUTH_COOKIE, this.cookieOptions());

    try {
      const { identity, returnTo } = await this.google.verifyCallback({
        code,
        state,
        error,
        cookie: readCookie(req.headers.cookie, OAUTH_COOKIE),
      });

      const user = await this.authService.signInWithGoogle(identity);

      // The token rides in the FRAGMENT, never the query string: fragments
      // are not sent to servers, do not reach access logs, and are not
      // forwarded in a Referer header.
      const params = new URLSearchParams({ token: user.token });
      if (returnTo) params.set('to', returnTo);
      res.redirect(this.google.callbackRedirect(params.toString()));
    } catch (err) {
      const failure =
        err instanceof GoogleAuthError ? err.code : ('exchange' as const);
      if (!(err instanceof GoogleAuthError)) {
        this.logger.error(
          `google callback failed: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      }
      res.redirect(
        this.google.callbackRedirect(
          new URLSearchParams({ error: failure }).toString(),
        ),
      );
    }
  }

  private cookieOptions() {
    return {
      httpOnly: true,
      // Lax, not Strict: the browser arrives at the callback from
      // accounts.google.com, and Strict would withhold the very cookie the
      // callback exists to check. Lax still covers top-level GET navigation,
      // which is exactly this.
      sameSite: 'lax' as const,
      secure: this.google.redirectUri.startsWith('https://'),
      path: OAUTH_COOKIE_PATH,
      maxAge: 10 * 60 * 1000,
    };
  }
}
