import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import styled from '@emotion/styled';
import { apiService } from '../services/api';

const Container = styled.div`
  margin-top: 2rem;
`;

const RoomsGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 1.5rem;
  margin-top: 1rem;
`;

const RoomCard = styled.div`
  background: white;
  border-radius: 12px;
  padding: 1.5rem;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
  transition: transform 0.2s, box-shadow 0.2s;
  cursor: pointer;
  
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

const FilterBar = styled.div`
  display: flex;
  gap: 1rem;
  margin-bottom: 1rem;
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

export const PublicRooms: React.FC = () => {
  const navigate = useNavigate();
  const [filter, setFilter] = useState('all');
  
  const { data: rooms, isLoading } = useQuery({
    queryKey: ['public-rooms', filter],
    queryFn: async () => {
      const response = await apiService.getPublicRooms(filter);
      return response.data;
    },
    refetchInterval: 10000, // Refresh every 10 seconds
  });
  
  const joinRoom = (roomCode: string) => {
    navigate(`/room/${roomCode}`);
  };
  
  const getTimeSince = (date: string) => {
    const minutes = Math.floor((Date.now() - new Date(date).getTime()) / 60000);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  };
  
  return (
    <Container>
      <h2>🌍 Public Rooms</h2>
      
      <FilterBar>
        <FilterButton 
          active={filter === 'all'} 
          onClick={() => setFilter('all')}
        >
          All Rooms
        </FilterButton>
        <FilterButton 
          active={filter === 'movies'} 
          onClick={() => setFilter('movies')}
        >
          🎬 Movies
        </FilterButton>
        <FilterButton 
          active={filter === 'tv'} 
          onClick={() => setFilter('tv')}
        >
          📺 TV Shows
        </FilterButton>
        <FilterButton 
          active={filter === 'education'} 
          onClick={() => setFilter('education')}
        >
          🎓 Education
        </FilterButton>
        <FilterButton 
          active={filter === 'music'} 
          onClick={() => setFilter('music')}
        >
          🎵 Music
        </FilterButton>
      </FilterBar>
      
      {isLoading ? (
        <p>Loading public rooms...</p>
      ) : (
        <RoomsGrid>
          {rooms?.map((room: any) => (
            <RoomCard key={room.id} onClick={() => joinRoom(room.code)}>
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
      )}
      
      {rooms?.length === 0 && (
        <p style={{ textAlign: 'center', color: '#666', marginTop: '2rem' }}>
          No public rooms found. Create one to get started!
        </p>
      )}
    </Container>
  );
};