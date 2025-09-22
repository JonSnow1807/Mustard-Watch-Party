import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useQuery } from '@tanstack/react-query';
import styled from '@emotion/styled';
import { apiService } from '../services/api';
import { toast } from 'react-hot-toast';

const Container = styled.div`
  max-width: 1400px;
  margin: 0 auto;
  padding: 2rem;
  min-height: 100vh;
  position: relative;

  &::before {
    content: '';
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: radial-gradient(circle at 20% 80%, rgba(99, 102, 241, 0.03) 0%, transparent 50%),
                radial-gradient(circle at 80% 20%, rgba(139, 92, 246, 0.03) 0%, transparent 50%),
                radial-gradient(circle at 40% 40%, rgba(16, 185, 129, 0.02) 0%, transparent 50%);
    pointer-events: none;
    z-index: -1;
  }
`;

const Header = styled.header`
  text-align: center;
  margin-bottom: 4rem;
  position: relative;
`;

const Title = styled.h1`
  font-size: 4rem;
  font-weight: 700;
  margin-bottom: 1rem;
  background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #10b981 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  animation: fadeIn 1s ease-out;

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

const UserInfo = styled.div`
  background: #ffffff;
  backdrop-filter: blur(20px);
  border: 1px solid #e2e8f0;
  border-radius: 16px;
  padding: 1.5rem 2rem;
  margin-bottom: 3rem;
  display: flex;
  justify-content: space-between;
  align-items: center;
  animation: fadeIn 1s ease-out 0.4s both;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);

  @media (max-width: 768px) {
    flex-direction: column;
    gap: 1rem;
    text-align: center;
  }
`;

const WelcomeText = styled.span`
  font-size: 1.1rem;
  color: #4a5568;
  font-weight: 500;
`;

const CreateButton = styled.button`
  padding: 1rem 2rem;
  background: #6366f1;
  color: white;
  border: none;
  border-radius: 12px;
  font-size: 1.1rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);

  &:hover {
    transform: translateY(-1px);
    background: #5558e3;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.07);
  }

  &:active {
    transform: translateY(0);
  }
`;

const LogoutButton = styled.button`
  padding: 0.75rem 1.5rem;
  background: rgba(248, 113, 113, 0.1);
  color: #f87171;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  cursor: pointer;
  font-weight: 500;
  transition: all 0.3s ease;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);

  &:hover {
    background: rgba(248, 113, 113, 0.15);
    border-color: rgba(248, 113, 113, 0.3);
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.07);
  }
`;

const Section = styled.section`
  margin-bottom: 4rem;
  animation: fadeIn 1s ease-out 0.6s both;
`;

const SectionTitle = styled.h2`
  font-size: 2.2rem;
  font-weight: 600;
  margin-bottom: 2rem;
  color: #2d3748;
  display: flex;
  align-items: center;
  gap: 1rem;

  @media (max-width: 768px) {
    font-size: 1.8rem;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
  }
`;

const RoomsGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
  gap: 2rem;
  margin-top: 2rem;
  
  @media (max-width: 768px) {
    grid-template-columns: 1fr;
    gap: 1.5rem;
  }
`;

const RoomCard = styled.div`
  background: #ffffff;
  backdrop-filter: blur(20px);
  border: 1px solid #e2e8f0;
  border-radius: 16px;
  padding: 2rem;
  cursor: pointer;
  transition: all 0.3s ease;
  position: relative;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);

  &::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
    background: linear-gradient(90deg, #6366f1, #8b5cf6, #10b981);
    opacity: 0;
    transition: opacity 0.3s ease;
  }

  &:hover {
    transform: translateY(-4px);
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.07);
    border-color: #cbd5e1;

    &::before {
      opacity: 1;
    }
  }

  &:active {
    transform: translateY(-2px);
  }
`;

const RoomHeader = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: start;
  margin-bottom: 1.5rem;
`;

const RoomTitle = styled.h3`
  margin: 0;
  font-size: 1.4rem;
  color: #2d3748;
  font-weight: 600;
  line-height: 1.3;
