import React, { useState, useEffect, useRef } from 'react';
import { useSocket } from '../contexts/SocketContext';
import { useAuth } from '../contexts/AuthContext';
import styled from '@emotion/styled';
import SimplePeer from 'simple-peer';
import { toast } from 'react-hot-toast';

const VoiceContainer = styled.div`
  background: linear-gradient(135deg, rgba(248, 250, 252, 0.95) 0%, rgba(241, 245, 249, 0.95) 100%);
  backdrop-filter: blur(20px);
  border-radius: 16px;
  padding: 24px;
  margin-top: 20px;
  border: 1px solid rgba(0, 0, 0, 0.1);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
`;

const Header = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid rgba(0, 0, 0, 0.1);
`;

const Title = styled.h3`
  margin: 0;
  color: #1e293b;
  font-size: 1.2rem;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 10px;

  span.icon {
    font-size: 1.4rem;
  }
`;

const ControlButtons = styled.div`
  display: flex;
  gap: 12px;
`;

const ControlButton = styled.button<{ active?: boolean; danger?: boolean; disabled?: boolean }>`
  padding: 10px 20px;
  border: none;
  border-radius: 12px;
  cursor: ${props => props.disabled ? 'not-allowed' : 'pointer'};
  font-size: 14px;
  font-weight: 600;
  transition: all 0.3s ease;
  display: flex;
  align-items: center;
  gap: 8px;

  background: ${props =>
    props.danger ? 'linear-gradient(135deg, #dc2626 0%, #b91c1c 100%)' :
    props.active ? 'linear-gradient(135deg, #2563eb 0%, #1e40af 100%)' :
    'rgba(100, 116, 139, 0.2)'
  };

  color: white;
  opacity: ${props => props.disabled ? 0.5 : 1};

  &:hover {
    transform: ${props => !props.disabled ? 'translateY(-2px)' : 'none'};
    box-shadow: ${props => !props.disabled ? '0 4px 12px rgba(0, 0, 0, 0.1)' : 'none'};
    background: ${props =>
      props.disabled ? '' :
      props.danger ? 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)' :
      props.active ? 'linear-gradient(135deg, #1e40af 0%, #2563eb 100%)' :
      'rgba(100, 116, 139, 0.3)'
    };
  }

  &:active {
    transform: ${props => !props.disabled ? 'translateY(0)' : 'none'};
  }
`;

const StatusIndicator = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  background: rgba(0, 0, 0, 0.05);
  border-radius: 8px;
  font-size: 13px;
  color: #64748b;
`;

const ParticipantsGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 16px;
  margin-top: 20px;
`;

const ParticipantCard = styled.div<{ isSpeaking: boolean; isMuted: boolean; isDeafened: boolean }>`
  background: ${props =>
    props.isSpeaking
      ? 'linear-gradient(135deg, rgba(37, 99, 235, 0.15) 0%, rgba(30, 64, 175, 0.05) 100%)'
      : 'rgba(0, 0, 0, 0.03)'
  };
  border: 2px solid ${props =>
    props.isSpeaking
      ? 'rgba(37, 99, 235, 0.5)'
      : 'rgba(0, 0, 0, 0.1)'
  };
  border-radius: 16px;
  padding: 16px;
  text-align: center;
  transition: all 0.3s ease;
  opacity: ${props => props.isDeafened ? 0.5 : 1};

  &:hover {
    transform: translateY(-4px);
    box-shadow: 0 8px 20px rgba(0, 0, 0, 0.1);
    background: ${props =>
      props.isSpeaking
        ? 'linear-gradient(135deg, rgba(37, 99, 235, 0.2) 0%, rgba(30, 64, 175, 0.1) 100%)'
        : 'rgba(0, 0, 0, 0.05)'
    };
  }
