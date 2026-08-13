import React, { useCallback, useEffect, useRef, useState } from 'react';
import styled from '@emotion/styled';
import { useAuth } from '../contexts/AuthContext';
import { apiService } from '../services/api';
import { toast } from 'react-hot-toast';
import { button, card, color, font, input, sectionLabel } from '../theme';
import { IconGoogle } from './Icons';

// The first account surface this app has had. Until now every account
// operation lived wherever it could squat - claiming on the home page,
// sign-out-everywhere as an endpoint with no button at all - because there
// was nowhere for them to live. Opened by clicking your own name in the
// top bar.

const Overlay = styled.div`
  position: fixed;
  inset: 0;
  background: rgba(8, 7, 5, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  z-index: 1000;
`;

const Card = styled.div`
  ${card}
  padding: 24px;
  width: 100%;
  max-width: 440px;
  max-height: calc(100vh - 48px);
  overflow-y: auto;
`;

const Title = styled.h3`
  margin: 0 0 4px;
  font-family: ${font.display};
  font-weight: 600;
  font-size: 18px;
  color: ${color.text};
`;

const Address = styled.p`
  margin: 0 0 20px;
  font-family: ${font.body};
  font-size: 13px;
  color: ${color.dim};
`;

const Section = styled.div`
  border-top: 1px solid ${color.line};
  padding: 16px 0;
`;

const SectionTitle = styled.h4`
  ${sectionLabel}
  margin: 0 0 10px;
`;

const Row = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
`;

const RowText = styled.p`
  margin: 0;
  font-family: ${font.body};
  font-size: 13px;
  line-height: 1.5;
  color: ${color.dim};
  flex: 1;
`;

const Field = styled.label`
  display: block;
  margin: 10px 0;
`;

const FieldLabel = styled.span`
  ${sectionLabel}
  display: block;
  margin-bottom: 6px;
`;

const FieldInput = styled.input`
  ${input}
  width: 100%;
`;

const Secondary = styled.button`
  ${button.secondary}
  white-space: nowrap;
`;

const Primary = styled.button`
  ${button.primary}
`;

const Danger = styled.button`
  ${button.danger}
  white-space: nowrap;
`;

const Buttons = styled.div`
  display: flex;
  gap: 12px;
  justify-content: flex-end;
  margin-top: 12px;