`;

const LiveBadge = styled.span<{ isPlaying: boolean }>`
  padding: 0.5rem 1rem;
  border-radius: 20px;
  font-size: 0.8rem;
  font-weight: 600;
  background: ${props => props.isPlaying
    ? '#f87171'
    : '#f8fafc'};
  color: ${props => props.isPlaying ? 'white' : '#718096'};
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border: 1px solid ${props => props.isPlaying ? 'rgba(248, 113, 113, 0.3)' : '#e2e8f0'};

  &::before {
    content: '';
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: ${props => props.isPlaying ? 'white' : '#a0aec0'};
    animation: ${props => props.isPlaying ? 'pulse 2s infinite' : 'none'};
  }
`;

const RoomDescription = styled.p`
  color: #718096;
  font-size: 0.95rem;
  margin: 1rem 0;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
`;

const RoomStats = styled.div`
  display: flex;
  gap: 1.5rem;
  margin-top: 1.5rem;
  font-size: 0.9rem;
  color: #a0aec0;
  flex-wrap: wrap;
`;

const StatItem = styled.span`
  display: flex;
  align-items: center;
  gap: 0.5rem;
`;

const Tag = styled.span`
  display: inline-block;
  padding: 0.4rem 0.8rem;
  background: rgba(99, 102, 241, 0.1);
  color: #6366f1;
  border-radius: 8px;
  font-size: 0.8rem;
  margin-right: 0.5rem;
  margin-bottom: 0.5rem;
  border: 1px solid rgba(99, 102, 241, 0.2);
  transition: all 0.2s ease;

  &:hover {
    background: rgba(99, 102, 241, 0.15);
    transform: translateY(-1px);
  }
`;

const PrivateBadge = styled.span`
  padding: 0.4rem 0.8rem;
  background: rgba(245, 158, 11, 0.1);
  color: #f59e0b;
  border-radius: 8px;
  font-size: 0.8rem;
  font-weight: 600;
  border: 1px solid rgba(245, 158, 11, 0.2);
  display: inline-block;
  margin-bottom: 0.5rem;
`;

const EmptyState = styled.div`
  text-align: center;
  padding: 4rem 2rem;
  color: #718096;
  background: #ffffff;
  border-radius: 16px;
  border: 1px solid #e2e8f0;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);

  h3 {
    margin-bottom: 1rem;
    color: #2d3748;
    font-size: 1.5rem;
    font-weight: 600;
  }

  p {
    margin-bottom: 2rem;
    font-size: 1.1rem;
    line-height: 1.6;
  }
`;

const FilterBar = styled.div`
  display: flex;
  gap: 1rem;
  margin-bottom: 2rem;
  flex-wrap: wrap;
  padding: 1rem;
  background: #ffffff;
  border-radius: 12px;
  border: 1px solid #e2e8f0;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
`;

const FilterButton = styled.button<{ active: boolean }>`
  padding: 0.75rem 1.5rem;
  border: 1px solid ${props => props.active ? 'rgba(99, 102, 241, 0.3)' : '#e2e8f0'};
  background: ${props => props.active
    ? '#6366f1'
    : '#f8fafc'};
  color: ${props => props.active ? 'white' : '#718096'};
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.3s ease;
  font-weight: 500;
  backdrop-filter: blur(10px);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);

  &:hover {
    border-color: rgba(99, 102, 241, 0.3);
    background: ${props => props.active
      ? '#5558e3'
      : '#f1f5f9'};
    transform: translateY(-1px);
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.07);
  }
`;

const LoadingSpinner = styled.div`
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 3rem;
  color: #718096;
  font-size: 1.1rem;
`;

const DeleteButton = styled.button`
  padding: 0.5rem;
  background: rgba(248, 113, 113, 0.1);
  color: #f87171;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.8rem;
  transition: all 0.3s ease;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);

  &:hover {
    background: rgba(248, 113, 113, 0.15);
    border-color: rgba(248, 113, 113, 0.3);
    transform: scale(1.05);
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.07);
  }
