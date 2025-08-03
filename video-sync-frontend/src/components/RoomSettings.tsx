import React, { useState } from 'react';
import styled from '@emotion/styled';
import { apiService } from '../services/api';
import { toast } from 'react-hot-toast';

const SettingsContainer = styled.div`
  background: rgba(255, 255, 255, 0.05);
  backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 16px;
  padding: 1.5rem;
  margin-top: 1rem;
`;

const SettingsHeader = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1.5rem;
  
  h3 {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: #ffffff;
    font-weight: 600;
  }
`;

const SettingRow = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  
  &:last-child {
    border-bottom: none;
  }
`;

const Label = styled.label`
  font-weight: 500;
  color: rgba(255, 255, 255, 0.9);
`;

const Toggle = styled.label`
  position: relative;
  display: inline-block;
  width: 48px;
  height: 24px;
  
  input {
    opacity: 0;
    width: 0;
    height: 0;
  }
  
  span {
    position: absolute;
    cursor: pointer;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background-color: rgba(255, 255, 255, 0.2);
    transition: .4s;
    border-radius: 24px;
    
    &:before {
      position: absolute;
      content: "";
      height: 16px;
      width: 16px;
      left: 4px;
      bottom: 4px;
      background-color: white;
      transition: .4s;
      border-radius: 50%;
    }
  }
  
  input:checked + span {
    background-color: #667eea;
  }
  
  input:checked + span:before {
    transform: translateX(24px);
  }
`;

const Input = styled.input`
  padding: 0.75rem;
  background: rgba(255, 255, 255, 0.05);
  border: 2px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  font-size: 0.9rem;
  width: 200px;
  color: #ffffff;
  
  &::placeholder {
    color: rgba(255, 255, 255, 0.5);
  }
  
  &:focus {
    outline: none;
    border-color: rgba(102, 126, 234, 0.5);
  }
`;

const Button = styled.button`
  padding: 0.75rem 1.5rem;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.9rem;
  font-weight: 500;
  transition: all 0.3s ease;
  
  &:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
  }
  
  &:disabled {
    background: rgba(255, 255, 255, 0.1);
    color: rgba(255, 255, 255, 0.5);
    cursor: not-allowed;
    transform: none;
    box-shadow: none;
  }
`;

const PauseButton = styled(Button)`
  background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
  
  &:hover {
    box-shadow: 0 4px 12px rgba(245, 158, 11, 0.4);
  }
`;

const ResumeButton = styled(Button)`
  background: linear-gradient(135deg, #10b981 0%, #059669 100%);
  
  &:hover {
    box-shadow: 0 4px 12px rgba(16, 185, 129, 0.4);
  }
`;

const EndButton = styled(Button)`
  background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
  
  &:hover {
    box-shadow: 0 4px 12px rgba(239, 68, 68, 0.4);
  }
`;

const ButtonGroup = styled.div`
  display: flex;
  gap: 0.75rem;
  margin-top: 1.5rem;
  flex-wrap: wrap;
`;

const RoomStatus = styled.div`
  padding: 0.75rem 1rem;
  border-radius: 8px;
  margin-bottom: 1rem;
  font-size: 0.9rem;
  font-weight: 500;
  text-align: center;
  
  &.paused {
    background: rgba(245, 158, 11, 0.2);
    color: #fbbf24;
    border: 1px solid rgba(245, 158, 11, 0.3);
  }
  
  &.active {
    background: rgba(16, 185, 129, 0.2);
    color: #86efac;
    border: 1px solid rgba(16, 185, 129, 0.3);
  }
`;

interface RoomSettingsProps {
  room: any;
  isHost: boolean;
  onUpdate?: () => void;
}

export const RoomSettings: React.FC<RoomSettingsProps> = ({ room, isHost, onUpdate }) => {
  const [isPublic, setIsPublic] = useState(room.isPublic || false);
  const [maxUsers, setMaxUsers] = useState(room.maxUsers || 20);
  const [videoUrl, setVideoUrl] = useState(room.videoUrl || '');
  const [loading, setLoading] = useState(false);
  const [roomStatus, setRoomStatus] = useState(room.isPaused ? 'paused' : 'active');

  if (!isHost) {
    return null;
  }

  const handleUpdateSettings = async () => {
    setLoading(true);
    try {
      await apiService.updateRoom(room.id, {
        isPublic,
        maxUsers,
        videoUrl,
      });
      toast.success('Room settings updated!');
      if (onUpdate) onUpdate();
    } catch (error) {
      toast.error('Failed to update settings');
    } finally {
      setLoading(false);
    }
  };

  const handlePauseRoom = async () => {
    if (!window.confirm('Are you sure you want to pause this room? All participants will be kicked out, but the room will be preserved for you to resume later.')) {
      return;
    }
    
    setLoading(true);
    try {
      await apiService.pauseRoom(room.id, room.creatorId);
      toast.success('Room paused successfully! Participants have been kicked out.');
      setRoomStatus('paused');
      if (onUpdate) onUpdate();
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to pause room');
    } finally {
      setLoading(false);
    }
  };

  const handleResumeRoom = async () => {
    setLoading(true);
    try {
      await apiService.resumeRoom(room.id, room.creatorId);
      toast.success('Room resumed successfully! Participants can now rejoin.');
      setRoomStatus('active');
      if (onUpdate) onUpdate();
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to resume room');
    } finally {
      setLoading(false);
    }
  };

  const handleEndRoom = async () => {
    if (!window.confirm('Are you sure you want to END this room? This will permanently delete the room and kick all participants out. This action cannot be undone.')) {
      return;
    }
    
    setLoading(true);
    try {
      await apiService.endRoom(room.id, room.creatorId);
      toast.success('Room ended successfully!');
      window.location.href = '/';
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to end room');
    } finally {
      setLoading(false);
    }
  };

  return (
    <SettingsContainer>
      <SettingsHeader>
        <h3>⚙️ Room Settings</h3>
      </SettingsHeader>
      
      <RoomStatus className={roomStatus}>
        {roomStatus === 'paused' ? '⏸️ Room Paused' : '▶️ Room Active'}
      </RoomStatus>
      
      <SettingRow>
        <Label>Public Room</Label>
        <Toggle>
          <input
            type="checkbox"
            checked={isPublic}
            onChange={(e) => setIsPublic(e.target.checked)}
          />
          <span />
        </Toggle>
      </SettingRow>
      
      <SettingRow>
        <Label>Max Participants</Label>
        <Input
          type="number"
          min="2"
          max="100"
          value={maxUsers}
          onChange={(e) => setMaxUsers(parseInt(e.target.value))}
        />
      </SettingRow>
      
      <SettingRow>
        <Label>Video URL</Label>
        <Input
          type="url"
          value={videoUrl}
          onChange={(e) => setVideoUrl(e.target.value)}
          placeholder="YouTube URL"
        />
      </SettingRow>
      
      <ButtonGroup>
        <Button onClick={handleUpdateSettings} disabled={loading}>
          {loading ? 'Saving...' : 'Save Changes'}
        </Button>
        
        {roomStatus === 'active' ? (
          <PauseButton onClick={handlePauseRoom} disabled={loading}>
            ⏸️ Pause Room
          </PauseButton>
        ) : (
          <ResumeButton onClick={handleResumeRoom} disabled={loading}>
            ▶️ Resume Room
          </ResumeButton>
        )}
        
        <EndButton onClick={handleEndRoom} disabled={loading}>
          🗑️ End Room
        </EndButton>
      </ButtonGroup>
    </SettingsContainer>
  );
};