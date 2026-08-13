import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import {
  CodeChallengeMethod,
  OAuth2Client,
  type TokenPayload as GoogleTokenPayload,
} from 'google-auth-library';
import {
  OAuthStatePayload,
  openState,
  randomToken,
  safeEqual,
  sealState,
} from './oauth-state';

/** How long a half-finished sign-in stays resumable. */
const FLOW_TTL_MS = 10 * 60 * 1000;

/**
 * Ceiling on any single call out to Google. Someone is watching a redirect
 * resolve, so failing at 10s and saying so beats hanging until they give up.
 */
const GOOGLE_HTTP_TIMEOUT_MS = 10_000;

/** The cookie is only ever read by the callback route, so scope it there. */
export const OAUTH_COOKIE = 'mw_oauth';
export const OAUTH_COOKIE_PATH = '/api/auth/google';

/**
 * Everything that can go wrong, as a small closed set. These strings reach
 * the browser in a URL fragment, so they are codes rather than sentences:
 * the frontend owns the wording, and a code cannot leak internals.
 */
export type GoogleAuthFailure =
  | 'state' // no cookie, tampered cookie, expired flow, or state mismatch
  | 'denied' // the person declined at Google's consent screen
  | 'unverified' // Google will not vouch for the email on the account
  | 'email_taken' // a local password account already owns that email
  | 'exchange'; // Google rejected the code, or we could not reach it

export class GoogleAuthError extends Error {
  constructor(readonly code: GoogleAuthFailure) {
    super(code);
    this.name = 'GoogleAuthError';
  }
}

export interface GoogleIdentity {
  subject: string;
  email: string;
  emailVerified: boolean;
  name?: string;
}

@Injectable()
export class GoogleOAuthService {
  private readonly logger = new Logger(GoogleOAuthService.name);

  constructor(private readonly config: ConfigService) {}

  private get clientId(): string {
    return this.config.get<string>('google.clientId') || '';
  }

  private get clientSecret(): string {
    return this.config.get<string>('google.clientSecret') || '';
  }

  private get secret(): string {
    return this.config.get<string>('jwt.secret') || '';
  }

  /**
   * A provider we cannot actually complete is a provider we do not offer.
   * The frontend reads this through /auth/providers instead of carrying its
   * own build-time flag, so the button and the route can never disagree.
   */
  get enabled(): boolean {
    // frontendUrl is part of "can complete", not a detail: without it
    // callbackRedirect builds a RELATIVE '/auth/callback#token=...', which
    // sends the browser - carrying a freshly minted token - to a 404 on the
    // API's own origin. Credentials alone are not enough to offer a door.
    if (!this.clientId || !this.clientSecret || !this.frontendUrl) return false;

    // FRONTEND_URL is optional everywhere else and falls back to localhost,
    // which is a fine default for a laptop and a trap in production: the
    // provider would look enabled and then hand a real person's token to
    // http://localhost:3001, i.e. to whatever happens to be listening on
    // THEIR machine. A loopback origin outside a local environment means
    // the variable was forgotten, so the provider stays off and password
    // sign-in carries on - the same fail-closed rule configuration.ts
    // applies to secrets.
    if (!this.isLocalEnv && isLoopback(this.frontendUrl)) {
      this.warnLoopbackOnce();
      return false;
    }
    return true;
  }

  private get isLocalEnv(): boolean {
    return this.config.get<boolean>('isLocalEnv') ?? false;
  }

  private warnedLoopback = false;

  /** Once, not per /auth/providers call - this is a deploy fault, not traffic. */
  private warnLoopbackOnce(): void {
    if (this.warnedLoopback) return;
    this.warnedLoopback = true;
    this.logger.warn(
      `Google sign-in is configured but FRONTEND_URL resolves to ${this.frontendUrl}; ` +
        'refusing to offer it rather than redirecting people to a loopback address.',
    );
  }

  /** Guard for the routes: 404 rather than 500 when unconfigured. */
  assertEnabled(): void {
    if (!this.enabled) {
      throw new NotFoundException('Google sign-in is not configured');
    }
  }

  /**
   * Must match the Authorised redirect URI in the Google console
   * character for character, which is why it is built from an explicit
   * PUBLIC_API_URL rather than from the incoming request's Host header.
   */
  get redirectUri(): string {
    const base = this.config.get<string>('publicApiUrl') || '';
    return `${base}/api/auth/google/callback`;
  }

  /** First entry of the CORS allowlist: the canonical site, not a preview. */
  get frontendUrl(): string {
    const origins = this.config.get<string>('cors.origin') || '';
    return origins.split(',')[0].trim().replace(/\/+$/, '');
  }

  private cachedClient?: OAuth2Client;

  /**
   * One client, reused. `verifyIdToken` caches Google's signing certificates
   * on the instance, so a fresh client per call would refetch the JWKS on
   * every single sign-in - and the callback alone would do it twice.
   */
  private client(): OAuth2Client {
    this.cachedClient ??= new OAuth2Client({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      redirectUri: this.redirectUri,
      // Gaxios has NO timeout by default, so a Google endpoint that accepts
      // the connection and then goes quiet would hold this request open
      // indefinitely - and it holds a socket and a request slot while it
      // waits. Set on the transporter so it covers the token exchange, the
      // ID token verification, and the certificate fetch inside it.
      transporterOptions: { timeout: GOOGLE_HTTP_TIMEOUT_MS },
    });
    return this.cachedClient;
  }