`;

const RoomActions = styled.div`
  position: absolute;
  top: 1rem;
  right: 1rem;
  display: flex;
  gap: 0.5rem;
  opacity: 1;
  transition: opacity 0.3s ease;
`;

const Modal = styled.div`
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.8);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  backdrop-filter: blur(5px);
`;

const ModalContent = styled.div`
  background: #ffffff;
  backdrop-filter: blur(20px);
  border: 1px solid #e2e8f0;
  border-radius: 16px;
  padding: 2rem;
  max-width: 400px;
  width: 90%;
  text-align: center;
  box-shadow: 0 4px 6px rgba(0, 0, 0, 0.07);
`;

const ModalTitle = styled.h3`
  color: #2d3748;
  margin-bottom: 1rem;
  font-size: 1.5rem;
  font-weight: 600;
`;

const ModalText = styled.p`
  color: #718096;
  margin-bottom: 2rem;
  line-height: 1.5;
`;

const ModalButtons = styled.div`
  display: flex;
  gap: 1rem;
  justify-content: center;
`;

const ConfirmButton = styled.button`
  padding: 0.75rem 1.5rem;
  background: #f87171;
  color: white;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  font-weight: 600;
  transition: all 0.3s ease;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);

  &:hover {
    transform: translateY(-1px);
    background: #ef4444;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.07);
  }
`;

const CancelButton = styled.button`
  padding: 0.75rem 1.5rem;
  background: #f8fafc;
  color: #718096;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  cursor: pointer;
  font-weight: 500;
  transition: all 0.3s ease;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);

  &:hover {
    background: #f1f5f9;
    border-color: #cbd5e1;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.07);
  }
