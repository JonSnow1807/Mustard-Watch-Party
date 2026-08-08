import React, { useState, useEffect, useRef } from 'react';
import { useSocket } from '../contexts/SocketContext';
import { useAuth } from '../contexts/AuthContext';
import styled from '@emotion/styled';
import SimplePeer from 'simple-peer';
import { toast } from 'react-hot-toast';
import {
  color,
  font,
  radius,
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
  IconMic,
  IconMicOff,
  IconHeadphones,
  IconHeadphonesOff,
  IconLeave,
} from './Icons';

const VoiceContainer = styled.div`
  ${card}
  padding: 16px;
`;

const Header = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
`;

const HeaderLeft = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
`;

const Title = styled.h3`
  ${sectionLabel}
  margin: 0;
`;

/** Static count chip - mono because the number is a count of people in voice. */
const CountChip = styled.span`
  ${chip.sm}
  ${chipStatic}
  ${chipMono}
`;

const ControlButtons = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`;

const JoinButton = styled.button`
  ${button.secondary}
  ${buttonSm}
`;

/**
 * In-voice toggles: md chip-buttons, so they swap places with the sm
 * buttons in the top bar without the row resizing. `active` means the
 * capability is ON (mic live, ears open) and takes the mustard tint.
 */
const ControlButton = styled.button<{ active?: boolean }>`
  ${chip.md}
  ${chipInteractive}

  ${props =>
    props.active
      ? `
    background: ${color.mustardFaint};
    border-color: ${color.mustardDeep};
    color: ${color.mustard};
    &:hover {
      background: ${color.mustardFaint};
      border-color: ${color.mustardDeep};
      color: ${color.mustard};
    }
  `
      : ''}

  &:disabled {
    color: ${color.faint};
    border-color: ${color.line};
    cursor: not-allowed;
  }
`;

/** Leave is the same action as the room top bar's - so it is the same button. */
const LeaveButton = styled.button`
  ${button.danger}
  ${buttonSm}
`;

const ParticipantsGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 8px;
`;

const ParticipantCard = styled.div<{ isSpeaking: boolean; isDeafened: boolean }>`
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 8px 10px;
  border-radius: ${radius.md};
  background: ${props => (props.isSpeaking ? color.mustardFaint : color.bg2)};
  border: 1px solid ${props => (props.isSpeaking ? color.mustard : color.line)};
  opacity: ${props => (props.isDeafened ? 0.65 : 1)};
  transition: background 150ms ease, border-color 150ms ease, opacity 150ms ease;
`;

const Avatar = styled.div`
  width: 26px;
  height: 26px;
  flex: none;
  border-radius: 50%;
  background: ${color.bg3};
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: ${font.display};
  font-weight: 600;
  font-size: 12px;
  color: ${color.mustard};
`;

const Username = styled.div`
  flex: 1;
  min-width: 0;
  font-family: ${font.body};
  font-size: 13px;
  color: ${color.text};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const VoiceStatus = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
`;

/**
 * `off` = this participant has the thing switched off (muted / deafened).
 * Off is the state worth reading across the grid, so it carries the danger
 * hue alongside the struck-through icon; on is a quiet faint glyph that
 * holds the row's width without asking for attention.
 */
const StatusIcon = styled.span<{ off: boolean }>`
  display: inline-flex;
  color: ${props => (props.off ? color.danger : color.faint)};
`;

const ConnectionInfo = styled.div`
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid ${color.line};
`;

const InfoRow = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;

  & + & {
    margin-top: 8px;
  }
`;

const InfoLabel = styled.span`
  ${sectionLabel}
`;

const InfoValue = styled.span<{ ok?: boolean }>`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: ${font.body};
  font-size: 12px;
  color: ${props => (props.ok ? color.ok : color.dim)};