  /**
   * Step one: mint the CSRF/PKCE pair, seal it into a cookie, and hand back
   * the URL to bounce the browser to. Nothing is persisted server-side - the
   * cookie IS the session for this flow, which is what lets any instance
   * behind the load balancer finish a flow another instance started.
   */
  start(
    returnTo: string | undefined,
    now: number = Date.now(),
    linkUserId?: string,
    purpose?: 'link-guest' | 'link-full' | 'reauth',
  ) {
    this.assertEnabled();

    const state = randomToken();
    const codeVerifier = randomToken();
    const codeChallenge = createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    const payload: OAuthStatePayload = {
      state,
      codeVerifier,
      returnTo: safeReturnTo(returnTo),
      linkUserId,
      purpose,
      expiresAt: now + FLOW_TTL_MS,
    };

    const authUrl = this.client().generateAuthUrl({
      scope: ['openid', 'email', 'profile'],
      state,
      code_challenge_method: CodeChallengeMethod.S256,
      code_challenge: codeChallenge,
      // online: we want an identity, not offline access to anything of
      // theirs, so we never ask for a refresh token we would then have to
      // store and protect.
      access_type: 'online',
      // Someone signed into several Google accounts should be asked which
      // one they mean rather than silently getting the browser default.
      prompt: 'select_account',
    });

    return { authUrl, cookie: sealState(payload, this.secret) };
  }

  /**
   * Step two: prove the callback belongs to the flow we started, trade the
   * code for an ID token, and return the identity Google asserts.
   */
  async verifyCallback(params: {
    code?: string;
    state?: string;
    error?: string;
    cookie?: string;
    now?: number;
  }): Promise<{
    identity: GoogleIdentity;
    returnTo?: string;
    /** set when this flow acts on an existing account rather than signing in */
    linkUserId?: string;
    purpose?: 'link-guest' | 'link-full' | 'reauth';
  }> {
    this.assertEnabled();

    if (params.error) throw new GoogleAuthError('denied');

    const opened = openState(
      params.cookie,
      this.secret,
      params.now ?? Date.now(),
    );
    // One check for every way the round trip can fail to be ours: no cookie,
    // a forged cookie, an expired flow, or a state that does not match the
    // one we issued. An attacker who can supply a `code` but not the paired
    // cookie stops here - that is the login-CSRF defence.
    if (!opened || !params.state || !safeEqual(params.state, opened.state)) {
      throw new GoogleAuthError('state');
    }
    if (!params.code) throw new GoogleAuthError('exchange');

    let idToken: string | undefined;
    try {
      const { tokens } = await this.client().getToken({
        code: params.code,
        codeVerifier: opened.codeVerifier,
        redirect_uri: this.redirectUri,
      });
      idToken = tokens.id_token ?? undefined;
    } catch (err) {
      this.logger.warn(
        `google token exchange failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
      throw new GoogleAuthError('exchange');
    }
    if (!idToken) throw new GoogleAuthError('exchange');

    // Verified even though it arrived over TLS straight from Google's token
    // endpoint: signature, issuer, audience and expiry are all checked here,
    // so a future refactor that starts accepting an ID token from somewhere
    // less trustworthy does not silently become a forgery hole.
    let payload: GoogleTokenPayload | undefined;
    try {
      const ticket = await this.client().verifyIdToken({
        idToken,
        audience: this.clientId,
      });
      payload = ticket.getPayload();
    } catch (err) {
      this.logger.warn(
        `google id_token rejected: ${err instanceof Error ? err.message : 'unknown'}`,
      );
      throw new GoogleAuthError('exchange');
    }

    if (!payload?.sub || !payload.email) throw new GoogleAuthError('exchange');
    // No verified email, no account. We never link by email, so an
    // unverified address cannot take over anything - but it could still
    // squat an address its owner has not registered yet, and Google
    // telling us "yes, this is theirs" is free.
    if (!payload.email_verified) throw new GoogleAuthError('unverified');

    return {
      identity: {
        subject: payload.sub,
        email: payload.email,
        emailVerified: true,
        name: payload.name,
      },
      returnTo: opened.returnTo,
      linkUserId: opened.linkUserId,
      purpose: opened.purpose,
    };
  }

  /** Where to send the browser when it comes back, token or error in hand. */
  callbackRedirect(fragment: string): string {
    return `${this.frontendUrl}/auth/callback#${fragment}`;
  }
}

/**
 * An origin that only means anything on the machine it is typed on.
 * Matched on the host alone, so a port or a scheme cannot smuggle one past.
 */
export const isLoopback = (origin: string): boolean => {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    // not a parseable origin: not something we can safely send anyone to
    return true;
  }
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.localhost') ||
    /^127\./.test(host)
  );
};

/**
 * Only a path on our own site. A `returnTo` is attacker-supplied by
 * construction (it rides in a link), and echoing it into a redirect without
 * this check is an open redirect - the classic way a phishing link borrows
 * a real domain's credibility. Protocol-relative '//evil.com' is a URL with
 * a host, so it must die here too.
 */
export const safeReturnTo = (value?: string): string | undefined => {
  if (!value) return undefined;
  if (!value.startsWith('/') || value.startsWith('//')) return undefined;
  // Control characters by code rather than by regex: a raw \r\n in a value
  // that ends up in a Location header is header injection, and the escape
  // sequences for that range are exactly what a regex linter flags.
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return undefined;
  }
  if (value.includes('\\')) return undefined;
  return value.slice(0, 512);
};