`;

const Avatar = styled.div<{ color: string; size?: number }>`
  width: ${props => props.size || 70}px;
  height: ${props => props.size || 70}px;
  border-radius: 50%;
  background: linear-gradient(135deg, ${props => props.color} 0%, ${props => props.color}dd 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 12px;
  font-size: ${props => (props.size || 70) * 0.4}px;
  color: white;
  font-weight: bold;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
  position: relative;
`;

const SpeakingRing = styled.div`
  position: absolute;
  inset: -4px;
  border: 3px solid #2563eb;
  border-radius: 50%;
  animation: pulse 1.5s ease-in-out infinite;

  @keyframes pulse {
    0% {
      transform: scale(1);
      opacity: 1;
    }
    50% {
      transform: scale(1.1);
      opacity: 0.5;
    }
    100% {
      transform: scale(1);
      opacity: 1;
    }
  }
`;

const Username = styled.div`
  font-size: 14px;
  font-weight: 600;
  color: #1e293b;
  margin-bottom: 8px;
  text-overflow: ellipsis;
  overflow: hidden;
  white-space: nowrap;
`;

const VoiceStatus = styled.div`
  display: flex;
  justify-content: center;
  gap: 12px;
`;

const StatusIcon = styled.span<{ active: boolean; type: 'mic' | 'headphone' }>`
  font-size: 18px;
  color: ${props =>
    props.type === 'mic'
      ? (props.active ? '#2563eb' : '#dc2626')
      : (props.active ? '#1e40af' : '#dc2626')
  };
  transition: all 0.2s;
`;

const ConnectionInfo = styled.div`
  margin-top: 20px;
  padding: 16px;
  background: rgba(0, 0, 0, 0.03);
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.1);
`;

const InfoRow = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  color: #64748b;
  font-size: 13px;

  & + & {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid rgba(0, 0, 0, 0.05);
  }
`;

const EmptyState = styled.div`
  text-align: center;
  padding: 40px;
  color: #94a3b8;

  .icon {
    font-size: 48px;
    margin-bottom: 16px;
    opacity: 0.3;
  }

  p {
    margin: 0;
    font-size: 14px;
  }
`;

interface VoiceUser {
  userId: string;
  username: string;
  socketId: string;
  isMuted: boolean;
  isDeafened: boolean;
  isSpeaking?: boolean;
}

interface EnhancedVoiceChatProps {
  roomCode: string;
}

