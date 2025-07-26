import React, { useState, useEffect, useRef } from 'react';
import { useSocket } from '../contexts/SocketContext';
import { useAuth } from '../contexts/AuthContext';
import styled from '@emotion/styled';
import SimplePeer from 'simple-peer';
import { toast } from 'react-hot-toast';

const VoiceContainer = styled.div`
  background: #f5f5f5;
  border-radius: 8px;
  padding: 1.5rem;
  margin-top: 1rem;
`;

const VoiceHeader = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1rem;
`;

const Title = styled.h3`
  margin: 0;
  display: flex;
  align-items: center;
  gap: 0.5rem;
`;

const ControlButtons = styled.div`
  display: flex;
  gap: 0.5rem;
`;

const Button = styled.button<{ active?: boolean; danger?: boolean }>`
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.9rem;
  transition: all 0.2s;
  
  background: ${props => 
    props.danger ? '#dc3545' : 
    props.active ? '#28a745' : 
    '#6c757d'
  };
  color: white;
  
  &:hover {
    opacity: 0.9;
    transform: translateY(-1px);
  }
  
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

const SpeakersList = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 1rem;
  margin-top: 1rem;
`;

const SpeakerCard = styled.div<{ isSpeaking: boolean; isMuted: boolean }>`
  background: white;
  border-radius: 12px;
  padding: 1rem;
  text-align: center;
  box-shadow: 0 2px 5px rgba(0,0,0,0.1);
  border: 2px solid ${props => props.isSpeaking ? '#28a745' : 'transparent'};
  opacity: ${props => props.isMuted ? 0.6 : 1};
  transition: all 0.2s;
`;

const Avatar = styled.div<{ color: string }>`
  width: 60px;
  height: 60px;
  border-radius: 50%;
  background: ${props => props.color};
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 0.5rem;
  font-size: 1.5rem;
  color: white;
  font-weight: bold;
`;

const Username = styled.div`
  font-size: 0.9rem;
  font-weight: 500;
  margin-bottom: 0.25rem;
`;

const MicIcon = styled.span<{ muted: boolean }>`
  font-size: 1.2rem;
  color: ${props => props.muted ? '#dc3545' : '#28a745'};
`;

const JoinPrompt = styled.div`
  text-align: center;
  padding: 2rem;
  background: #e8f4f8;
  border-radius: 8px;
  
  p {
    margin: 0.5rem 0;
    color: #666;
  }
