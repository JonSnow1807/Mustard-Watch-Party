import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useQuery } from '@tanstack/react-query';
import styled from '@emotion/styled';
import { apiService } from '../services/api';

const Container = styled.div`
  max-width: 1200px;
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

const UserInfo = styled.div`
  background: #e8f4f8;
  padding: 1rem;
  border-radius: 8px;
  margin-bottom: 2rem;
  display: flex;
  justify-content: space-between;
  align-items: center;
`;

const CreateButton = styled.button`
  padding: 1rem 2rem;
  background: #28a745;
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 1.1rem;
  font-weight: bold;
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  
  &:hover {
    background: #218838;
    transform: translateY(-2px);
  }
`;

const LogoutButton = styled.button`
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

const Section = styled.section`
  margin-bottom: 3rem;
`;

const SectionTitle = styled.h2`
  color: #333;
  font-size: 1.8rem;
  margin-bottom: 1.5rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
`;

const RoomsGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 1.5rem;
`;

const RoomCard = styled.div`
  background: white;
  border-radius: 12px;
  padding: 1.5rem;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
  transition: transform 0.2s, box-shadow 0.2s;
  cursor: pointer;
  border: 2px solid transparent;
  
  &:hover {
    transform: translateY(-4px);
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
  }
`;

const RoomHeader = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: start;
  margin-bottom: 1rem;
`;

const RoomTitle = styled.h3`
  margin: 0;
  font-size: 1.2rem;
  color: #333;
  font-weight: 600;
`;

const LiveBadge = styled.span<{ isPlaying: boolean }>`
  padding: 0.25rem 0.75rem;
  border-radius: 20px;
  font-size: 0.8rem;
  font-weight: bold;
  background: ${props => props.isPlaying ? '#ff4444' : '#666'};
  color: white;
  display: flex;
  align-items: center;
  gap: 0.25rem;
  
  &::before {
    content: '';
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: white;
    animation: ${props => props.isPlaying ? 'pulse 2s infinite' : 'none'};
  }
  
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
`;

const RoomDescription = styled.p`
  color: #666;
  font-size: 0.9rem;
  margin: 0.5rem 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
`;

const RoomStats = styled.div`
  display: flex;
  gap: 1rem;
  margin-top: 1rem;
  font-size: 0.85rem;
  color: #666;
`;

const Tag = styled.span`
  display: inline-block;
  padding: 0.25rem 0.5rem;
  background: #e8f4f8;
  color: #007bff;
  border-radius: 4px;
  font-size: 0.8rem;
  margin-right: 0.5rem;
`;

const PrivateBadge = styled.span`
  padding: 0.25rem 0.5rem;
  background: #ffc107;
  color: #333;
  border-radius: 4px;
  font-size: 0.8rem;
  font-weight: bold;
`;

const EmptyState = styled.div`
  text-align: center;
  padding: 3rem;
  color: #666;
  
  h3 {
    margin-bottom: 1rem;
    color: #333;
  }
  
  p {
    margin-bottom: 1.5rem;
  }
`;

const FilterBar = styled.div`
  display: flex;
  gap: 1rem;
  margin-bottom: 1.5rem;
  flex-wrap: wrap;
`;

const FilterButton = styled.button<{ active: boolean }>`
  padding: 0.5rem 1rem;
  border: 1px solid ${props => props.active ? '#007bff' : '#ddd'};
  background: ${props => props.active ? '#007bff' : 'white'};
  color: ${props => props.active ? 'white' : '#333'};
  border-radius: 20px;
  cursor: pointer;
  transition: all 0.2s;
  
  &:hover {
    border-color: #007bff;
    background: ${props => props.active ? '#0056b3' : '#f0f8ff'};
  }
`;