`;

export const HomePage: React.FC = () => {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const [publicFilter, setPublicFilter] = useState('all');
  const [deleteModal, setDeleteModal] = useState<{ show: boolean; room: any | null }>({ show: false, room: null });

  // Fetch user's rooms
  const { data: userRooms, isLoading: userRoomsLoading, refetch: refetchUserRooms } = useQuery({
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
      navigate(`/join-room/${roomCode}`);
    } else {
      navigate(`/room/${roomCode}`);
    }
  };

  const handleDeleteRoom = async (room: any) => {
    try {
      await apiService.deleteRoom(room.code, user!.id);
      toast.success('Watch party deleted successfully');
      setDeleteModal({ show: false, room: null });
      refetchUserRooms();
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to delete watch party');
    }
  };

  const showDeleteModal = (room: any, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteModal({ show: true, room });
  };

  const hideDeleteModal = () => {
    setDeleteModal({ show: false, room: null });
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
          <Title>🎬 Mustard Watch Party</Title>
          <Subtitle>Experience synchronized video watching like never before</Subtitle>
        </Header>
        
        <Section>
          <EmptyState>
            <h3>Welcome to the Future of Watch Parties</h3>
            <p>Join thousands of users enjoying synchronized video experiences together.</p>
            <CreateButton onClick={() => navigate('/login')}>
              🔐 Get Started
            </CreateButton>
          </EmptyState>
        </Section>
      </Container>
    );
  }

  return (
    <Container>
      <Header>
        <Title>🎬 Mustard Watch Party</Title>
        <Subtitle>Your synchronized video experience awaits</Subtitle>
        <UserInfo>
          <WelcomeText>Welcome back, {user.username}! 👋</WelcomeText>
          <LogoutButton onClick={logout}>Sign Out</LogoutButton>
        </UserInfo>
      </Header>

      {/* Your Rooms Section */}
      <Section>
        <SectionTitle>
          🏠 Your Watch Parties
          <CreateButton onClick={handleCreateRoom}>
            ➕ Create New Party
          </CreateButton>
        </SectionTitle>
        
        {userRoomsLoading ? (
          <LoadingSpinner>
            <div className="spinner"></div>
            <span style={{ marginLeft: '1rem' }}>Loading your parties...</span>
          </LoadingSpinner>
        ) : userRooms?.length > 0 ? (
          <RoomsGrid>
            {userRooms.map((room: any) => (
              <RoomCard key={room.id} onClick={() => handleJoinRoom(room.code)}>
                <RoomActions>
                  {room.creatorId === user.id && (
                    <DeleteButton 
                      onClick={(e) => showDeleteModal(room, e)}
                      title="Delete this watch party"
                    >
                      🗑️
                    </DeleteButton>
                  )}
                </RoomActions>
                
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
                  <p style={{ fontSize: '0.9rem', color: '#94a3b8', margin: '1rem 0' }}>
                    🎥 {room.videoUrl}
                  </p>
                )}
                
                <div style={{ marginTop: '1rem' }}>
                  {!room.isPublic && <PrivateBadge>🔒 Private Party</PrivateBadge>}
                  {room.tags?.map((tag: string) => (
                    <Tag key={tag}>#{tag}</Tag>
                  ))}
                </div>
                
                <RoomStats>
                  <StatItem>
                    <span>👥</span>
                    <span>{room._count.participants} watching</span>
                  </StatItem>
                  <StatItem>
                    <span>🎥</span>
                    <span>{getTimeSince(room.createdAt)}</span>
                  </StatItem>
                  {room.creator && (
                    <StatItem>
                      <span>👤</span>
                      <span>by {room.creator.username}</span>
                    </StatItem>
                  )}
                </RoomStats>
              </RoomCard>
            ))}
          </RoomsGrid>
        ) : (
          <EmptyState>
            <h3>No watch parties yet!</h3>
            <p>Create your first synchronized video experience and invite friends to join the fun.</p>
            <CreateButton onClick={handleCreateRoom}>
              ➕ Create Your First Party
            </CreateButton>
          </EmptyState>
        )}
      </Section>

      {/* Public Rooms Section */}
      <Section>
        <SectionTitle>🌍 Discover Public Parties</SectionTitle>
        
        <FilterBar>
          <FilterButton 
            active={publicFilter === 'all'} 
            onClick={() => setPublicFilter('all')}
          >
            All Parties
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
          <LoadingSpinner>
            <div className="spinner"></div>
            <span style={{ marginLeft: '1rem' }}>Discovering parties...</span>
          </LoadingSpinner>
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
                
                <div style={{ marginTop: '1rem' }}>
                  {room.tags?.map((tag: string) => (
                    <Tag key={tag}>#{tag}</Tag>
                  ))}
                </div>
                
                <RoomStats>
                  <StatItem>
                    <span>👥</span>
                    <span>{room._count.participants} watching</span>
                  </StatItem>
                  <StatItem>
                    <span>🎥</span>
                    <span>{getTimeSince(room.createdAt)}</span>
                  </StatItem>
                  <StatItem>
                    <span>👤</span>
                    <span>by {room.creator.username}</span>
                  </StatItem>
                </RoomStats>
              </RoomCard>
            ))}
          </RoomsGrid>
        ) : (
          <EmptyState>
            <h3>No public parties found</h3>
            <p>Be the first to create a public watch party and start the trend!</p>
            <CreateButton onClick={handleCreateRoom}>
              ➕ Create Public Party
            </CreateButton>
          </EmptyState>
        )}
      </Section>

      {/* Delete Confirmation Modal */}
      {deleteModal.show && deleteModal.room && (
        <Modal onClick={hideDeleteModal}>
          <ModalContent onClick={(e) => e.stopPropagation()}>
            <ModalTitle>🗑️ Delete Watch Party</ModalTitle>
            <ModalText>
              Are you sure you want to delete "{deleteModal.room.name}"? 
              This action cannot be undone and will remove all participants, chat messages, and sync data.
            </ModalText>
            <ModalButtons>
              <CancelButton onClick={hideDeleteModal}>
                Cancel
              </CancelButton>
              <ConfirmButton onClick={() => handleDeleteRoom(deleteModal.room)}>
                Delete Party
              </ConfirmButton>
            </ModalButtons>
          </ModalContent>
        </Modal>
      )}
    </Container>
  );
};