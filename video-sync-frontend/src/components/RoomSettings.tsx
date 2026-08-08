import React, { useState } from 'react';
import styled from '@emotion/styled';
import { toast } from 'react-hot-toast';
import { useSocket } from '../contexts/SocketContext';
import { isAcceptableVideoUrl } from '../shared/media-source';
import { sendSetVideo } from '../sync/SyncEngine';
import { card, color, font, input, button, ghostIconButton, radius, focusRing, sectionLabel } from '../theme';
import { IconX } from './Icons';

// The room page owns the column width and the gap above this panel; the
// panel owns only its own padding, so there is one source of each.
const SettingsContainer = styled.div`
  ${card}
  padding: 20px;
`;

const SettingsHeader = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  margin-bottom: 4px;

  h3 {
    margin: 0;
    font-family: ${font.display};
    font-size: 16px;
    font-weight: 600;
    color: ${color.text};
  }
`;

const CloseButton = styled.button`
  ${ghostIconButton}
`;

const SettingRow = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 14px 0;

  /* dividers between rows only - no dangling hairline above the actions */
  & + & {
    border-top: 1px solid ${color.line};
  }
`;

const Label = styled.label`
  ${sectionLabel}
`;

// Hidden checkbox + painted span: the input stays the real control (and
// the real focus target), the span is only its picture.
const Toggle = styled.label`
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
  flex-shrink: 0;

  input {
    position: absolute;
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
    background: ${color.bg3};
    border-radius: ${radius.pill};
    transition: background 120ms ease;

    &:before {
      position: absolute;
      content: "";
      height: 16px;
      width: 16px;
      left: 2px;
      top: 2px;
      background: ${color.text};
      border-radius: 50%;
      transition: transform 120ms ease, background 120ms ease;
    }
  }

  input:checked + span {
    background: ${color.mustard};
  }

  input:checked + span:before {
    background: ${color.mustardInk};
    transform: translateX(16px);
  }

  input:focus-visible + span {
    box-shadow: ${focusRing};
  }
`;

const NumberInput = styled.input`
  ${input}
  width: 88px;
  padding: 8px 12px;
  font-family: ${font.mono};
  font-variant-numeric: tabular-nums;
`;

const UrlInput = styled.input`
  ${input}
  width: 300px;
  max-width: 60%;
  padding: 8px 12px;
  font-family: ${font.mono};
  font-size: 13px;
`;

const Actions = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 20px;
`;

const SaveButton = styled.button`
  ${button.primary}
`;

const EndButton = styled.button`
  ${button.danger}
`;

interface RoomSettingsProps {
  room: any;
  onClose: () => void;
  onUpdate?: () => void;
}

const DEFAULT_MAX_USERS = 20;

export const RoomSettings: React.FC<RoomSettingsProps> = ({ room, onClose, onUpdate }) => {
  const [isPublic, setIsPublic] = useState(room.isPublic || false);
  // '' is a legal intermediate state: a number field being retyped is empty
  // for a keystroke, and parsing that into NaN would blank the control and
  // make React complain about the value attribute. Blur settles it back to a
  // number, so the field is never left holding nothing.
  const [maxUsers, setMaxUsers] = useState<number | ''>(room.maxUsers || DEFAULT_MAX_USERS);
  const [videoUrl, setVideoUrl] = useState(room.videoUrl || '');
  const [loading, setLoading] = useState(false);
  const { socket } = useSocket();

  const handleUpdateSettings = () => {
    // Changing the video is a SYNCED CONTROL, not a REST write: everyone in
    // the room switches together through the sync:timeline broadcast, with
    // the same exactly-once machinery as play/pause/seek. The server
    // persists the room row from the committed timeline.
    const url = videoUrl.trim();
    if (url !== '' && !isAcceptableVideoUrl(url)) {
      // the same shared rule the gateway enforces - refused here it is
      // instant feedback instead of a rejected control
      toast.error("That URL can't be played - use a video link or YouTube id");
      return;
    }
    setLoading(true);
    if (socket !== null && sendSetVideo(socket, room.code, url)) {
      // wait-for-broadcast: the player switches when sync:timeline arrives
      toast.success('Video changed for everyone in the room');
      if (onUpdate) onUpdate();
    } else {
      // dropped, never buffered: a stale reconnect flush must not change
      // the room's video minutes later
      toast.error('Not connected - try again in a moment');
    }
    setLoading(false);
  };

  const handleEndRoom = async () => {
    if (!window.confirm('Are you sure you want to end this room? All participants will be disconnected.')) {
      return;
    }

    try {
      // For now, just navigate away - room deletion handled separately
      // await apiService.updateRoom(room.code, {
      //   isActive: false,
      // });
      toast.success('Room ended');
      window.location.href = '/';
    } catch (error) {
      toast.error('Failed to end room');
    }
  };

  return (
    <SettingsContainer>
      <SettingsHeader>
        <h3>Room settings</h3>
        <CloseButton type="button" onClick={onClose} aria-label="Close room settings">
          <IconX size={16} />
        </CloseButton>
      </SettingsHeader>

      {/* Every row's visible text IS its control's accessible name, so each
          Label points at its input by id - the painted toggle carries no
          text of its own to borrow. */}
      <SettingRow>
        <Label htmlFor="room-settings-public">List publicly</Label>
        <Toggle>
          <input
            id="room-settings-public"
            type="checkbox"
            checked={isPublic}
            onChange={(e) => setIsPublic(e.target.checked)}
          />
          <span />
        </Toggle>
      </SettingRow>

      <SettingRow>
        <Label htmlFor="room-settings-max-users">Max participants</Label>
        <NumberInput
          id="room-settings-max-users"
          type="number"
          min="2"
          max="100"
          value={maxUsers}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === '') {
              setMaxUsers('');
              return;
            }
            const parsed = parseInt(raw, 10);
            setMaxUsers(Number.isNaN(parsed) ? '' : parsed);
          }}
          onBlur={() => {
            if (maxUsers === '') {
              setMaxUsers(room.maxUsers || DEFAULT_MAX_USERS);
            }
          }}
        />
      </SettingRow>

      <SettingRow>
        <Label htmlFor="room-settings-video-url">Video URL</Label>
        <UrlInput
          id="room-settings-video-url"
          type="url"
          value={videoUrl}
          onChange={(e) => setVideoUrl(e.target.value)}
          placeholder="YouTube, Vimeo, HLS, or MP4 URL"
        />
      </SettingRow>

      <Actions>
        <SaveButton type="button" onClick={handleUpdateSettings} disabled={loading}>
          {loading ? 'Saving…' : 'Save changes'}
        </SaveButton>
        <EndButton type="button" onClick={handleEndRoom}>
          End room
        </EndButton>
      </Actions>
    </SettingsContainer>
  );
};
