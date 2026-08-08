import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useSocket } from '../contexts/SocketContext';
import { useAuth } from '../contexts/AuthContext';
import { EnhancedVideoPlayer } from '../components/EnhancedVideoPlayer';
import { ChatPanel } from '../components/ChatPanel';
import { EnhancedVoiceChat } from '../components/EnhancedVoiceChat';
import { RoomSettings } from '../components/RoomSettings';
import { apiService } from '../services/api';
import styled from '@emotion/styled';
import { toast } from 'react-hot-toast';
import {
  color,
  font,
  button,
  buttonSm,
  chip,
  chipStatic,
  chipInteractive,
  chipMono,
  card,
  sectionLabel,
} from '../theme';
import {
  Wordmark,
  IconCopy,
  IconCheck,
  IconShare,
  IconSettings,
  IconLeave,
} from '../components/Icons';

const Page = styled.div`
  min-height: 100vh;
  background: ${color.bg0};
  color: ${color.text};
  font-family: ${font.body};
`;

const TopBar = styled.header`
  position: sticky;
  top: 0;
  z-index: 100;
  background: ${color.bg0};
  border-bottom: 1px solid ${color.line};
`;

const TopBarInner = styled.div`
  height: 56px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 20px;
`;

const Identity = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 1;
`;

/**
 * The wordmark is the first thing to go on a phone: the room NAME is this
 * page's h1 and the only thing telling you which room you are in, so it
 * stays at every width (it truncates) and the brand steps aside.
 */
const BrandSlot = styled.span`
  display: inline-flex;
  align-items: center;
  flex: none;

  @media (max-width: 560px) {
    display: none;
  }
`;

const Divider = styled.span`
  color: ${color.faint};
  font-size: 13px;
  line-height: 1;

  @media (max-width: 560px) {
    display: none;
  }
`;

const RoomName = styled.h1`
  margin: 0;
  min-width: 0;
  font-family: ${font.display};
  font-weight: 600;
  font-size: 15px;
  color: ${color.text};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const CodeChip = styled.button<{ copied?: boolean }>`
  ${chip.sm}
  ${chipInteractive}
  font-family: ${font.mono};
  letter-spacing: 0.04em;
  flex-shrink: 0;
  color: ${props => (props.copied ? color.ok : color.text)};
  border-color: ${props => (props.copied ? color.ok : color.lineBright)};

  &:hover {
    border-color: ${props => (props.copied ? color.ok : color.mustardDeep)};
    color: ${props => (props.copied ? color.ok : color.text)};
  }
`;

const Actions = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`;

const ActionLabel = styled.span`
  @media (max-width: 880px) {
    display: none;
  }
`;

/** Below 880px the labels drop out and these become icon-only squares. */
const actionTight = `
  @media (max-width: 880px) {
    padding: 6px 8px;
  }
`;

const SecondaryAction = styled.button`
  ${button.secondary}
  ${buttonSm}
  ${actionTight}
`;

const DangerAction = styled.button`
  ${button.danger}
  ${buttonSm}
  ${actionTight}
`;

const BackButton = styled.button`
  ${button.secondary}
`;

const Grid = styled.main`
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  gap: 20px;
  padding: 20px;

  @media (max-width: 1100px) {
    grid-template-columns: minmax(0, 1fr);
  }
`;

const MainColumn = styled.div`
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 20px;
`;

const SideColumn = styled.div`
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 20px;
  height: fit-content;
  position: sticky;
  top: 76px;

  @media (max-width: 1100px) {
    position: static;
  }
`;

const ParticipantsPanel = styled.div`
  ${card}
  padding: 16px;
`;

const PanelHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 16px;
`;

// h3, not h2: Participants, Chat and Voice are sibling panels of equal
// rank under the page's single h1 (the room name).
const PanelLabel = styled.h3`
  ${sectionLabel}
  margin: 0;
`;

const CountChip = styled.span`
  ${chip.sm}
  ${chipStatic}
  ${chipMono}
`;

