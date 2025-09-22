import React, { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { apiService } from '../services/api';
import { toast } from 'react-hot-toast';
import styled from '@emotion/styled';

const Container = styled.div`
  max-width: 600px;
  margin: 0 auto;
  padding: 2rem;
  min-height: 100vh;
  position: relative;
  background: linear-gradient(to bottom, #ffffff, #fafafa);

  &::before {
    content: '';
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: radial-gradient(circle at 20% 80%, rgba(99, 102, 241, 0.03) 0%, transparent 50%),
                radial-gradient(circle at 80% 20%, rgba(139, 92, 246, 0.03) 0%, transparent 50%);
    pointer-events: none;
    z-index: -1;
  }
`;

const Header = styled.header`
  text-align: center;
  margin-bottom: 3rem;
  animation: fadeIn 1s ease-out;
`;

const Title = styled.h1`
  font-size: 3.5rem;
  font-weight: 700;
  margin-bottom: 1rem;
  background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #10b981 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;

  @media (max-width: 768px) {
    font-size: 2.5rem;
  }
`;

const Subtitle = styled.p`
  font-size: 1.2rem;
  color: #718096;
  margin-bottom: 2rem;
  animation: fadeIn 1s ease-out 0.2s both;
`;

const Form = styled.form`
  background: #ffffff;
  backdrop-filter: blur(20px);
  border: 1px solid #e2e8f0;
  border-radius: 20px;
  padding: 3rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
  animation: fadeIn 1s ease-out 0.4s both;

  @media (max-width: 768px) {
    padding: 2rem;
  }
`;

const FormGroup = styled.div`
  margin-bottom: 2rem;
`;

const Label = styled.label`
  display: block;
  margin-bottom: 0.75rem;
  font-weight: 600;
  color: #4a5568;
  font-size: 1rem;
`;

const Input = styled.input`
  width: 100%;
  padding: 1rem 1.25rem;
  background: #fcfcfc;
  border: 2px solid #e2e8f0;
  border-radius: 12px;
  font-size: 1rem;
  color: #2d3748;
  transition: all 0.3s ease;
  backdrop-filter: blur(10px);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);

  &::placeholder {
    color: #a0aec0;
  }

  &:focus {
    outline: none;
    border-color: rgba(99, 102, 241, 0.3);
    box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
    background: #ffffff;
  }

  &:hover {
    border-color: #cbd5e1;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.07);
  }
`;

const Button = styled.button`
  width: 100%;
  padding: 1.25rem;
  background: #6366f1;
  color: white;
  border: none;
  border-radius: 12px;
  font-size: 1.1rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);

  &:hover {
    transform: translateY(-1px);
    background: #5558e3;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.07);
  }

  &:disabled {
    background: #e2e8f0;
    color: #a0aec0;
    cursor: not-allowed;
    transform: none;
    box-shadow: none;
  }

  &:active {
    transform: translateY(0);
  }
`;

const BackButton = styled.button`
  padding: 0.75rem 1.5rem;
  background: #f8fafc;
  color: #718096;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  cursor: pointer;
  margin-bottom: 2rem;
  font-weight: 500;
  transition: all 0.3s ease;
  backdrop-filter: blur(10px);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);

  &:hover {
    background: #f1f5f9;
    border-color: #cbd5e1;
    transform: translateY(-1px);
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.07);
  }
`;

const RoomInfo = styled.div`
  background: #ffffff;
  backdrop-filter: blur(20px);
  border: 1px solid #e2e8f0;
  border-radius: 16px;
  padding: 2rem;
  margin-bottom: 2rem;
  border-left: 4px solid #6366f1;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
  animation: slideIn 0.6s ease-out;
`;

const RoomName = styled.h3`
  margin: 0 0 1rem 0;
  color: #2d3748;
  font-size: 1.5rem;
  font-weight: 600;
`;

const RoomDescription = styled.p`
  margin: 0;
  color: #718096;
  font-size: 1rem;
  line-height: 1.5;
`;

const RoomMeta = styled.div`
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid #e2e8f0;
  color: #a0aec0;
  font-size: 0.9rem;
`;

const LoadingSpinner = styled.div`
  text-align: center;
  padding: 4rem 2rem;
  color: #718096;
  font-size: 1.1rem;

  .spinner {
    margin-bottom: 1rem;
  }
`;

const PublicBadge = styled.span`
  display: inline-block;
  padding: 0.5rem 1rem;
  background: rgba(16, 185, 129, 0.1);
  color: #10b981;
  border-radius: 8px;
  font-size: 0.9rem;
  font-weight: 600;
  border: 1px solid rgba(16, 185, 129, 0.3);
  margin-bottom: 1rem;
`;

const PrivateBadge = styled.span`
  display: inline-block;
  padding: 0.5rem 1rem;
  background: rgba(245, 158, 11, 0.1);
  color: #f59e0b;
  border-radius: 8px;
  font-size: 0.9rem;
  font-weight: 600;
  border: 1px solid rgba(245, 158, 11, 0.3);
  margin-bottom: 1rem;
`;

const HelpText = styled.p`
  font-size: 0.9rem;
  color: #a0aec0;
  margin-top: 0.5rem;
  line-height: 1.4;
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
      <Container>
        <Header>
          <Title>Join Watch Party</Title>
          <Subtitle>Please login to join a synchronized video experience</Subtitle>
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
          <Title>❌ Party Not Found</Title>
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
        <LoadingSpinner>
          <div className="spinner"></div>
          <span>Loading party information...</span>
        </LoadingSpinner>
      </Container>
    );
  }

  return (
    <Container>
      <BackButton onClick={() => navigate('/')}>
        ← Back to Home
      </BackButton>
      
      <Header>
        <Title>🎬 Join Watch Party</Title>
        <Subtitle>Enter the party to start watching together</Subtitle>
      </Header>

      <RoomInfo>
        <RoomName>{roomInfo.name}</RoomName>
        {roomInfo.description && (
          <RoomDescription>{roomInfo.description}</RoomDescription>
        )}
        <RoomMeta>
          Created by {roomInfo.creator?.username || 'Unknown'}
        </RoomMeta>
        
        {roomInfo.isPublic ? (
          <PublicBadge>🌍 Public Party</PublicBadge>
        ) : (
          <PrivateBadge>🔒 Private Party</PrivateBadge>
        )}
      </RoomInfo>

      <Form onSubmit={handleJoinRoom}>
        {roomInfo.isPublic ? (
          <>
            <p style={{ textAlign: 'center', color: '#718096', marginBottom: '2rem', fontSize: '1.1rem' }}>
              This is a public watch party. Anyone can join!
            </p>
            <Button type="button" onClick={handleJoinPublicRoom}>
              🎉 Join Public Party
            </Button>
          </>
        ) : (
          <>
            <FormGroup>
              <Label htmlFor="password">Party Password</Label>
              <Input
                id="password"
                type="password"
                placeholder="Enter party password (if required)"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <HelpText>
                This is a private watch party. You may need a password to join.
              </HelpText>
            </FormGroup>
            
            <Button type="submit" disabled={loading}>
              {loading ? 'Joining...' : 'Join Private Party'}
            </Button>
          </>
        )}
      </Form>
    </Container>
  );
}; 