import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import { useSocket } from '../contexts/SocketContext';
import { VideoPlayer } from '../components/VideoPlayer';
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
  grid-template-columns: 1fr 300px;
  gap: 2rem;
  
  @media (max-width: 768px) {
    grid-template-columns: 1fr;
  }
`;

const VideoSection = styled.div`
  background: #000;
  border-radius: 8px;
  overflow: hidden;
`;

const Sidebar = styled.aside`
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

interface Room {
  id: string;
  name: string;
  code: string;
  videoUrl: string;
  participants: any[];
}

export const RoomPage: React.FC = () => {
  const { roomCode } = useParams<{ roomCode: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { socket, joinRoom, leaveRoom, connected } = useSocket();
  const [participants, setParticipants] = useState<any[]>([]);

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
      // You might want to refresh participants list here
    });

    socket.on('user-left', (data: any) => {
      console.log('User left:', data);
      toast(`Someone left the room`);
    });

    return () => {
      socket.off('room-joined');
      socket.off('user-joined');
      socket.off('user-left');
    };
  }, [socket]);

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
            <div style={{ padding: '2rem', color: 'white', textAlign: 'center' }}>
              No video selected for this room
            </div>
          )}
        </VideoSection>

        <Sidebar>
          <ParticipantList>
            <h3>Participants ({participants.length || room.participants.length})</h3>
            <ul>
              {(participants.length > 0 ? participants : room.participants).map((participant: any, index: number) => (
                <li key={participant.id || index}>
                  <StatusDot active={true} />
                  {participant.username || participant.user?.username || 'Anonymous'}
                  {participant.id === user.id && ' (You)'}
                </li>
              ))}
            </ul>
          </ParticipantList>
        </Sidebar>
      </MainContent>
    </Container>
  );
};