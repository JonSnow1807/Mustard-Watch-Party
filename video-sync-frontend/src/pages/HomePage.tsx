import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import axios from 'axios';
import { toast } from 'react-hot-toast';
import { PublicRooms } from '../components/PublicRooms';
import styled from '@emotion/styled';

const Container = styled.div`
  max-width: 800px;
  margin: 0 auto;
  padding: 2rem;
`;

const Header = styled.header`
  text-align: center;
  margin-bottom: 3rem;
`;

const Title = styled.h1`
  color: #333;
  font-size: 3rem;
  margin-bottom: 1rem;
`;

const Section = styled.section`
  background: #f5f5f5;
  border-radius: 8px;
  padding: 2rem;
  margin-bottom: 2rem;
`;

const Form = styled.form`
  display: flex;
  flex-direction: column;
  gap: 1rem;
`;

const Input = styled.input`
  padding: 0.75rem;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 1rem;
`;

const Button = styled.button`
  padding: 0.75rem 1.5rem;
  background: #007bff;
  color: white;
  border: none;
  border-radius: 4px;
  font-size: 1rem;
  cursor: pointer;
  
  &:hover {
    background: #0056b3;
  }
  
  &:disabled {
    background: #ccc;
    cursor: not-allowed;
  }
`;

const UserInfo = styled.div`
  background: #e8f4f8;
  padding: 1rem;
  border-radius: 4px;
  margin-bottom: 1rem;
`;

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:3000/api';

export const HomePage: React.FC = () => {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [roomName, setRoomName] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [isPublic, setIsPublic] = useState(false);
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');

  const handleCreateRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) {
      toast.error('Please login first');
      navigate('/login');
      return;
    }

    setLoading(true);
    try {
      const response = await axios.post(`${API_URL}/rooms`, {
        name: roomName,
        videoUrl,
        userId: user.id,
        isPublic,
        description: isPublic ? description : undefined,
        tags: isPublic && tags ? tags.split(',').map(t => t.trim()) : [],
      });
      
      toast.success('Room created successfully!');
      navigate(`/room/${response.data.code}`);
    } catch (error) {
      toast.error('Failed to create room');
    } finally {
      setLoading(false);
    }
  };

  const handleJoinRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!roomCode.trim()) {
      toast.error('Please enter a room code');
      return;
    }
    
    // Verify room exists
    try {
      await axios.get(`${API_URL}/rooms/${roomCode}`);
      navigate(`/room/${roomCode}`);
    } catch (error) {
      toast.error('Room not found');
    }
  };

  if (!user) {
    return (
      <Container>
        <Header>
          <Title>🎬 Video Sync Platform</Title>
          <p>Watch videos together in perfect sync!</p>
        </Header>
        
        <Section>
          <h2>Welcome! Please login to continue</h2>
          <Button onClick={() => navigate('/login')}>Go to Login</Button>
        </Section>
      </Container>
    );
  }

  return (
    <Container>
      <Header>
        <Title>🎬 Video Sync Platform</Title>
        <UserInfo>
          Welcome, {user.username}! 
          <Button onClick={logout} style={{ marginLeft: '1rem', padding: '0.5rem 1rem' }}>
            Logout
          </Button>
        </UserInfo>
      </Header>

      <Section>
        <h2>Create a New Room</h2>
        <Form onSubmit={handleCreateRoom}>
          <Input
            type="text"
            placeholder="Room Name"
            value={roomName}
            onChange={(e) => setRoomName(e.target.value)}
            required
          />
          <Input
            type="url"
            placeholder="Video URL (YouTube, Vimeo, etc.)"
            value={videoUrl}
            onChange={(e) => setVideoUrl(e.target.value)}
            required
          />
          
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <input
              type="checkbox"
              checked={isPublic}
              onChange={(e) => setIsPublic(e.target.checked)}
            />
            Make this room public (anyone can join)
          </label>
          
          {isPublic && (
            <>
              <Input
                type="text"
                placeholder="Room description (optional)"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={200}
              />
              <Input
                type="text"
                placeholder="Tags (comma separated, e.g., movies, horror, friends)"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
              />
            </>
          )}
          <Button type="submit" disabled={loading}>
            {loading ? 'Creating...' : 'Create Room'}
          </Button>
        </Form>
      </Section>

      <Section>
        <h2>Join an Existing Room</h2>
        <Form onSubmit={handleJoinRoom}>
          <Input
            type="text"
            placeholder="Enter Room Code"
            value={roomCode}
            onChange={(e) => setRoomCode(e.target.value)}
            required
          />
          <Button type="submit">Join Room</Button>
        </Form>
      </Section>
      
      <PublicRooms />
    </Container>
  );
};