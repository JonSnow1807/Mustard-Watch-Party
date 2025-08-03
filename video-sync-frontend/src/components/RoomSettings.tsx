import React, { useState } from 'react';
import styled from '@emotion/styled';
import { apiService } from '../services/api';
import { toast } from 'react-hot-toast';

const SettingsContainer = styled.div`
  background: #f5f5f5;
  border-radius: 8px;
  padding: 1.5rem;
  margin-top: 1rem;
`;

const SettingsHeader = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1rem;
  
  h3 {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
`;

const SettingRow = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 0;
  border-bottom: 1px solid #e0e0e0;
  
  &:last-child {
    border-bottom: none;
  }
`;

const Label = styled.label`
  font-weight: 500;
  color: #333;
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
    background-color: #ccc;
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
    background-color: #007bff;
  }
  
  input:checked + span:before {
    transform: translateX(24px);
  }
`;

const Input = styled.input`
  padding: 0.5rem;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 0.9rem;
  width: 200px;
`;

const Button = styled.button`
  padding: 0.5rem 1rem;
  background: #007bff;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.9rem;
  
  &:hover {
    background: #0056b3;
  }
`;

const DangerButton = styled(Button)`
  background: #dc3545;
  
  &:hover {
    background: #c82333;
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

  const handleEndRoom = async () => {
    if (!window.confirm('Are you sure you want to end this room? All participants will be disconnected.')) {
      return;
    }
    
    try {
      await apiService.updateRoom(room.id, {
        isActive: false,
      });
      toast.success('Room ended');
      window.location.href = '/';
    } catch (error) {
      toast.error('Failed to end room');
    }
  };

  return (
    <SettingsContainer>
      <SettingsHeader>
        <h3>⚙️ Room Settings</h3>
      </SettingsHeader>
      
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
      
      <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
        <Button onClick={handleUpdateSettings} disabled={loading}>
          {loading ? 'Saving...' : 'Save Changes'}
        </Button>
        <DangerButton onClick={handleEndRoom}>
          End Room
        </DangerButton>
      </div>
    </SettingsContainer>
  );
};