`;

/** Quiet and centered, no border - this already sits inside the panel card. */
const EmptyState = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 24px 12px;
  text-align: center;
  font-family: ${font.body};
  font-size: 13.5px;
  color: ${color.dim};

  p {
    margin: 0;
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
        toast.success(`${data.username} joined voice`);
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
    // intentional: reconnecting voice on every render of createPeerConnection would churn peers
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      toast.success('Joined voice');
    } catch (error) {
      console.error('Failed to join voice:', error);
      toast.error("Couldn't access the microphone. Check browser permissions.");
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
    toast.success('Left voice');
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

  return (
    <VoiceContainer>
      <Header>
        <HeaderLeft>
          <Title>Voice</Title>
          {isInVoice && <CountChip>{voiceUsers.length} in voice</CountChip>}
        </HeaderLeft>

        <ControlButtons>
          {!isInVoice ? (
            <JoinButton onClick={handleJoinVoice}>
              <IconMic size={14} />
              Join voice
            </JoinButton>
          ) : (
            <>
              <ControlButton
                active={!isMuted}
                onClick={handleToggleMute}
                title={isMuted ? 'Unmute' : 'Mute'}
              >
                {isMuted ? <IconMicOff size={14} /> : <IconMic size={14} />}
                {isMuted ? 'Muted' : 'Unmuted'}
              </ControlButton>

              <ControlButton
                active={!isDeafened}
                onClick={handleToggleDeafen}
                title={isDeafened ? 'Undeafen' : 'Deafen'}
              >
                {isDeafened ? <IconHeadphonesOff size={14} /> : <IconHeadphones size={14} />}
                {isDeafened ? 'Deafened' : 'Listening'}
              </ControlButton>

              <LeaveButton onClick={handleLeaveVoice}>
                <IconLeave size={14} />
                Leave
              </LeaveButton>
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
                  isDeafened={isDeafened}
                >
                  <Avatar>{user.username?.[0]?.toUpperCase() ?? '?'}</Avatar>
                  <Username>{user.username} (you)</Username>
                  <VoiceStatus>
                    <StatusIcon off={isMuted} title={isMuted ? 'Muted' : 'Unmuted'}>
                      {isMuted ? <IconMicOff size={13} /> : <IconMic size={13} />}
                    </StatusIcon>
                    <StatusIcon off={isDeafened} title={isDeafened ? 'Deafened' : 'Listening'}>
                      {isDeafened ? <IconHeadphonesOff size={13} /> : <IconHeadphones size={13} />}
                    </StatusIcon>
                  </VoiceStatus>
                </ParticipantCard>
              )}

              {/* Other users */}
              {voiceUsers.map(voiceUser => (
                <ParticipantCard
                  key={voiceUser.userId}
                  isSpeaking={speakingUsers.has(voiceUser.userId)}
                  isDeafened={voiceUser.isDeafened}
                >
                  {/* usernames arrive over socket payloads - an empty one must not throw */}
                  <Avatar>{voiceUser.username?.[0]?.toUpperCase() ?? '?'}</Avatar>
                  <Username>{voiceUser.username}</Username>
                  <VoiceStatus>
                    <StatusIcon
                      off={voiceUser.isMuted}
                      title={voiceUser.isMuted ? 'Muted' : 'Unmuted'}
                    >
                      {voiceUser.isMuted ? <IconMicOff size={13} /> : <IconMic size={13} />}
                    </StatusIcon>
                    <StatusIcon
                      off={voiceUser.isDeafened}
                      title={voiceUser.isDeafened ? 'Deafened' : 'Listening'}
                    >
                      {voiceUser.isDeafened ? (
                        <IconHeadphonesOff size={13} />
                      ) : (
                        <IconHeadphones size={13} />
                      )}
                    </StatusIcon>
                  </VoiceStatus>
                </ParticipantCard>
              ))}
            </ParticipantsGrid>
          ) : (
            <EmptyState>
              <p>No one in voice yet.</p>
            </EmptyState>
          )}

          {/*
            Only claims this file can back: noise suppression is an actual
            getUserMedia constraint requested in handleJoinVoice. Connection
            quality and codec used to be hardcoded here with nothing measuring
            them - no getStats(), no SDP inspection - so they are gone.
          */}
          <ConnectionInfo>
            <InfoRow>
              <InfoLabel>Noise suppression</InfoLabel>
              <InfoValue ok>Enabled</InfoValue>
            </InfoRow>
          </ConnectionInfo>
        </>
      ) : (
        <EmptyState>
          <p>Join and talk while you watch.</p>
        </EmptyState>
      )}
    </VoiceContainer>
  );
};
