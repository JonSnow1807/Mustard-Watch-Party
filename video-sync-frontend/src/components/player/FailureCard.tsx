import React from 'react';
import styled from '@emotion/styled';

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
  color: #e2e8f0;
`;

const Title = styled.h3`
  margin: 0;
  font-size: 18px;
  color: #f8fafc;
`;

const Detail = styled.p`
  margin: 0;
  font-size: 14px;
  color: #a0aec0;
  max-width: 480px;
`;

const Url = styled.code`
  margin-top: 8px;
  font-size: 12px;
  color: #718096;
  word-break: break-all;
  max-width: 90%;
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
}> = ({ title, detail, url }) => (
  // role="alert": the card swaps in dynamically after a playback failure,
  // and without a live region a screen reader never hears about it
  <Card data-testid="failure-card" role="alert">
    <Title>{title}</Title>
    {detail && <Detail>{detail}</Detail>}
    {url && <Url>{url}</Url>}
  </Card>
);