`;

interface VoiceChatProps {
  roomCode: string;
}

interface Peer {
  peerId: string;
  userId: string;
  username: string;
  peer: SimplePeer.Instance;
  stream?: MediaStream;
}

export const VoiceChat: React.FC<VoiceChatProps> = ({ roomCode }) => {
  const { socket } = useSocket();
  const { user } = useAuth();
  const [isInVoiceChat, setIsInVoiceChat] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [speakers, setSpeakers] = useState<Map<string, { username: string; isMuted: boolean; isSpeaking: boolean }>>(new Map());
  const [peers, setPeers] = useState<Map<string, Peer>>(new Map());
  
  const localStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyzersRef = useRef<Map<string, AnalyserNode>>(new Map());

  // Generate color from username
  const getUserColor = (username: string) => {
    const colors = ['#007bff', '#28a745', '#dc3545', '#ffc107', '#17a2b8', '#6610f2', '#e83e8c', '#fd7e14'];
    let hash = 0;
    for (let i = 0; i < username.length; i++) {
      hash = username.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
  };

  useEffect(() => {
    if (!socket || !isInVoiceChat) return;

    // Helper function to add remote stream
    const addRemoteStream = (userId: string, stream: MediaStream) => {
      let audioElement = document.getElementById(`audio-${userId}`) as HTMLAudioElement;
      
      if (!audioElement) {
        audioElement = document.createElement('audio');
        audioElement.id = `audio-${userId}`;
        audioElement.autoplay = true;
        document.body.appendChild(audioElement);
      }
      
      audioElement.srcObject = stream;
    };

    // Move setupAudioAnalyzer inside useEffect to fix dependency warning
    const setupAudioAnalyzer = (userId: string, stream: MediaStream) => {
      if (!audioContextRef.current) return;
      
      const source = audioContextRef.current.createMediaStreamSource(stream);
      const analyzer = audioContextRef.current.createAnalyser();
      analyzer.fftSize = 256;
      source.connect(analyzer);
      
      analyzersRef.current.set(userId, analyzer);
      
      // Check audio levels periodically
      const checkAudioLevel = () => {
        const dataArray = new Uint8Array(analyzer.frequencyBinCount);
        analyzer.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
        
        setSpeakers(prev => {
          const newSpeakers = new Map(prev);
          const speaker = newSpeakers.get(userId);
          if (speaker) {
            speaker.isSpeaking = average > 30; // Threshold for speaking
          }
          return newSpeakers;
        });
        
        if (isInVoiceChat) {
          requestAnimationFrame(checkAudioLevel);
        }
      };
      
      checkAudioLevel();
    };

    // Handle new user joining voice
    socket.on('voice-user-joined', async (data: { userId: string; username: string; peerId: string }) => {
      console.log('User joined voice:', data.username);
      
      if (data.userId === user?.id) return;
      
      // Create new peer connection as initiator
      const peer = new SimplePeer({
        initiator: true,
        trickle: false,
        stream: localStreamRef.current || undefined,
      });

      peer.on('signal', (signal) => {
        socket.emit('voice-signal', {
          roomCode,
          targetUserId: data.userId,
          signal,
        });
      });

      peer.on('stream', (stream) => {
        console.log('Received stream from', data.username);
        // Add audio element to play remote stream
        addRemoteStream(data.userId, stream);
        setupAudioAnalyzer(data.userId, stream);
      });

      peer.on('error', (err) => {
        console.error('Peer error:', err);
      });

      setPeers(prev => new Map(prev).set(data.userId, {
        peerId: data.peerId,
        userId: data.userId,
        username: data.username,
        peer,
      }));

      setSpeakers(prev => new Map(prev).set(data.userId, {
        username: data.username,
        isMuted: false,
        isSpeaking: false,
      }));
    });

    // Handle receiving signals
    socket.on('voice-signal', async (data: { userId: string; username: string; signal: any }) => {
      console.log('Received signal from', data.username);
      
      let peerData = peers.get(data.userId);
      
      if (!peerData) {
        // Create new peer as receiver
        const peer = new SimplePeer({
          initiator: false,
          trickle: false,
          stream: localStreamRef.current || undefined,
        });

        peer.on('signal', (signal) => {
          socket.emit('voice-signal', {
            roomCode,
            targetUserId: data.userId,
            signal,
          });
        });

        peer.on('stream', (stream) => {
          console.log('Received stream from', data.username);
          addRemoteStream(data.userId, stream);
          setupAudioAnalyzer(data.userId, stream);
        });

        peerData = {
          peerId: data.userId,
          userId: data.userId,
          username: data.username,
          peer,
        };

        setPeers(prev => new Map(prev).set(data.userId, peerData!));
        setSpeakers(prev => new Map(prev).set(data.userId, {
          username: data.username,
          isMuted: false,
          isSpeaking: false,
        }));
      }

      peerData.peer.signal(data.signal);
    });

    // Handle user leaving voice
    socket.on('voice-user-left', (data: { userId: string }) => {
      console.log('User left voice:', data.userId);
      
      const peerData = peers.get(data.userId);
      if (peerData) {
        peerData.peer.destroy();
        setPeers(prev => {
          const newPeers = new Map(prev);
          newPeers.delete(data.userId);
          return newPeers;
        });
      }
      
      setSpeakers(prev => {
        const newSpeakers = new Map(prev);
        newSpeakers.delete(data.userId);
        return newSpeakers;
      });
      
      // Remove audio element
      const audioElement = document.getElementById(`audio-${data.userId}`);
      if (audioElement) {
        audioElement.remove();
      }
    });

    // Handle mute status
    socket.on('voice-mute-status', (data: { userId: string; isMuted: boolean }) => {
      setSpeakers(prev => {
        const newSpeakers = new Map(prev);
        const speaker = newSpeakers.get(data.userId);
        if (speaker) {
          speaker.isMuted = data.isMuted;
        }
        return newSpeakers;
      });
    });

    return () => {
      socket.off('voice-user-joined');
      socket.off('voice-signal');
      socket.off('voice-user-left');
      socket.off('voice-mute-status');
    };
  }, [socket, isInVoiceChat, user, peers, roomCode]);

  const joinVoiceChat = async () => {
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
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      
      setIsInVoiceChat(true);
      
      // Notify others
      socket?.emit('join-voice', {
        roomCode,
        userId: user?.id,
        username: user?.username,
      });
      
      // Add self to speakers
      setSpeakers(prev => new Map(prev).set(user!.id, {
        username: user!.username,
        isMuted: false,
        isSpeaking: false,
      }));
      
      toast.success('Joined voice chat!');
    } catch (error) {
      console.error('Error accessing microphone:', error);
      toast.error('Could not access microphone. Please check permissions.');
    }
  };

  const leaveVoiceChat = () => {
    // Stop local stream
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
    }
    
    // Destroy all peer connections
    peers.forEach(peerData => {
      peerData.peer.destroy();
    });
    setPeers(new Map());
    setSpeakers(new Map());
    
    // Notify others
    socket?.emit('leave-voice', {
      roomCode,
      userId: user?.id,
    });
    
    setIsInVoiceChat(false);
    setIsMuted(false);
    
    toast('Left voice chat');
  };

  const toggleMute = () => {
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsMuted(!audioTrack.enabled);
        
        // Notify others
        socket?.emit('voice-mute', {
          roomCode,
          userId: user?.id,
          isMuted: !audioTrack.enabled,
        });
      }
    }
  };

  if (!isInVoiceChat) {
    return (
      <VoiceContainer>
        <JoinPrompt>
          <h3>🎤 Voice Chat</h3>
          <p>Join the voice chat to talk with others while watching!</p>
          <Button active onClick={joinVoiceChat}>
            Join Voice Chat
          </Button>
        </JoinPrompt>
      </VoiceContainer>
    );
  }

  return (
    <VoiceContainer>
      <VoiceHeader>
        <Title>
          🎤 Voice Chat ({speakers.size} {speakers.size === 1 ? 'person' : 'people'})
        </Title>
        <ControlButtons>
          <Button active={!isMuted} onClick={toggleMute}>
            {isMuted ? '🔇 Unmute' : '🔊 Mute'}
          </Button>
          <Button danger onClick={leaveVoiceChat}>
            Leave
          </Button>
        </ControlButtons>
      </VoiceHeader>
      
      <SpeakersList>
        {Array.from(speakers.entries()).map(([userId, speaker]) => (
          <SpeakerCard 
            key={userId} 
            isSpeaking={speaker.isSpeaking && !speaker.isMuted}
            isMuted={speaker.isMuted}
          >
            <Avatar color={getUserColor(speaker.username)}>
              {speaker.username.charAt(0).toUpperCase()}
            </Avatar>
            <Username>{speaker.username}</Username>
            <MicIcon muted={speaker.isMuted}>
              {speaker.isMuted ? '🔇' : '🎤'}
            </MicIcon>
          </SpeakerCard>
        ))}
      </SpeakersList>
    </VoiceContainer>
  );
};