`;

interface Profile {
  hasPassword: boolean;
  googleLinked: boolean;
  isGuest: boolean;
}

/**
 * Account & security: what sign-in methods this account has, and the
 * operations on them. Every mutating path here re-authenticates - the
 * bearer token alone opens nothing, because the scenario these features
 * exist for is precisely "someone else is holding a copy of the token".
 */
export const AccountDialog: React.FC<{ onClose: () => void }> = ({
  onClose,
}) => {
  const { user, logout, adoptToken } = useAuth();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [elevated, setElevated] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  // The elevated token from a completed Google re-auth arrives via
  // sessionStorage (AuthCallbackPage parks it there; five-minute,
  // single-purpose, kept out of localStorage and out of the session). READ
  // but do not remove it here: consuming on mount meant closing and
  // reopening the dialog silently burned the token. It is removed only when
  // spent (submitPassword) or when its five minutes are plainly up.
  useEffect(() => {
    const parked = sessionStorage.getItem('mw_elevated');
    if (parked) setElevated(parked);
  }, []);

  useEffect(() => {
    let live = true;
    if (!user?.token) return;
    apiService
      .getMe(user.token)
      .then(({ data }) => live && setProfile(data as unknown as Profile))
      .catch(() => live && toast.error("Couldn't load account details"));
    return () => {
      live = false;
    };
  }, [user?.token]);

  // dialog manners, same as the app's other dialogs: focus in, Escape
  // closes, Tab stays inside, focus returns to the opener
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const FOCUSABLE =
      'input:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusable = Array.from(
        cardRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !cardRef.current?.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      opener?.focus();
    };
  }, [onClose]);

  const linkGoogle = useCallback(
    async (password: string) => {
      setBusy('link');
      try {
        const { data } = await apiService.googleLinkStart('/', password);
        window.location.href = data.authUrl;
      } catch (err: unknown) {
        const status = (err as { response?: { status?: number } })?.response
          ?.status;
        toast.error(
          status === 401
            ? 'That password is wrong'
            : "Couldn't start Google linking",
        );
        setBusy(null);
      }
    },
    [],
  );

  const beginReauth = useCallback(async () => {
    setBusy('reauth');
    try {
      const { data } = await apiService.googleReauthStart('/');
      window.location.href = data.authUrl;
    } catch {
      toast.error("Couldn't start the Google confirmation");
      setBusy(null);
    }
  }, []);

  const submitPassword = useCallback(
    async (newPassword: string, currentPassword?: string) => {
      setBusy('password');
      try {
        const res = elevated
          ? // the elevated token rides Authorization for THIS call only
            await apiService.setPasswordElevated(newPassword, elevated)
          : await apiService.setPassword(newPassword, currentPassword);
        // set-password revoked the token we just used and handed back the
        // ONE survivor. Adopt it before touching the API again - the old
        // token is dead now, and a getMe with it would 401 the success into
        // a "wrong password" error and (before the interceptor fix) wipe the
        // session. The stored/elevated token is spent; clear it.
        const survivor = (res.data as { id: string; token: string }) ?? null;
        if (survivor?.token) adoptToken(survivor.token, survivor.id);
        sessionStorage.removeItem('mw_elevated');
        setElevated(null);
        toast.success('Password saved - every other session was signed out');
        // reflect the change with the LIVE token
        setProfile((p) => (p ? { ...p, hasPassword: true } : p));
      } catch (err: unknown) {
        const status = (err as { response?: { status?: number } })?.response
          ?.status;
        if (status === 401 && elevated) {
          // the five-minute elevation is spent or expired; drop it so the
          // UI returns to "Confirm with Google" instead of leaving a dead
          // password form the person cannot escape without closing the tab
          sessionStorage.removeItem('mw_elevated');
          setElevated(null);
        }
        toast.error(
          status === 401
            ? elevated
              ? 'The Google confirmation expired - confirm again'
              : 'The current password is wrong'
            : status === 400
              ? 'Passwords are at least 8 characters'
              : "Couldn't save the password",
        );
      } finally {
        setBusy(null);
      }
    },
    [elevated, adoptToken],
  );

  if (!user) return null;

  return (
    <Overlay onClick={onClose}>
      <Card
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-title"
        onClick={(e) => e.stopPropagation()}
      >
        <Title id="account-title">{user.username}</Title>
        <Address>{user.email}</Address>

        {profile && !profile.isGuest && (
          <>
            <Section>
              <SectionTitle>Sign-in methods</SectionTitle>
              {profile.googleLinked ? (
                <Row>
                  <IconGoogle size={16} />
                  <RowText>Google is connected to this account.</RowText>
                </Row>
              ) : (
                <GoogleLinkForm busy={busy === 'link'} onSubmit={linkGoogle} />
              )}
            </Section>

            <Section>
              <SectionTitle>
                {profile.hasPassword ? 'Change password' : 'Set a password'}
              </SectionTitle>
              {profile.hasPassword ? (
                <PasswordForm
                  requireCurrent
                  busy={busy === 'password'}
                  onSubmit={submitPassword}
                />
              ) : elevated ? (
                <PasswordForm
                  requireCurrent={false}
                  busy={busy === 'password'}
                  onSubmit={submitPassword}
                />
              ) : (
                <Row>
                  <RowText>
                    This account signs in with Google only. Confirm with
                    Google once, then choose a password — after that, either
                    works.
                  </RowText>
                  <Secondary
                    type="button"
                    disabled={busy === 'reauth'}
                    onClick={beginReauth}
                  >
                    {busy === 'reauth' ? 'Opening…' : 'Confirm with Google'}
                  </Secondary>
                </Row>
              )}
            </Section>
          </>
        )}

        <Section>
          <SectionTitle>Sessions</SectionTitle>
          <Row>
            <RowText>
              Sign out on every device — this one included. The answer to a
              laptop left open somewhere, or a token you think leaked.
            </RowText>
            <Danger
              type="button"
              onClick={() => {
                logout({ everywhere: true });
                onClose();
              }}
            >
              Sign out everywhere
            </Danger>
          </Row>
        </Section>

        <Buttons>
          <Secondary ref={closeRef} type="button" onClick={onClose}>
            Close
          </Secondary>
        </Buttons>
      </Card>
    </Overlay>
  );
};

const GoogleLinkForm: React.FC<{
  busy: boolean;
  onSubmit: (password: string) => void;
}> = ({ busy, onSubmit }) => (
  <form
    onSubmit={(e) => {
      e.preventDefault();
      onSubmit(String(new FormData(e.currentTarget).get('password') ?? ''));
    }}
  >
    <RowText>
      Connect Google as a second way in. Your password confirms it&apos;s
      you — a session alone isn&apos;t enough to add a door to this account.
    </RowText>
    <Field>
      <FieldLabel>Current password</FieldLabel>
      <FieldInput
        name="password"
        type="password"
        autoComplete="current-password"
        required
      />
    </Field>
    <Buttons>
      <Primary type="submit" disabled={busy}>
        {busy ? 'Opening…' : 'Connect Google'}
      </Primary>
    </Buttons>
  </form>
);

const PasswordForm: React.FC<{
  requireCurrent: boolean;
  busy: boolean;
  onSubmit: (newPassword: string, currentPassword?: string) => void;
}> = ({ requireCurrent, busy, onSubmit }) => (
  <form
    onSubmit={(e) => {
      e.preventDefault();
      const form = new FormData(e.currentTarget);
      onSubmit(
        String(form.get('newPassword') ?? ''),
        requireCurrent ? String(form.get('currentPassword') ?? '') : undefined,
      );
    }}
  >
    {requireCurrent && (
      <Field>
        <FieldLabel>Current password</FieldLabel>
        <FieldInput
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
        />
      </Field>
    )}
    <Field>
      <FieldLabel>New password</FieldLabel>
      <FieldInput
        name="newPassword"
        type="password"
        minLength={8}
        autoComplete="new-password"
        required
      />
    </Field>
    <RowText>Saving signs out every other session.</RowText>
    <Buttons>
      <Primary type="submit" disabled={busy}>
        {busy ? 'Saving…' : 'Save password'}
      </Primary>
    </Buttons>
  </form>
);
