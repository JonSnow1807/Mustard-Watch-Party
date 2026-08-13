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
import { JwtService } from '@nestjs/jwt';
import { RevocationService } from './revocation.service';
import type { TokenPayload } from './token-payload';
import { CurrentUser } from './current-user.decorator';
import {
  GoogleAuthError,
  GoogleOAuthService,
  OAUTH_COOKIE,
  OAUTH_COOKIE_PATH,
} from './google/google-oauth.service';
import { readCookie } from './google/cookies';
import { Interval } from '@nestjs/schedule';
import { RateBucket, clientIp, isInfrastructureAddress } from './rate-bucket';

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private authService: AuthService,
    private google: GoogleOAuthService,
    private readonly revocations: RevocationService,
    private readonly jwt: JwtService,
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
      // Which hops look like infrastructure and which look like a person,
      // in order. This is the fact that distinguishes the two cases: a
      // trailing `non-infra` means the platform's own last hop is public,
      // and everyone behind it is being keyed together.
      const hops = raw
        ? raw
            .split(',')
            .map((h) => h.trim())
            .filter(Boolean)
            .map((h) => (isInfrastructureAddress(h) ? 'infra' : 'caller'))
            .join('>')
        : 'none';
      this.logger.log(
        `guest key diagnostic: xff shape=${hops} ` +
          `headerPresent=${Boolean(xff)} ` +
          `peerIsInfra=${isInfrastructureAddress(req.socket?.remoteAddress ?? '')} ` +
          `otherForwardHeaders=${
            Object.keys(req.headers)
              // 'connecting-ip' matters most and the first version of this
              // filter missed it: cf-connecting-ip contains neither
              // 'client-ip' nor 'forward', so the header carrying the actual
              // answer was invisible to the diagnostic looking for it.
              .filter((h) =>
                /forward|real-ip|client-ip|connecting-ip|cf-/.test(h),
              )
              .join('|') || 'none'
          }`,
      );
    }

    // Decide on both limits BEFORE spending from either. Asking one and
    // then the other means the first is charged for a request the second
    // refuses - so during a flood every honest caller would burn their own
    // allowance on requests that were never served.
    const ip = clientIp(req);
    if (!this.guestBucket.peek(ip, now)) {
      throw new HttpException(
        'Too many guests from this connection - try again shortly',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (!this.guestGlobalBucket.peek('all', now)) {
      throw new HttpException(
        'Too many guests right now - try again shortly',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    this.guestBucket.take(ip, now);
    this.guestGlobalBucket.take('all', now);

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
   * Keep the account you have been using.
   *
   * A guest session is a real row with real history hanging off it - chat
   * messages, participant records - and it expires in twelve hours with no
   * password to get back in with. This is the door out of that, and it
   * updates the row in place rather than making a new one, so the name on
   * last night's messages stays the name of the person who wrote them.
   *
   * Guarded, so the caller is whoever the token says; the service then
   * checks the ROW is still a guest, because the token cannot be trusted to
   * report that about itself.
   */
  @Post('claim')
  @UseGuards(JwtAuthGuard)
  async claim(
    @CurrentUser('userId') userId: string,
    @Body() dto: { username: string; email: string; password: string },
  ) {
    return await this.authService.claimGuestAccount(
      userId,
      dto.username,
      dto.email,
      dto.password,
    );
  }

  /**
   * Stop trusting the token this request arrived on.
   *
   * Sign-out used to be a client-side event: the browser dropped the token
   * and the server never heard about it. Anyone holding a copy - a shared
   * machine, a proxy log, a screenshot of a URL from before the fragment
   * fix - kept a working session for the rest of its twelve hours.
   *
   * Reads the token again here rather than trusting the guard's decoded
   * user, because the jti and exp are needed and the guard only attaches
   * identity. Same token, same secret, verified twice - cheap.
   */
  @Post('logout')
  @UseGuards(JwtAuthGuard)
  async logout(@Req() req: Request): Promise<{ revoked: boolean }> {
    const payload = this.decodeOwnToken(req);
    if (!payload?.jti || !payload.sub) {
      // A token from before jti existed. It cannot be revoked individually,
      // and saying so is better than reporting a success that did nothing.
      return { revoked: false };
    }
    await this.revocations.revokeToken(
      payload.jti,
      payload.sub,
      // exp is in SECONDS; the record only has to outlive the token itself
      new Date((payload.exp ?? Math.floor(Date.now() / 1000) + 43200) * 1000),
    );
    return { revoked: true };
  }

  /**
   * Stop trusting everything this account holds, everywhere.
   *
   * The answer to "my token leaked" or "I left myself signed in somewhere I
   * cannot get back to". One integer moves and every session that account
   * has - phone, laptop, a socket someone left open - stops at once.
   */
  @Post('logout-all')
  @UseGuards(JwtAuthGuard)
  async logoutAll(
    @CurrentUser('userId') userId: string,
  ): Promise<{ version: number }> {
    const version = await this.revocations.revokeAllForUser(userId);
    return { version };
  }

  /** The raw token off the request, for the claims the guard does not keep. */
  private decodeOwnToken(req: Request): TokenPayload | null {
    const header = req.headers?.authorization;
    const token = header?.trim().split(/\s+/)[1];
    if (!token) return null;
    try {
      return this.jwt.verify<TokenPayload>(token);
    } catch {
      return null;
    }
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

  /**
   * Step one for a guest ATTACHING Google to the account they are already
   * using, rather than signing in.
   *
   * A POST with a bearer token, not a GET the browser can navigate to,
   * because a navigation cannot carry an Authorization header - and the
   * alternative, putting the token in the query string, writes a credential
   * into access logs and Referer headers. So the browser asks for the URL
   * here and navigates to it itself.
   *
   * The id sealed into the state is the one the guard verified from the
   * token. Nothing the caller says about who they are is used: a caller who
   * could nominate the account would be able to attach their Google identity
   * to someone else's.
   */
  @Post('google/link-start')
  @UseGuards(JwtAuthGuard)
  linkStart(
    @CurrentUser('userId') userId: string,
    @Body() body: { returnTo?: string },
    @Res({ passthrough: true }) res: Response,
  ): { authUrl: string } {
    const { authUrl, cookie } = this.google.start(
      body?.returnTo,
      Date.now(),
      userId,
    );
    res.cookie(OAUTH_COOKIE, cookie, this.cookieOptions());
    return { authUrl };
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
      const { identity, returnTo, linkUserId } =
        await this.google.verifyCallback({
          code,
          state,
          error,
          cookie: readCookie(req.headers.cookie, OAUTH_COOKIE),
        });

      // Two flows come back through this one door, and which it is was
      // decided at /link-start by a token we verified - not by anything in
      // the request that is arriving now.
      const user = linkUserId
        ? await this.authService.linkGoogleToGuest(linkUserId, identity)
        : await this.authService.signInWithGoogle(identity);

      // The token rides in the FRAGMENT, never the query string: fragments
      // are not sent to servers, do not reach access logs, and are not
      // forwarded in a Referer header.
      const params = new URLSearchParams({ token: user.token });
      if (returnTo) params.set('to', returnTo);
      res.redirect(this.google.callbackRedirect(params.toString()));
    } catch (err) {
      // Linking has its own ways to fail that are nobody's bug: the Google
      // account is already attached to a real account, or its address is.
      // Reporting those as 'exchange' would log them as unexpected errors
      // and tell the person "sign-in failed", when what happened is
      // recoverable and has a specific instruction attached to it.
      //
      // Recognised by the CODE the service attached, not by the exception
      // class. The first version tested `instanceof ConflictException` - which
      // is ALSO what createGoogleUser throws when it runs out of username
      // attempts, on a plain sign-in with nothing to do with linking. That one
      // carries a string, so it has no code, and the person would have been
      // told "your guest session is untouched" when they had no guest session,
      // while the error log that would have shown a real allocation anomaly
      // was skipped.
      const payload =
        err instanceof HttpException
          ? (err.getResponse() as { code?: unknown })
          : undefined;
      const linkCode =
        typeof payload?.code === 'string' && payload.code.startsWith('link_')
          ? payload.code
          : undefined;

      const failure =
        linkCode ??
        (err instanceof GoogleAuthError ? err.code : ('exchange' as const));

      if (!linkCode && !(err instanceof GoogleAuthError)) {
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
