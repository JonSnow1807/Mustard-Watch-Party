import React from 'react';
import styled from '@emotion/styled';
import { button, color, font } from '../../theme';

const Card = styled.div`
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  text-align: center;
  color: ${color.text};
`;

const Title = styled.h3`
  margin: 0;
  font-family: ${font.display};
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: ${color.text};
`;

const Detail = styled.p`
  margin: 0;
  font-family: ${font.body};
  font-size: 13.5px;
  color: ${color.dim};
  max-width: 480px;
`;

const Url = styled.code`
  margin-top: 8px;
  font-family: ${font.mono};
  font-size: 12px;
  color: ${color.faint};
  word-break: break-all;
  max-width: 90%;
`;

const RetryButton = styled.button`
  ${button.secondary}
  margin-top: 14px;
`;

/**
 * The visible end of attempt-and-fail-visibly: validation admits anything a
 * player could conceivably fetch (see shared/media-source.ts), so when the
 * attempt dies, THIS is what owns the outcome - the URL is shown so "why is
 * my room black" is answerable from the screen.
 */
export const FailureCard: React.FC<{
  title: string;
  detail?: string;
  url?: string;
  /** Offered only where retrying could plausibly help - not for a URL no
      player can ever take, where the button would just fail again. */
  onRetry?: () => void;
}> = ({ title, detail, url, onRetry }) => (
  // role="alert": the card swaps in dynamically after a playback failure,
  // and without a live region a screen reader never hears about it
  <Card data-testid="failure-card" role="alert">
    <Title>{title}</Title>
    {detail && <Detail>{detail}</Detail>}
    {url && <Url>{url}</Url>}
    {onRetry && (
      <RetryButton type="button" onClick={onRetry}>
        Try again
      </RetryButton>
    )}
  </Card>
);
