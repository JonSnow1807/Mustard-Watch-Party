import React, { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { apiService } from '../services/api';
import { toast } from 'react-hot-toast';
import styled from '@emotion/styled';

const Container = styled.div`
  max-width: 500px;
  margin: 0 auto;
  padding: 2rem;
`;

const Header = styled.header`
  text-align: center;
  margin-bottom: 2rem;
`;

const Title = styled.h1`
  color: #333;
  font-size: 2.5rem;
  margin-bottom: 0.5rem;
`;

const Subtitle = styled.p`
  color: #666;
  font-size: 1.1rem;
`;

const Form = styled.form`
  background: white;
  border-radius: 12px;
  padding: 2rem;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
`;

const FormGroup = styled.div`
  margin-bottom: 1.5rem;
`;

const Label = styled.label`
  display: block;
  margin-bottom: 0.5rem;
  font-weight: 600;
  color: #333;
`;

const Input = styled.input`
  width: 100%;
  padding: 0.75rem;
  border: 2px solid #e1e5e9;
  border-radius: 8px;
  font-size: 1rem;
  transition: border-color 0.2s;
  
  &:focus {
    outline: none;
    border-color: #007bff;
  }
`;

const Button = styled.button`
  width: 100%;
  padding: 1rem;
  background: #007bff;
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 1.1rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  
  &:hover {
    background: #0056b3;
  }
  
  &:disabled {
    background: #ccc;
    cursor: not-allowed;
  }
`;

const BackButton = styled.button`
  padding: 0.5rem 1rem;
  background: #6c757d;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  margin-bottom: 1rem;
  
  &:hover {
    background: #5a6268;
  }
`;

const RoomInfo = styled.div`
  background: #f8f9fa;
  padding: 1.5rem;
  border-radius: 8px;
  margin-bottom: 1.5rem;
  border-left: 4px solid #007bff;
`;

const RoomName = styled.h3`
  margin: 0 0 0.5rem 0;
  color: #333;
`;

const RoomDescription = styled.p`
  margin: 0;
  color: #666;
  font-size: 0.9rem;
`;

const LoadingSpinner = styled.div`
  text-align: center;
  padding: 2rem;
  color: #666;
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
        const response = await apiService.getRoom(roomCode);
        setRoomInfo(response.data);
        setError(null);
      } catch (error: any) {
        setError('Room not found or you do not have permission to join');
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
      toast.error('Room information not available');
      return;
    }

    setLoading(true);
    try {
      // For now, we'll just navigate to the room
      // In the future, you might want to add password verification here
      navigate(`/room/${roomCode}`);
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to join room');
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
      <Container>
        <Header>
          <Title>Join Room</Title>
          <Subtitle>Please login to join a room</Subtitle>
        </Header>
        <Button onClick={() => navigate('/login')}>Go to Login</Button>
      </Container>
    );
  }

  if (error) {
    return (
      <Container>
        <BackButton onClick={() => navigate('/')}>
          ← Back to Home
        </BackButton>
        
        <Header>
          <Title>❌ Room Not Found</Title>
          <Subtitle>{error}</Subtitle>
        </Header>
        
        <Button onClick={() => navigate('/')}>
          Go Back Home
        </Button>
      </Container>
    );
  }

  if (!roomInfo) {
    return (
      <Container>
        <LoadingSpinner>Loading room information...</LoadingSpinner>
      </Container>
    );
  }

  return (
    <Container>
      <BackButton onClick={() => navigate('/')}>
        ← Back to Home
      </BackButton>
      
      <Header>
        <Title>🎬 Join Room</Title>
        <Subtitle>Enter the room to start watching together</Subtitle>
      </Header>

      <RoomInfo>
        <RoomName>{roomInfo.name}</RoomName>
        {roomInfo.description && (
          <RoomDescription>{roomInfo.description}</RoomDescription>
        )}
        <RoomDescription>
          Created by {roomInfo.creator?.username || 'Unknown'}
        </RoomDescription>
      </RoomInfo>

      <Form onSubmit={handleJoinRoom}>
        {roomInfo.isPublic ? (
          <>
            <p style={{ textAlign: 'center', color: '#666', marginBottom: '1.5rem' }}>
              This is a public room. Anyone can join!
            </p>
            <Button type="button" onClick={handleJoinPublicRoom}>
              Join Public Room
            </Button>
          </>
        ) : (
          <>
            <FormGroup>
              <Label htmlFor="password">Room Password</Label>
              <Input
                id="password"
                type="password"
                placeholder="Enter room password (if required)"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <p style={{ fontSize: '0.9rem', color: '#666', marginTop: '0.25rem' }}>
                This is a private room. You may need a password to join.
              </p>
            </FormGroup>
            
            <Button type="submit" disabled={loading}>
              {loading ? 'Joining...' : 'Join Private Room'}
            </Button>
          </>
        )}
      </Form>
    </Container>
  );
}; 