import React, { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { apiService } from '../services/api';
import { toast } from 'react-hot-toast';
import styled from '@emotion/styled';
import {
  color,
  font,
  focusRing,
  button,
  chip,
  chipStatic,
  input,
  card,
  sectionLabel,
} from '../theme';
import { IconX, IconGlobe, IconLock, IconUsers, Wordmark } from '../components/Icons';

const Page = styled.div`
  min-height: 100vh;
  background: ${color.bg0};
`;

const Container = styled.div`
  max-width: 460px;
  margin: 0 auto;
  padding: 48px 24px;
`;

const TopBar = styled.header`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 24px;
`;

const BackLink = styled.button`
  font-family: ${font.body};
  font-size: 13px;
  color: ${color.dim};
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  transition: color 120ms ease;

  &:hover {
    color: ${color.text};
  }
  &:focus-visible {
    outline: none;
    box-shadow: ${focusRing};
  }
`;

const Title = styled.h1`
  font-family: ${font.display};
  font-weight: 700;
  font-size: 24px;
  color: ${color.text};
  margin: 0 0 20px;
`;

const PreviewCard = styled.div`
  ${card}
  padding: 20px;
  margin-bottom: 20px;
`;

const RoomName = styled.h2`
  font-family: ${font.display};
  font-weight: 600;
  font-size: 18px;
  color: ${color.text};
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const Creator = styled.p`
  font-family: ${font.body};
  font-size: 13px;
  color: ${color.dim};
  margin: 4px 0 0;
`;

const Description = styled.p`
  font-family: ${font.body};
  font-size: 13.5px;
  color: ${color.dim};
  line-height: 1.5;
  margin: 12px 0 0;
`;

// geometry + the static border grammar from the theme; the public/private
// colors are layered after so the instance wins over chipStatic's defaults
const VisibilityChip = styled.span<{ isPublic: boolean }>`
  ${chip.sm}
  ${chipStatic}
  background: ${(p) => (p.isPublic ? color.okFaint : color.bg2)};
  color: ${(p) => (p.isPublic ? color.ok : color.dim)};
  margin-top: 12px;
`;

const ParticipantRow = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 12px;
  font-family: ${font.body};
  font-size: 13px;
  color: ${color.dim};
`;

const ParticipantCount = styled.span`
  font-family: ${font.mono};
  font-variant-numeric: tabular-nums;
`;

const Field = styled.div`
  margin-bottom: 16px;
`;

const FieldLabel = styled.label`
  ${sectionLabel}
  display: block;
  margin-bottom: 6px;
`;

const TextInput = styled.input`
  ${input}
`;

const PrimaryButton = styled.button`
  ${button.primary}
  width: 100%;
`;

const SecondaryButton = styled.button`
  ${button.secondary}
`;

const StateCard = styled.div`
  ${card}
  padding: 24px;
`;

// stacked actions: the full-width primary and the auto-width secondary
// need a column and a gap, or they touch
const StateActions = styled.div`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
`;

const StateTitle = styled.h2`
  font-family: ${font.display};
  font-weight: 700;
  font-size: 20px;
  color: ${color.text};
  margin: 12px 0 8px;
`;

const StateBody = styled.p`
  font-family: ${font.body};
  font-size: 13.5px;
  color: ${color.dim};
  line-height: 1.5;
  margin: 0 0 20px;
`;

// .spinner is inline-block, so a flex column is what stacks it above the
// label instead of letting the two share a line
const LoadingState = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 64px 24px;
  text-align: center;
  color: ${color.dim};
  font-family: ${font.body};
  font-size: 14px;
`;

export const JoinRoomPage: React.FC = () => {
  const navigate = useNavigate();
  const { roomCode } = useParams<{ roomCode: string }>();
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [roomInfo, setRoomInfo] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState('');

  useEffect(() => {
    if (!roomCode) {
      setError('No room code provided');
      return;
    }

    const fetchRoomInfo = async () => {
      try {
        const response = await apiService.getRoomByCode(roomCode);
        setRoomInfo(response.data);
        setError(null);
      } catch (error: any) {
        setError('Watch party not found or you do not have permission to join');
      }
    };

    fetchRoomInfo();
  }, [roomCode]);

  const handleJoinRoom = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!user) {
      toast.error('Please login first');
      navigate('/login');
      return;
    }

    if (!roomInfo) {
      toast.error('Watch party information not available');
      return;
    }

    setLoading(true);
    try {
      // For now, we'll just navigate to the room
      // In the future, you might want to add password verification here
      navigate(`/room/${roomCode}`);
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to join watch party');
    } finally {
      setLoading(false);
    }
  };

  const handleJoinPublicRoom = () => {
    if (roomInfo?.isPublic) {
      navigate(`/room/${roomCode}`);
    }
  };

  if (!user) {
    return (
      <Page>
        <Container>
          <Title>Sign in to join</Title>
          <StateCard>
            <StateActions>
              <PrimaryButton onClick={() => navigate('/login')}>
                Go to sign in
              </PrimaryButton>
              {/* never leave a state without an exit: this branch has no
                  top bar, so without this the page is a dead end */}
              <SecondaryButton onClick={() => navigate('/')}>
                Back to home
              </SecondaryButton>
            </StateActions>
          </StateCard>
        </Container>
      </Page>
    );
  }

  if (error) {
    return (
      <Page>
        <Container>
          <StateCard>
            <IconX size={22} style={{ color: color.danger, display: 'block' }} />
            <StateTitle>Room not found</StateTitle>
            <StateBody>{error}</StateBody>
            <SecondaryButton onClick={() => navigate('/')}>
              Back to home
            </SecondaryButton>
          </StateCard>
        </Container>
      </Page>
    );
  }

  if (!roomInfo) {
    return (
      <Page>
        <Container>
          <LoadingState>
            <div className="spinner"></div>
            <span>Finding the room…</span>
          </LoadingState>
        </Container>
      </Page>
    );
  }

  return (
    <Page>
      <Container>
        {/* same top bar as the create-room flow: the wordmark is the way
            home from a link someone sent you */}
        <TopBar>
          <Wordmark size={16} />
          <BackLink onClick={() => navigate('/')}>Back to home</BackLink>
        </TopBar>

        <Title>Join the room</Title>

        <PreviewCard>
          <RoomName>{roomInfo.name}</RoomName>
          <Creator>by {roomInfo.creator?.username || 'Unknown'}</Creator>
          {roomInfo.description && (
            <Description>{roomInfo.description}</Description>
          )}
          <VisibilityChip isPublic={!!roomInfo.isPublic}>
            {roomInfo.isPublic ? <IconGlobe size={12} /> : <IconLock size={12} />}
            {roomInfo.isPublic ? 'Public' : 'Private'}
          </VisibilityChip>
          {roomInfo.participants?.length != null && (
            <ParticipantRow>
              <IconUsers size={14} />
              <ParticipantCount>
                {roomInfo.participants?.length}
              </ParticipantCount>
            </ParticipantRow>
          )}
        </PreviewCard>

        <form onSubmit={handleJoinRoom}>
          {roomInfo.isPublic ? (
            <PrimaryButton type="button" onClick={handleJoinPublicRoom}>
              Join now
            </PrimaryButton>
          ) : (
            <>
              <Field>
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <TextInput
                  id="password"
                  type="password"
                  placeholder="Enter the room password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>

              <PrimaryButton type="submit" disabled={loading}>
                {loading ? 'Joining…' : 'Join room'}
              </PrimaryButton>
            </>
          )}
        </form>
      </Container>
    </Page>
  );
};