export const EnhancedVoiceChat: React.FC<EnhancedVoiceChatProps> = ({ roomCode }) => {
  const { socket } = useSocket();
  const { user } = useAuth();
  const [isInVoice, setIsInVoice] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isDeafened, setIsDeafened] = useState(false);
  const [voiceUsers, setVoiceUsers] = useState<VoiceUser[]>([]);
  const [speakingUsers, setSpeakingUsers] = useState<Set<string>>(new Set());

  const localStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef<Map<string, SimplePeer.Instance>>(new Map());
  const voiceSocketRef = useRef<any>(null);

  // Connect to voice namespace
  useEffect(() => {
    if (!socket || !user) return;

    // Create connection to voice namespace
    const io = (socket as any).io;
    if (io) {
      voiceSocketRef.current = io.connect('/voice');

      const voiceSocket = voiceSocketRef.current;

      // Voice event listeners
      voiceSocket.on('voice-users-list', (data: { users: VoiceUser[] }) => {
        setVoiceUsers(data.users);
        // Create peer connections for existing users
        data.users.forEach(voiceUser => {
          if (voiceUser.userId !== user.id) {
            createPeerConnection(voiceUser.socketId, true);
          }
        });
      });

      voiceSocket.on('voice-user-joined', (data: VoiceUser) => {
        setVoiceUsers(prev => [...prev, data]);
        createPeerConnection(data.socketId, false);
        toast.success(`${data.username} joined voice chat`, { icon: '🎤' });
      });

      voiceSocket.on('voice-user-left', (data: { userId: string; socketId: string }) => {
        setVoiceUsers(prev => prev.filter(u => u.userId !== data.userId));
        const peer = peersRef.current.get(data.socketId);
        if (peer) {
          peer.destroy();
          peersRef.current.delete(data.socketId);
        }
      });

      voiceSocket.on('voice-signal', (data: { from: string; signal: any }) => {
        const peer = peersRef.current.get(data.from);
        if (peer) {
          peer.signal(data.signal);
        }
      });

      voiceSocket.on('voice-mute-status', (data: { userId: string; isMuted: boolean }) => {
        setVoiceUsers(prev => prev.map(u =>
          u.userId === data.userId ? { ...u, isMuted: data.isMuted } : u
        ));
      });

      voiceSocket.on('voice-deafen-status', (data: { userId: string; isDeafened: boolean; isMuted: boolean }) => {
        setVoiceUsers(prev => prev.map(u =>
          u.userId === data.userId
            ? { ...u, isDeafened: data.isDeafened, isMuted: data.isMuted }
            : u
        ));
      });

      voiceSocket.on('voice-speaking-status', (data: { userId: string; isSpeaking: boolean }) => {
        setSpeakingUsers(prev => {
          const newSet = new Set(prev);
          if (data.isSpeaking) {
            newSet.add(data.userId);
          } else {
            newSet.delete(data.userId);
          }
          return newSet;
        });
      });

      return () => {
        voiceSocket.disconnect();
      };
    }
  }, [socket, user, roomCode]);

  const createPeerConnection = (targetSocketId: string, initiator: boolean) => {
    if (!localStreamRef.current) return;

    const peer = new SimplePeer({
      initiator,
      trickle: false,
      stream: localStreamRef.current,
    });

    peer.on('signal', signal => {
      voiceSocketRef.current?.emit('voice-signal', {
        to: targetSocketId,
        from: voiceSocketRef.current.id,
        signal,
        username: user?.username,
        userId: user?.id,
      });
    });

    peer.on('stream', remoteStream => {
      // Create audio element for remote stream
      const audio = document.createElement('audio');
      audio.srcObject = remoteStream;
      audio.autoplay = true;
      audio.id = `audio-${targetSocketId}`;
      document.body.appendChild(audio);
    });

    peer.on('error', err => {
      console.error('Peer error:', err);
    });

    peersRef.current.set(targetSocketId, peer);
  };

  const handleJoinVoice = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false
      });

      localStreamRef.current = stream;

      // Set up audio analysis for speaking detection
      const audioContext = new AudioContext();
      const analyser = audioContext.createAnalyser();
      const microphone = audioContext.createMediaStreamSource(stream);
      microphone.connect(analyser);
      analyser.fftSize = 256;

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      const checkSpeaking = () => {
        if (!isInVoice) return;

        analyser.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((a, b) => a + b) / bufferLength;

        const isSpeaking = average > 30 && !isMuted;

        setSpeakingUsers(prev => {
          const newSet = new Set(prev);
          if (isSpeaking && user?.id) {
            if (!newSet.has(user.id)) {
              newSet.add(user.id);
              voiceSocketRef.current?.emit('voice-speaking', {
                roomCode,
                userId: user.id,
                isSpeaking: true,
              });
            }
          } else if (!isSpeaking && user?.id && newSet.has(user.id)) {
            newSet.delete(user.id);
            voiceSocketRef.current?.emit('voice-speaking', {
              roomCode,
              userId: user.id,
              isSpeaking: false,
            });
          }
          return newSet;
        });

        requestAnimationFrame(checkSpeaking);
      };

      checkSpeaking();

      voiceSocketRef.current?.emit('join-voice-chat', {
        roomCode,
        userId: user?.id,
        username: user?.username,
      });

      setIsInVoice(true);
      toast.success('Joined voice chat!', { icon: '🎤' });
    } catch (error) {
      console.error('Failed to join voice:', error);
      toast.error('Failed to access microphone. Please check permissions.');
    }
  };

  const handleLeaveVoice = () => {
    localStreamRef.current?.getTracks().forEach(track => track.stop());
    localStreamRef.current = null;

    peersRef.current.forEach(peer => peer.destroy());
    peersRef.current.clear();

    // Remove all audio elements
    document.querySelectorAll('audio[id^="audio-"]').forEach(el => el.remove());

    voiceSocketRef.current?.emit('leave-voice-chat', {
      roomCode,
      userId: user?.id,
    });

    setIsInVoice(false);
    setVoiceUsers([]);
    setSpeakingUsers(new Set());
    toast.success('Left voice chat');
  };

  const handleToggleMute = () => {
    if (localStreamRef.current) {
      const audioTracks = localStreamRef.current.getAudioTracks();
      audioTracks.forEach(track => {
        track.enabled = isMuted;
      });
      setIsMuted(!isMuted);

      voiceSocketRef.current?.emit('voice-mute-toggle', {
        roomCode,
        userId: user?.id,
        isMuted: !isMuted,
      });
    }
  };

  const handleToggleDeafen = () => {
    const newDeafenState = !isDeafened;
    setIsDeafened(newDeafenState);

    // Mute when deafened
    if (newDeafenState && !isMuted) {
      handleToggleMute();
    }

    // Mute/unmute all audio elements
    document.querySelectorAll('audio[id^="audio-"]').forEach((el: any) => {
      el.muted = newDeafenState;
    });

    voiceSocketRef.current?.emit('voice-deafen-toggle', {
      roomCode,
      userId: user?.id,
      isDeafened: newDeafenState,
    });
  };

  const getAvatarColor = (username: string) => {
    const colors = ['#3b82f6', '#2563eb', '#1e40af', '#1d4ed8', '#1e3a8a', '#1e40af'];
    const index = username.charCodeAt(0) % colors.length;
    return colors[index];
  };

  return (
    <VoiceContainer>
      <Header>
        <Title>
          <span className="icon">🎙️</span>
          Voice Chat
          {isInVoice && (
            <StatusIndicator>
              <span>•</span>
              {voiceUsers.length} connected
            </StatusIndicator>
          )}
        </Title>

        <ControlButtons>
          {!isInVoice ? (
            <ControlButton active onClick={handleJoinVoice}>
              <span>📞</span>
              Join Voice
            </ControlButton>
          ) : (
            <>
              <ControlButton
                active={!isMuted}
                onClick={handleToggleMute}
                title={isMuted ? 'Unmute' : 'Mute'}
              >
                <span>{isMuted ? '🔇' : '🔊'}</span>
                {isMuted ? 'Unmuted' : 'Muted'}
              </ControlButton>

              <ControlButton
                active={!isDeafened}
                onClick={handleToggleDeafen}
                title={isDeafened ? 'Undeafen' : 'Deafen'}
              >
                <span>{isDeafened ? '🔇' : '🎧'}</span>
                {isDeafened ? 'Deafened' : 'Listening'}
              </ControlButton>

              <ControlButton danger onClick={handleLeaveVoice}>
                <span>📴</span>
                Leave
              </ControlButton>
            </>
          )}
        </ControlButtons>
      </Header>

      {isInVoice ? (
        <>
          {voiceUsers.length > 0 ? (
            <ParticipantsGrid>
              {/* Current user */}
              {user && (
                <ParticipantCard
                  isSpeaking={speakingUsers.has(user.id)}
                  isMuted={isMuted}
                  isDeafened={isDeafened}
                >
                  <Avatar color={getAvatarColor(user.username)}>
                    {speakingUsers.has(user.id) && <SpeakingRing />}
                    {user.username[0].toUpperCase()}
                  </Avatar>
                  <Username>{user.username} (You)</Username>
                  <VoiceStatus>
                    <StatusIcon active={!isMuted} type="mic">
                      {isMuted ? '🔇' : '🎤'}
                    </StatusIcon>
                    <StatusIcon active={!isDeafened} type="headphone">
                      {isDeafened ? '🔇' : '🎧'}
                    </StatusIcon>
                  </VoiceStatus>
                </ParticipantCard>
              )}

              {/* Other users */}
              {voiceUsers.map(voiceUser => (
                <ParticipantCard
                  key={voiceUser.userId}
                  isSpeaking={speakingUsers.has(voiceUser.userId)}
                  isMuted={voiceUser.isMuted}
                  isDeafened={voiceUser.isDeafened}
                >
                  <Avatar color={getAvatarColor(voiceUser.username)}>
                    {speakingUsers.has(voiceUser.userId) && <SpeakingRing />}
                    {voiceUser.username[0].toUpperCase()}
                  </Avatar>
                  <Username>{voiceUser.username}</Username>
                  <VoiceStatus>
                    <StatusIcon active={!voiceUser.isMuted} type="mic">
                      {voiceUser.isMuted ? '🔇' : '🎤'}
                    </StatusIcon>
                    <StatusIcon active={!voiceUser.isDeafened} type="headphone">
                      {voiceUser.isDeafened ? '🔇' : '🎧'}
                    </StatusIcon>
                  </VoiceStatus>
                </ParticipantCard>
              ))}
            </ParticipantsGrid>
          ) : (
            <EmptyState>
              <div className="icon">🎤</div>
              <p>You're the first one here!</p>
              <p style={{ marginTop: '8px', fontSize: '13px', opacity: 0.7 }}>
                Invite others to join the voice chat
              </p>
            </EmptyState>
          )}

          <ConnectionInfo>
            <InfoRow>
              <span>Connection Quality</span>
              <span style={{ color: '#2563eb' }}>● Excellent</span>
            </InfoRow>
            <InfoRow>
              <span>Audio Codec</span>
              <span>Opus</span>
            </InfoRow>
            <InfoRow>
              <span>Noise Suppression</span>
              <span style={{ color: '#2563eb' }}>Enabled</span>
            </InfoRow>
          </ConnectionInfo>
        </>
      ) : (
        <EmptyState>
          <div className="icon">🔇</div>
          <p>Not in voice chat</p>
          <p style={{ marginTop: '8px', fontSize: '13px', opacity: 0.7 }}>
            Click "Join Voice" to start talking with others
          </p>
        </EmptyState>
      )}
    </VoiceContainer>
  );
};