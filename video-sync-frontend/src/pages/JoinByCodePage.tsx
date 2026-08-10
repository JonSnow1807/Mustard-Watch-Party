import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import styled from '@emotion/styled';
import { color, font, button, input, card } from '../theme';
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
`;

const Title = styled.h1`
  font-family: ${font.display};
  font-size: 24px;
  font-weight: 700;
  color: ${color.text};
  margin: 0 0 6px;
`;

const Blurb = styled.p`
  margin: 0 0 20px;
  font-family: ${font.body};
  font-size: 13.5px;
  line-height: 1.6;
  color: ${color.dim};
`;

const Form = styled.form`
  display: flex;
  flex-direction: column;
  gap: 12px;
`;

/**
 * Monospace and wide-tracked: a room code is read off a phone screen or
 * heard down a line, and the shapes that get confused doing that (1/l, 0/O)
 * are exactly the ones a mono face separates.
 */
const CodeInput = styled.input`
  ${input}
  font-family: ${font.mono};
  font-size: 16px;
  letter-spacing: 0.08em;
`;

const SubmitButton = styled.button`
  ${button.primary}
  width: 100%;
`;

const BackLink = styled.button`
  ${button.secondary}
  width: 100%;
`;

/**
 * Somewhere to type a room code.
 *
 * The landing page has had a button labelled "I have a code" since it was
 * written, and it went to the sign-in form: there was nowhere in the entire
 * app to put a code. Meanwhile the room's most prominent share control
 * copies the bare code, so the obvious thing to send someone was the one
 * thing they could not use.
 */
export const JoinByCodePage: React.FC = () => {
  const navigate = useNavigate();
  const [code, setCode] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Tolerate what people actually paste: surrounding space, and a whole
    // room URL rather than the code out of it.
    const raw = code.trim();
    if (!raw) return;
    const fromUrl = raw.match(/\/(?:room|join-room)\/([^/?#\s]+)/);
    const cleaned = (fromUrl ? fromUrl[1] : raw).replace(/[^A-Za-z0-9_-]/g, '');
    if (!cleaned) return;
    navigate(`/join-room/${cleaned}`);
  };

  return (
    <Page>
      <Column>
        <Wordmark size={22} />
        <Panel>
          <Title>Join a room</Title>
          <Blurb>
            Paste the code a friend sent you — or the whole link, that works
            too.
          </Blurb>
          <Form onSubmit={handleSubmit}>
            <CodeInput
              autoFocus
              type="text"
              aria-label="Room code"
              placeholder="Room code"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <SubmitButton type="submit" disabled={code.trim() === ''}>
              Join room
            </SubmitButton>
          </Form>
        </Panel>
        <BackLink type="button" onClick={() => navigate('/')}>
          Back to home
        </BackLink>
      </Column>
    </Page>
  );
};