export const HomePage: React.FC = () => {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [publicFilter, setPublicFilter] = useState('all');

  // Fetch user's rooms
  const { data: userRooms, isLoading: userRoomsLoading } = useQuery({
    queryKey: ['user-rooms', user?.id],
    queryFn: async () => {
      if (!user) return [];
      const response = await apiService.getUserRooms(user.id);
      return response.data;
    },
    enabled: !!user,
    refetchInterval: 10000,
  });

  // Fetch public rooms
  const { data: publicRooms, isLoading: publicRoomsLoading } = useQuery({
    queryKey: ['public-rooms', publicFilter],
    queryFn: async () => {
      const response = await apiService.getPublicRooms(publicFilter);
      return response.data;
    },
    refetchInterval: 10000,
  });

  const handleCreateRoom = () => {
    navigate('/create-room');
  };

  const handleJoinRoom = (roomCode: string, isPrivate: boolean = false) => {
    if (isPrivate) {
      // For private rooms, navigate to join page with room code
      navigate(`/join-room/${roomCode}`);
    } else {
      // For public rooms, join directly
      navigate(`/room/${roomCode}`);
    }
  };

  const getTimeSince = (date: string) => {
    const minutes = Math.floor((Date.now() - new Date(date).getTime()) / 60000);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
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
          <CreateButton onClick={() => navigate('/login')}>
            🔐 Go to Login
          </CreateButton>
        </Section>
      </Container>
    );
  }

  return (
    <Container>
      <Header>
        <Title>🎬 Video Sync Platform</Title>
        <UserInfo>
          <span>Welcome, {user.username}!</span>
          <LogoutButton onClick={logout}>Logout</LogoutButton>
        </UserInfo>
      </Header>

      {/* Your Rooms Section */}
      <Section>
        <SectionTitle>
          🏠 Your Rooms
          <CreateButton onClick={handleCreateRoom}>
            ➕ Create New Room
          </CreateButton>
        </SectionTitle>
        
        {userRoomsLoading ? (
          <p>Loading your rooms...</p>
        ) : userRooms?.length > 0 ? (
          <RoomsGrid>
            {userRooms.map((room: any) => (
              <RoomCard key={room.id} onClick={() => handleJoinRoom(room.code)}>
                <RoomHeader>
                  <RoomTitle>{room.name}</RoomTitle>
                  <LiveBadge isPlaying={room.isPlaying}>
                    {room.isPlaying ? 'LIVE' : 'PAUSED'}
                  </LiveBadge>
                </RoomHeader>
                
                {room.description && (
                  <RoomDescription>{room.description}</RoomDescription>
                )}
                
                {room.videoUrl && (
                  <p style={{ fontSize: '0.9rem', color: '#666', margin: '0.5rem 0' }}>
                    🎥 {room.videoUrl}
                  </p>
                )}
                
                <div style={{ marginTop: '0.5rem' }}>
                  {!room.isPublic && <PrivateBadge>🔒 Private</PrivateBadge>}
                  {room.tags?.map((tag: string) => (
                    <Tag key={tag}>#{tag}</Tag>
                  ))}
                </div>
                
                <RoomStats>
                  <span>👥 {room._count.participants} watching</span>
                  <span>🎥 {getTimeSince(room.createdAt)}</span>
                  {room.creator && <span>by {room.creator.username}</span>}
                </RoomStats>
              </RoomCard>
            ))}
          </RoomsGrid>
        ) : (
          <EmptyState>
            <h3>No rooms yet!</h3>
            <p>Create your first room to start watching videos with friends.</p>
            <CreateButton onClick={handleCreateRoom}>
              ➕ Create Your First Room
            </CreateButton>
          </EmptyState>
        )}
      </Section>

      {/* Public Rooms Section */}
      <Section>
        <SectionTitle>🌍 Public Rooms</SectionTitle>
        
        <FilterBar>
          <FilterButton 
            active={publicFilter === 'all'} 
            onClick={() => setPublicFilter('all')}
          >
            All Rooms
          </FilterButton>
          <FilterButton 
            active={publicFilter === 'movies'} 
            onClick={() => setPublicFilter('movies')}
          >
            🎬 Movies
          </FilterButton>
          <FilterButton 
            active={publicFilter === 'tv'} 
            onClick={() => setPublicFilter('tv')}
          >
            📺 TV Shows
          </FilterButton>
          <FilterButton 
            active={publicFilter === 'education'} 
            onClick={() => setPublicFilter('education')}
          >
            🎓 Education
          </FilterButton>
          <FilterButton 
            active={publicFilter === 'music'} 
            onClick={() => setPublicFilter('music')}
          >
            🎵 Music
          </FilterButton>
        </FilterBar>
        
        {publicRoomsLoading ? (
          <p>Loading public rooms...</p>
        ) : publicRooms?.length > 0 ? (
          <RoomsGrid>
            {publicRooms.map((room: any) => (
              <RoomCard key={room.id} onClick={() => handleJoinRoom(room.code)}>
                <RoomHeader>
                  <RoomTitle>{room.name}</RoomTitle>
                  <LiveBadge isPlaying={room.isPlaying}>
                    {room.isPlaying ? 'LIVE' : 'PAUSED'}
                  </LiveBadge>
                </RoomHeader>
                
                {room.description && (
                  <RoomDescription>{room.description}</RoomDescription>
                )}
                
                <div style={{ marginTop: '0.5rem' }}>
                  {room.tags?.map((tag: string) => (
                    <Tag key={tag}>#{tag}</Tag>
                  ))}
                </div>
                
                <RoomStats>
                  <span>👥 {room._count.participants} watching</span>
                  <span>🎥 {getTimeSince(room.createdAt)}</span>
                  <span>by {room.creator.username}</span>
                </RoomStats>
              </RoomCard>
            ))}
          </RoomsGrid>
        ) : (
          <EmptyState>
            <h3>No public rooms found</h3>
            <p>Be the first to create a public room!</p>
            <CreateButton onClick={handleCreateRoom}>
              ➕ Create Public Room
            </CreateButton>
          </EmptyState>
        )}
      </Section>
    </Container>
  );
};