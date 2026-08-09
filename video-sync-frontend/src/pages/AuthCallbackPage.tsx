import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import styled from '@emotion/styled';
import { useAuth } from '../contexts/AuthContext';
import { color, font, button, card } from '../theme';
import { Wordmark } from '../components/Icons';

const Page = styled.div`
  min-height: 100vh;
  background: ${color.bg0};
  padding: 12vh 20px 64px;
`;

const Column = styled.div`
  max-width: 400px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 24px;
`;

const Panel = styled.div`
  ${card}
  padding: 24px;
  text-align: center;
`;

const Message = styled.p`
  margin: 0;
  font-family: ${font.body};
  font-size: 14px;
  line-height: 1.6;
  color: ${color.dim};
`;

const Title = styled.h2`
  font-family: ${font.display};
  font-size: 20px;
  font-weight: 700;
  color: ${color.text};
  margin: 0 0 8px;
`;

const BackButton = styled.button`
  ${button.secondary}
  margin-top: 16px;
`;

/**
 * What each failure code from the API means to a person. The server sends a
 * code, never a sentence: it does not know how we word things, and a code
 * cannot leak anything about the account it refused.
 */
const EXPLANATIONS: Record<string, { title: string; body: string }> = {
  denied: {
    title: 'Sign-in cancelled',
    body: 'You chose not to continue at Google. Nothing was shared.',
  },
  state: {
    title: 'That sign-in expired',
    body: 'The link back from Google was stale or came from a different browser. Starting again should work.',
  },
  unverified: {
    title: 'Google has not verified that address',
    body: 'Verify your email with Google first, or sign in with a password instead.',
  },
  email_taken: {
    title: 'That email already has an account here',
    body: 'It was registered with a password. Sign in with that password - linking Google to an existing account is not something we do automatically, because we cannot tell from here that both are you.',
  },
  exchange: {
    title: "Couldn't finish with Google",
    body: 'Google did not complete the exchange. Try again in a moment.',
  },
};

const fallback = {
  title: "Couldn't sign you in",
  body: 'Something went wrong on the way back from Google.',
};

export const AuthCallbackPage: React.FC = () => {
  const navigate = useNavigate();
  const { signInWithToken } = useAuth();
  const [failure, setFailure] = useState<typeof fallback | null>(null);
  // StrictMode mounts effects twice in development, and this effect signs
  // someone in. Once.
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;

    // The token is in the FRAGMENT, which the browser never sends to a
    // server - not in a request line, not in a Referer, not in any log.
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const token = params.get('token');
    const error = params.get('error');
    const to = params.get('to');

    if (error || !token) {
      setFailure((error && EXPLANATIONS[error]) || fallback);
      return;
    }

    // Drop the token out of the address bar before doing anything else, so
    // it cannot be bookmarked, shared, or read back out of history.
    window.history.replaceState(null, '', window.location.pathname);

    signInWithToken(token)
      .then(() => {
        // `to` came back sealed in a server-side cookie, and the server
        // already refused anything that was not a path on this site.
        navigate(to && to.startsWith('/') && !to.startsWith('//') ? to : '/', {
          replace: true,
        });
      })
      .catch(() => setFailure(fallback));
  }, [navigate, signInWithToken]);

  return (
    <Page>
      <Column>
        <Wordmark size={22} />
        <Panel>
          {failure ? (
            <>
              <Title>{failure.title}</Title>
              <Message>{failure.body}</Message>
              <BackButton onClick={() => navigate('/login', { replace: true })}>
                Back to sign in
              </BackButton>
            </>
          ) : (
            <Message>Finishing sign-in…</Message>
          )}
        </Panel>
      </Column>
    </Page>
  );
};
