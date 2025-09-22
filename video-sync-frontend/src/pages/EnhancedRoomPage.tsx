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

const Container = styled.div`
  min-height: 100vh;
  background: linear-gradient(to bottom, #ffffff, #fafafa);
  position: relative;
  overflow-x: hidden;

  &::before {
    content: '';
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background:
      radial-gradient(circle at 20% 80%, rgba(99, 102, 241, 0.03) 0%, transparent 50%),
      radial-gradient(circle at 80% 20%, rgba(139, 92, 246, 0.03) 0%, transparent 50%),
      radial-gradient(circle at 40% 40%, rgba(16, 185, 129, 0.02) 0%, transparent 50%);
    pointer-events: none;
    z-index: 0;
  }
`;

const Header = styled.header`
  background: rgba(255, 255, 255, 0.9);
  backdrop-filter: blur(20px);
  border-bottom: 1px solid #e2e8f0;
  padding: 16px 24px;
  position: sticky;
  top: 0;
  z-index: 100;
`;

const HeaderContent = styled.div`
  max-width: 1400px;
  margin: 0 auto;
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 16px;
`;

const RoomInfo = styled.div`
  display: flex;
  align-items: center;
  gap: 20px;
  flex: 1;
`;

const RoomTitle = styled.h1`
  margin: 0;
  font-size: 1.5rem;
  font-weight: 700;
  background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
`;

const RoomCode = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  color: #4a5568;
  font-family: monospace;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);

  &:hover {
    background: #f1f5f9;
    border-color: #cbd5e1;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.07);
  }

  span.icon {
    font-size: 16px;
  }
`;

const HeaderActions = styled.div`
  display: flex;
  gap: 12px;
  align-items: center;
`;

const ActionButton = styled.button<{ variant?: 'primary' | 'danger' | 'ghost' }>`
  padding: 10px 20px;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
  display: flex;
  align-items: center;
  gap: 8px;
  border: ${props =>
    props.variant === 'ghost' ? '1px solid #e2e8f0' : 'none'
  };
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);

  background: ${props => {
    switch(props.variant) {
      case 'danger': return '#f87171';
      case 'ghost': return '#ffffff';
      default: return '#6366f1';
    }
  }};

  color: ${props => props.variant === 'ghost' ? '#2d3748' : 'white'};

  &:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.07);
    background: ${props => {
      switch(props.variant) {
        case 'danger': return '#ef4444';
        case 'ghost': return '#f8fafc';
        default: return '#5558e3';
      }
    }};
  }
`;

const MainContent = styled.main`
  max-width: 1400px;
  margin: 0 auto;
  padding: 24px;
  position: relative;
  z-index: 1;
`;

const ContentGrid = styled.div`
  display: grid;
  grid-template-columns: 1fr 380px;
  gap: 24px;

  @media (max-width: 1024px) {
    grid-template-columns: 1fr;
  }
`;

const VideoSection = styled.div`
  display: flex;
  flex-direction: column;
  gap: 20px;
`;

const SidePanel = styled.div`
  display: flex;
  flex-direction: column;
  gap: 20px;
  height: fit-content;
  position: sticky;
  top: 100px;

  @media (max-width: 1024px) {
    position: relative;
    top: 0;
  }
`;

const ParticipantsList = styled.div`
  background: #ffffff;
  backdrop-filter: blur(20px);
  border: 1px solid #e2e8f0;
  border-radius: 16px;
  padding: 20px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
`;

const ParticipantsHeader = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid #e2e8f0;
`;

const ParticipantsTitle = styled.h3`
  margin: 0;
  color: #2d3748;
  font-size: 1rem;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
`;

const ParticipantCount = styled.span`
  background: #6366f1;
  color: white;
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 600;
`;

const ParticipantItem = styled.div<{ isHost?: boolean }>`
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: ${props =>
    props.isHost
      ? 'rgba(99, 102, 241, 0.05)'
      : '#fcfcfc'
  };
  border: 1px solid ${props =>
    props.isHost
      ? 'rgba(99, 102, 241, 0.2)'
      : '#e2e8f0'
  };
  border-radius: 12px;
  margin-bottom: 8px;
  transition: all 0.2s;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);

  &:hover {
    background: ${props =>
      props.isHost
        ? 'rgba(99, 102, 241, 0.1)'
        : '#f8fafc'
    };
    transform: translateX(2px);
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.07);
  }
`;

const ParticipantAvatar = styled.div<{ color: string }>`
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: linear-gradient(135deg, ${props => props.color} 0%, ${props => props.color}dd 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-weight: bold;
  font-size: 14px;
`;

const ParticipantName = styled.div`
  flex: 1;
  color: #2d3748;
  font-size: 14px;
  font-weight: 500;
`;

const ParticipantBadge = styled.span`
  background: #f59e0b;
  color: white;
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 700;
`;

