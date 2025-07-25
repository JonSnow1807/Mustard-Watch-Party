import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import { useSocket } from '../contexts/SocketContext';
import { VideoPlayer } from '../components/VideoPlayer';
import { VoiceChat } from '../components/VoiceChat';
import { ChatPanel } from '../components/ChatPanel';
import { RoomSettings } from '../components/RoomSettings';
import { apiService } from '../services/api';
import styled from '@emotion/styled';
import { toast } from 'react-hot-toast';

const Container = styled.div`
  max-width: 1400px;
  margin: 0 auto;
  padding: 2rem;
`;

const Header = styled.header`
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 2rem;
`;

const RoomInfo = styled.div`
  h1 {
    margin: 0;
    color: #333;
  }
  
  p {
    margin: 0.5rem 0;
    color: #666;
  }
`;

const MainContent = styled.div`
  display: grid;
  grid-template-columns: 1fr 350px;
  gap: 2rem;
  
  @media (max-width: 1024px) {
    grid-template-columns: 1fr;
  }
`;

const VideoSection = styled.div`
  border-radius: 8px;
  overflow: hidden;
  
  @media (max-width: 768px) {
    margin: 0 -1rem;
    border-radius: 0;
  }
`;

const Sidebar = styled.aside`
  display: flex;
  flex-direction: column;
  gap: 1rem;
  
  @media (max-width: 1024px) {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 1rem;
  }
  
  @media (max-width: 768px) {
    grid-template-columns: 1fr;
  }
`;

const SidebarSection = styled.div`
  background: #f5f5f5;
  border-radius: 8px;
  padding: 1.5rem;
`;

const ParticipantList = styled.div`
  h3 {
    margin-top: 0;
  }
  
  ul {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  
  li {
    padding: 0.5rem;
    margin: 0.5rem 0;
    background: white;
    border-radius: 4px;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
`;

const StatusDot = styled.div<{ active: boolean }>`
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: ${props => props.active ? '#4CAF50' : '#ccc'};
`;

const Button = styled.button`
  padding: 0.5rem 1rem;
  background: #dc3545;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  
  &:hover {
    background: #c82333;
  }
`;

const CopyButton = styled.button`
  padding: 0.5rem 1rem;
  background: #28a745;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  margin-left: 1rem;
  
  &:hover {
    background: #218838;
  }
`;

const NoVideoMessage = styled.div`
  padding: 2rem;
  color: white;
  text-align: center;
  background: #000;
  aspect-ratio: 16 / 9;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
`;

interface Participant {
  id: string;
  username: string;
  user?: {
    id: string;
    username: string;
  };
}

interface Room {
  id: string;
  name: string;
  code: string;
  videoUrl: string;
  participants: Participant[];
  creatorId: string;
  isPublic?: boolean;
  maxUsers?: number;
}

