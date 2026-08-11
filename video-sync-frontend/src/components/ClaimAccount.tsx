import React, { useCallback, useEffect, useRef, useState } from 'react';
import styled from '@emotion/styled';
import { useAuth } from '../contexts/AuthContext';
import { apiService } from '../services/api';
import { toast } from 'react-hot-toast';
import {
  card,
  color,
  font,
  input,
  button,
  buttonSm,
  sectionLabel,
} from '../theme';
import { IconGoogle } from './Icons';

// Extracted from HomePage so a guest can reach it from inside a room too.
// It lived on the home page only, which meant the one moment someone most
// wants to keep their account - after an evening in a room, with the chat
// they wrote in front of them - was the one place they could not.

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
  max-width: 420px;
  max-height: calc(100vh - 48px);
  overflow-y: auto;
`;

const Title = styled.h3`
  margin: 0 0 8px;
  font-family: ${font.display};
  font-weight: 600;
  font-size: 18px;
  color: ${color.text};
`;

const Text = styled.p`
  margin: 0 0 20px;
  font-family: ${font.body};
  font-size: 13.5px;
  line-height: 1.6;
  color: ${color.dim};
`;

const Field = styled.label`
  display: block;
  margin-bottom: 14px;
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

const Buttons = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  justify-content: flex-end;
`;

const Secondary = styled.button`
  ${button.secondary}
`;

const Primary = styled.button`
  ${button.primary}
`;

const GoogleButton = styled.button`
  ${button.secondary}
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-bottom: 18px;
`;

// A rule, not decoration: the two routes to the same outcome should not read
// as a ranked list, and "or" between them says they are alternatives.
const Or = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0 0 18px;
  font-family: ${font.body};
  font-size: 11.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: ${color.faint};

  &::before,
  &::after {
    content: '';
    flex: 1;
    height: 1px;
    background: ${color.line};
  }
`;

export const ClaimTrigger = styled.button`
  ${buttonSm}
  border-color: ${color.mustard};
  color: ${color.mustard};
`;

/**
 * Turn the guest session already in use into a real account.
 *
 * Two ways in, because a password is not the only thing people have: the
 * form below, or Google - which attaches to the SAME row rather than making
 * a second account, the whole point of both paths.
 */
export const ClaimAccountDialog: React.FC<{
  onClose: () => void;
  /** where to come back to after the Google round trip */
  returnTo?: string;
}> = ({ onClose, returnTo }) => {
  const { user, claimAccount } = useAuth();
  const [saving, setSaving] = useState(false);
  const [googling, setGoogling] = useState(false);
  const [googleOffered, setGoogleOffered] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  // Asked at runtime, like the sign-in page does: one bundle is served to
  // every environment, and a button for a provider the API has no
  // credentials for is a dead end.
  useEffect(() => {
    let live = true;
    apiService
      .getProviders()
      .then(({ data }) => live && setGoogleOffered(Boolean(data?.google)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  // Dialog manners: focus moves in, Escape closes, focus returns to whatever
  // opened it.
  useEffect(() => {
    triggerRef.current = document.activeElement as HTMLElement | null;
    firstFieldRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      triggerRef.current?.focus();
      triggerRef.current = null;
    };
  }, [onClose]);

  const submit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const form = new FormData(e.currentTarget);
      setSaving(true);
      try {
        await claimAccount(
          String(form.get('username') ?? ''),
          String(form.get('email') ?? ''),
          String(form.get('password') ?? ''),
        );
        onClose();
      } catch {
        // claimAccount has already said what went wrong; the dialog stays
        // open so the typed values are still there to correct
      } finally {
        setSaving(false);
      }
    },
    [claimAccount, onClose],
  );

  const withGoogle = useCallback(async () => {
    setGoogling(true);
    try {
      // A POST, not a link: the browser cannot put a bearer token on a
      // navigation, and the alternative - the token in a query string -
      // writes a credential into access logs and Referer headers. So the
      // server hands back the URL and we go there ourselves.
      const { data } = await apiService.googleLinkStart(returnTo);
      window.location.href = data.authUrl;
    } catch {
      toast.error("Couldn't start Google sign-in");
      setGoogling(false);
    }
  }, [returnTo]);

  if (!user) return null;

  return (
    <Overlay onClick={onClose}>
      <Card
        role="dialog"
        aria-modal="true"
        aria-labelledby="claim-title"
        onClick={(e) => e.stopPropagation()}
      >
        <Title id="claim-title">Keep this account</Title>
        <Text>
          You are {user.username}, and you stay {user.username} — the same
          account, so the rooms you have joined and the messages you have
          already sent stay yours. This only adds a way back in.
        </Text>

        {googleOffered && (
          <>
            <GoogleButton type="button" onClick={withGoogle} disabled={googling}>
              <IconGoogle size={18} />
              {googling ? 'Taking you to Google…' : 'Continue with Google'}
            </GoogleButton>
            <Or>or</Or>
          </>
        )}

        <form onSubmit={submit}>
          <Field>
            <FieldLabel>Name</FieldLabel>
            <FieldInput
              name="username"
              ref={firstFieldRef}
              defaultValue={user.username}
              autoComplete="username"
              required
            />
          </Field>
          <Field>
            <FieldLabel>Email</FieldLabel>
            <FieldInput
              name="email"
              type="email"
              placeholder="you@example.com"
              autoComplete="email"
              required
            />
          </Field>
          <Field>
            <FieldLabel>Password</FieldLabel>
            <FieldInput
              name="password"
              type="password"
              minLength={8}
              placeholder="At least 8 characters"
              autoComplete="new-password"
              required
            />
          </Field>
          <Buttons>
            <Secondary type="button" onClick={onClose}>
              Not now
            </Secondary>
            <Primary type="submit" disabled={saving}>
              {saving ? 'Saving…' : 'Keep it'}
            </Primary>
          </Buttons>
        </form>
      </Card>
    </Overlay>
  );
};