const LoadingContainer = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  color: #2d3748;
`;

const LoadingSpinner = styled.div`
  width: 60px;
  height: 60px;
  border: 3px solid #e2e8f0;
  border-top: 3px solid #6366f1;
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin-bottom: 20px;

  @keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }
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
      toast.success('Joined room successfully!', { icon: '🎉' });
    };

    const handleUserJoined = (data: { userId: string; username: string }) => {
      setParticipants(prev => {
        if (prev.find(p => p.id === data.userId)) return prev;
        toast(`${data.username} joined the party!`, { icon: '👋' });
        return [...prev, { id: data.userId, username: data.username }];
      });
    };

    const handleUserLeft = (data: { userId: string }) => {
      setParticipants(prev => {
        const user = prev.find(p => p.id === data.userId);
        if (user) {
          toast(`${user.username} left the party`, { icon: '👋' });
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
      toast.error('Failed to load room details');
      navigate('/');
    } finally {
      setLoading(false);
    }
  };

  const handleCopyRoomCode = () => {
    if (room) {
      navigator.clipboard.writeText(room.code);
      setCopySuccess(true);
      toast.success('Room code copied!', { icon: '📋' });
      setTimeout(() => setCopySuccess(false), 2000);
    }
  };

  const handleShareRoom = () => {
    if (room) {
      const shareUrl = `${window.location.origin}/join-room/${room.code}`;
      navigator.clipboard.writeText(shareUrl);
      toast.success('Share link copied!', { icon: '🔗' });
    }
  };

  const handleLeaveRoom = () => {
    if (socket && room) {
      socket.emit('leave-room', { roomCode: room.code, userId: user?.id });
    }
    navigate('/');
    toast.success('Left the room');
  };

  const getAvatarColor = (username: string) => {
    const colors = ['#6366f1', '#8b5cf6', '#10b981', '#f59e0b', '#f97316', '#ef4444'];
    const index = username.charCodeAt(0) % colors.length;
    return colors[index];
  };

  if (loading) {
    return (
      <Container>
        <LoadingContainer>
          <LoadingSpinner />
          <h2>Loading room...</h2>
        </LoadingContainer>
      </Container>
    );
  }

  if (!room) {
    return (
      <Container>
        <LoadingContainer>
          <h2>Room not found</h2>
          <ActionButton onClick={() => navigate('/')}>Go Home</ActionButton>
        </LoadingContainer>
      </Container>
    );
  }

  const isHost = user?.id === room.creatorId;

  return (
    <Container>
      <Header>
        <HeaderContent>
          <RoomInfo>
            <RoomTitle>{room.name}</RoomTitle>
            <RoomCode onClick={handleCopyRoomCode} title="Click to copy">
              <span className="icon">🔑</span>
              {room.code}
              {copySuccess && <span style={{ fontSize: '12px' }}> ✓ Copied!</span>}
            </RoomCode>
          </RoomInfo>

          <HeaderActions>
            <ActionButton variant="ghost" onClick={handleShareRoom}>
              <span>🔗</span>
              Share
            </ActionButton>

            {isHost && (
              <ActionButton variant="ghost" onClick={() => setShowSettings(!showSettings)}>
                <span>⚙️</span>
                Settings
              </ActionButton>
            )}

            <ActionButton variant="danger" onClick={handleLeaveRoom}>
              <span>🚪</span>
              Leave
            </ActionButton>
          </HeaderActions>
        </HeaderContent>
      </Header>

      <MainContent>
        <ContentGrid>
          <VideoSection>
            <EnhancedVideoPlayer
              videoUrl={room.videoUrl}
              roomCode={room.code}
              isHost={isHost}
              allowGuestControl={room.allowGuestControl}
            />

            <EnhancedVoiceChat roomCode={room.code} />
          </VideoSection>

          <SidePanel>
            <ParticipantsList>
              <ParticipantsHeader>
                <ParticipantsTitle>
                  <span>👥</span>
                  Participants
                </ParticipantsTitle>
                <ParticipantCount>{participants.length}</ParticipantCount>
              </ParticipantsHeader>

              {/* Host */}
              {room.creator && (
                <ParticipantItem isHost>
                  <ParticipantAvatar color={getAvatarColor(room.creator.username)}>
                    {room.creator.username[0].toUpperCase()}
                  </ParticipantAvatar>
                  <ParticipantName>
                    {room.creator.username}
                    {room.creator.id === user?.id && ' (You)'}
                  </ParticipantName>
                  <ParticipantBadge>👑 HOST</ParticipantBadge>
                </ParticipantItem>
              )}

              {/* Other participants */}
              {participants
                .filter(p => p.id !== room.creatorId)
                .map(participant => (
                  <ParticipantItem key={participant.id}>
                    <ParticipantAvatar color={getAvatarColor(participant.username)}>
                      {participant.username[0].toUpperCase()}
                    </ParticipantAvatar>
                    <ParticipantName>
                      {participant.username}
                      {participant.id === user?.id && ' (You)'}
                    </ParticipantName>
                  </ParticipantItem>
                ))}
            </ParticipantsList>

            <ChatPanel roomCode={room.code} />
          </SidePanel>
        </ContentGrid>

        {showSettings && isHost && (
          <RoomSettings
            room={room}
            onClose={() => setShowSettings(false)}
            onUpdate={() => fetchRoomDetails()}
          />
        )}
      </MainContent>
    </Container>
  );
};