export const RoomPage: React.FC = () => {
  const { roomCode } = useParams<{ roomCode: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { socket, joinRoom, leaveRoom, connected } = useSocket();
  const [participants, setParticipants] = useState<Participant[]>([]);

  // Fetch room data
  const { data: room, isLoading, error } = useQuery<Room>({
    queryKey: ['room', roomCode],
    queryFn: async () => {
      const response = await apiService.getRoom(roomCode!);
      return response.data;
    },
    enabled: !!roomCode,
  });

  // Join room when component mounts
  useEffect(() => {
    if (connected && roomCode && user && room) {
      joinRoom(roomCode, user.id);
    }

    return () => {
      if (connected) {
        leaveRoom();
      }
    };
  }, [connected, roomCode, user, room, joinRoom, leaveRoom]);

  // Listen for socket events
  useEffect(() => {
    if (!socket) return;

    socket.on('room-joined', (data: any) => {
      console.log('Joined room:', data);
      setParticipants(data.participants || []);
    });

    socket.on('user-joined', (data: any) => {
      console.log('User joined:', data);
      toast(`${data.username || 'Someone'} joined the room`);
      
      // Update participants list
      setParticipants(prev => {
        // Check if user already exists
        const exists = prev.some(p => p.id === data.userId || p.user?.id === data.userId);
        if (exists) return prev;
        
        // Add new participant
        return [...prev, {
          id: data.userId,
          username: data.username || 'Anonymous',
          user: {
            id: data.userId,
            username: data.username || 'Anonymous'
          }
        }];
      });
    });

    socket.on('user-left', (data: any) => {
      console.log('User left:', data);
      
      // Find username for better notification
      const leavingUser = participants.find(p => p.id === data.userId || p.user?.id === data.userId);
      toast(`${leavingUser?.username || leavingUser?.user?.username || 'Someone'} left the room`);
      
      // Update participants list
      setParticipants(prev => prev.filter(p => p.id !== data.userId && p.user?.id !== data.userId));
    });

    // Add a listener for participants updates
    socket.on('participants-update', (data: any) => {
      console.log('Participants update:', data);
      setParticipants(data.participants || []);
    });

    return () => {
      socket.off('room-joined');
      socket.off('user-joined');
      socket.off('user-left');
      socket.off('participants-update');
    };
  }, [socket, participants]);

  // Periodic participants refresh to handle any sync issues
  useEffect(() => {
    if (!connected || !roomCode || !socket) return;

    // Request participants update every 30 seconds
    const interval = setInterval(() => {
      socket.emit('request-participants', { roomCode });
    }, 30000);

    // Request immediately on mount
    setTimeout(() => {
      socket.emit('request-participants', { roomCode });
    }, 1000);

    return () => clearInterval(interval);
  }, [connected, roomCode, socket]);

  const handleLeaveRoom = () => {
    leaveRoom();
    navigate('/');
  };

  const handleCopyRoomCode = () => {
    if (roomCode) {
      navigator.clipboard.writeText(roomCode);
      toast.success('Room code copied to clipboard!');
    }
  };

  if (!user) {
    navigate('/login');
    return null;
  }

  if (isLoading) return <Container>Loading room...</Container>;
  if (error) return <Container>Error loading room</Container>;
  if (!room) return <Container>Room not found</Container>;

  return (
    <Container>
      <Header>
        <RoomInfo>
          <h1>{room.name}</h1>
          <p>
            Room Code: <strong>{room.code}</strong>
            <CopyButton onClick={handleCopyRoomCode}>Copy Code</CopyButton>
          </p>
        </RoomInfo>
        <Button onClick={handleLeaveRoom}>Leave Room</Button>
      </Header>

      <MainContent>
        <VideoSection>
          {room.videoUrl ? (
            <VideoPlayer videoUrl={room.videoUrl} roomCode={roomCode!} />
          ) : (
            <NoVideoMessage>
              No video selected for this room
            </NoVideoMessage>
          )}
        </VideoSection>

        <Sidebar>
          <SidebarSection>
            <ParticipantList>
              <h3>Participants ({participants.length || room.participants.length})</h3>
              <ul>
                {(participants.length > 0 ? participants : room.participants).map((participant: Participant, index: number) => {
                  const userId = participant.id || participant.user?.id;
                  const username = participant.username || participant.user?.username || 'Anonymous';
                  const isCurrentUser = userId === user.id;
                  
                  return (
                    <li key={userId || index}>
                      <StatusDot active={true} />
                      {username}
                      {isCurrentUser && ' (You)'}
                    </li>
                  );
                })}
              </ul>
            </ParticipantList>
          </SidebarSection>
          
          <VoiceChat roomCode={roomCode!} />
          
          <ChatPanel roomCode={roomCode!} />
          
          {room.creatorId === user.id && (
            <RoomSettings 
              room={room} 
              isHost={true} 
              onUpdate={() => window.location.reload()} 
            />
          )}
        </Sidebar>
      </MainContent>
    </Container>
  );
};