const ParticipantRow = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 6px 0;
`;

const Avatar = styled.div`
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  border-radius: 50%;
  background: ${color.bg3};
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: ${font.display};
  font-weight: 600;
  font-size: 13px;
  color: ${color.mustard};
`;

const ParticipantName = styled.div`
  flex: 1;
  min-width: 0;
  font-size: 13.5px;
  color: ${color.text};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const SelfTag = styled.span`
  color: ${color.dim};
`;

const HostChip = styled.span`
  ${chip.sm}
  ${chipStatic}
  ${chipMono}
  color: ${color.mustard};
  background: transparent;
  border-color: ${color.mustardDeep};
  flex-shrink: 0;
`;

// Page gutter only - RoomSettings owns its own max-width, centering and
// top margin, so constraining it again here would double-inset the panel.
const SettingsSlot = styled.div`
  padding: 0 20px 20px;
`;

const CenteredState = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  min-height: 100vh;
  padding: 24px;
  text-align: center;
`;

const StateText = styled.p`
  margin: 0;
  font-size: 13.5px;
  color: ${color.dim};
`;

const StateTitle = styled.h2`
  margin: 0;
  font-family: ${font.display};
  font-weight: 700;
  font-size: 20px;
  color: ${color.text};
`;

interface Room {
  id: string;
  name: string;
  code: string;
  videoUrl: string;
  creatorId: string;
  creator: { id: string; username: string };
  allowGuestControl?: boolean;
}

interface Participant {
  id: string;
  username: string;
}

export const EnhancedRoomPage: React.FC = () => {
  const { roomCode } = useParams<{ roomCode: string }>();
  const navigate = useNavigate();
  const { socket, connected } = useSocket();
  const { user } = useAuth();

  const [room, setRoom] = useState<Room | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [loading, setLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);

  useEffect(() => {
    if (!roomCode) {
      navigate('/');
      return;
    }

    fetchRoomDetails();
    // intentional: fetch once per room code
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode]);

  useEffect(() => {
    if (!socket || !connected || !user || !room) return;

    socket.emit('join-room', {
      roomCode: room.code,
      userId: user.id,
    });

    const handleRoomJoined = (data: any) => {
      if (data.participants) {
        setParticipants(data.participants);
      }
      toast.success('Joined the room');
    };

    const handleUserJoined = (data: { userId: string; username: string }) => {
      setParticipants(prev => {
        if (prev.find(p => p.id === data.userId)) return prev;
        toast(`${data.username} joined`);
        return [...prev, { id: data.userId, username: data.username }];
      });
    };

    const handleUserLeft = (data: { userId: string }) => {
      setParticipants(prev => {
        const user = prev.find(p => p.id === data.userId);
        if (user) {
          toast(`${user.username} left`);
        }
        return prev.filter(p => p.id !== data.userId);
      });
    };

    const handleParticipantsUpdate = (data: { participants: Participant[] }) => {
      setParticipants(data.participants);
    };

    socket.on('room-joined', handleRoomJoined);
    socket.on('user-joined', handleUserJoined);
    socket.on('user-left', handleUserLeft);
    socket.on('participants-update', handleParticipantsUpdate);

    socket.emit('request-participants', { roomCode: room.code });

    return () => {
      socket.off('room-joined', handleRoomJoined);
      socket.off('user-joined', handleUserJoined);
      socket.off('user-left', handleUserLeft);
      socket.off('participants-update', handleParticipantsUpdate);
    };
  }, [socket, connected, user, room]);

  const fetchRoomDetails = async () => {
    try {
      const response = await apiService.getRoomByCode(roomCode!);
      setRoom(response.data);
      if (response.data.participants) {
        setParticipants(response.data.participants.map((p: any) => ({
          id: p.user.id,
          username: p.user.username,
        })));
      }
    } catch (error) {
      toast.error("Couldn't load the room");
      navigate('/');
    } finally {
      setLoading(false);
    }
  };

  const handleCopyRoomCode = () => {
    if (room) {
      navigator.clipboard.writeText(room.code);
      setCopySuccess(true);
      toast.success('Room code copied');
      setTimeout(() => setCopySuccess(false), 2000);
    }
  };

  const handleShareRoom = () => {
    if (room) {
      const shareUrl = `${window.location.origin}/join-room/${room.code}`;
      navigator.clipboard.writeText(shareUrl);
      toast.success('Share link copied');
    }
  };

  const handleLeaveRoom = () => {
    if (socket && room) {
      socket.emit('leave-room', { roomCode: room.code, userId: user?.id });
    }
    navigate('/');
    toast.success('Left the room');
  };

  if (loading) {
    return (
      <Page>
        <CenteredState>
          <div className="spinner" />
          <StateText>Loading the room…</StateText>
        </CenteredState>
      </Page>
    );
  }

  if (!room) {
    return (
      <Page>
        <CenteredState>
          <StateTitle>Room not found</StateTitle>
          <BackButton onClick={() => navigate('/')}>Back to home</BackButton>
        </CenteredState>
      </Page>
    );
  }

  const isHost = user?.id === room.creatorId;

  return (
    <Page>
      <TopBar>
        <TopBarInner>
          <Identity>
            <BrandSlot>
              <Wordmark size={15} />
            </BrandSlot>
            <Divider>·</Divider>
            <RoomName>{room.name}</RoomName>
            <CodeChip
              type="button"
              copied={copySuccess}
              onClick={handleCopyRoomCode}
              title="Click to copy"
            >
              {copySuccess ? <IconCheck size={13} /> : <IconCopy size={13} />}
              {copySuccess ? 'copied' : room.code}
            </CodeChip>
          </Identity>

          <Actions>
            <SecondaryAction onClick={handleShareRoom} aria-label="Share">
              <IconShare size={14} />
              <ActionLabel>Share</ActionLabel>
            </SecondaryAction>

            {isHost && (
              <SecondaryAction
                onClick={() => setShowSettings(!showSettings)}
                aria-label="Settings"
              >
                <IconSettings size={14} />
                <ActionLabel>Settings</ActionLabel>
              </SecondaryAction>
            )}

            <DangerAction onClick={handleLeaveRoom} aria-label="Leave">
              <IconLeave size={14} />
              <ActionLabel>Leave</ActionLabel>
            </DangerAction>
          </Actions>
        </TopBarInner>
      </TopBar>

      <Grid>
        <MainColumn>
          <EnhancedVideoPlayer
            videoUrl={room.videoUrl}
            roomCode={room.code}
            isHost={isHost}
            allowGuestControl={room.allowGuestControl}
          />

          <EnhancedVoiceChat roomCode={room.code} />
        </MainColumn>

        <SideColumn>
          <ParticipantsPanel>
            <PanelHeader>
              <PanelLabel>Participants</PanelLabel>
              <CountChip>{participants.length}</CountChip>
            </PanelHeader>

            {/* Host */}
            {room.creator && (
              <ParticipantRow>
                <Avatar>{room.creator.username[0].toUpperCase()}</Avatar>
                <ParticipantName>
                  {room.creator.username}
                  {room.creator.id === user?.id && <SelfTag> (you)</SelfTag>}
                </ParticipantName>
                <HostChip>HOST</HostChip>
              </ParticipantRow>
            )}

            {/* Other participants */}
            {participants
              .filter(p => p.id !== room.creatorId)
              .map(participant => (
                <ParticipantRow key={participant.id}>
                  <Avatar>{participant.username[0].toUpperCase()}</Avatar>
                  <ParticipantName>
                    {participant.username}
                    {participant.id === user?.id && <SelfTag> (you)</SelfTag>}
                  </ParticipantName>
                </ParticipantRow>
              ))}
          </ParticipantsPanel>

          <ChatPanel roomCode={room.code} />
        </SideColumn>
      </Grid>

      {showSettings && isHost && (
        <SettingsSlot>
          <RoomSettings
            room={room}
            onClose={() => setShowSettings(false)}
            onUpdate={() => fetchRoomDetails()}
          />
        </SettingsSlot>
      )}
    </Page>
  );
};
