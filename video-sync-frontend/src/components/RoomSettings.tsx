import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import styled from '@emotion/styled';
import { toast } from 'react-hot-toast';
import { useSocket } from '../contexts/SocketContext';
import { apiService } from '../services/api';
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
  const [name, setName] = useState<string>(room.name || '');
  const [isPublic, setIsPublic] = useState(room.isPublic || false);
  const [allowGuestControl, setAllowGuestControl] = useState(
    Boolean(room.allowGuestControl),
  );
  // '' is a legal intermediate state: a number field being retyped is empty
  // for a keystroke, and parsing that into NaN would blank the control and
  // make React complain about the value attribute. Blur settles it back to a
  // number, so the field is never left holding nothing.
  const [maxUsers, setMaxUsers] = useState<number | ''>(room.maxUsers || DEFAULT_MAX_USERS);
  const [videoUrl, setVideoUrl] = useState(room.videoUrl || '');
  const [loading, setLoading] = useState(false);
  const { socket } = useSocket();
  const navigate = useNavigate();

  const handleUpdateSettings = async () => {
    const url = videoUrl.trim();
    if (url !== '' && !isAcceptableVideoUrl(url)) {
      // the same shared rule the gateway enforces - refused here it is
      // instant feedback instead of a rejected control
      toast.error("That URL can't be played - use a video link or YouTube id");
      return;
    }

    const trimmedName = name.trim();
    if (trimmedName === '') {
      toast.error('A room needs a name');
      return;
    }

    setLoading(true);
    try {
      // Two different kinds of change, deliberately on two different paths.
      //
      // The room's PROPERTIES are a REST write: they are facts about the row,
      // nobody's playhead moves, and the creator check lives on the route.
      // Until now this function never sent them at all - the name, the public
      // flag, the participant cap and guest control were collected by the form
      // and dropped on the floor, and the toast still said it had saved.
      const changed: Record<string, unknown> = {};
      if (trimmedName !== room.name) changed.name = trimmedName;
      if (isPublic !== Boolean(room.isPublic)) changed.isPublic = isPublic;
      if (allowGuestControl !== Boolean(room.allowGuestControl)) {
        changed.allowGuestControl = allowGuestControl;
      }
      if (typeof maxUsers === 'number' && maxUsers !== room.maxUsers) {
        changed.maxUsers = maxUsers;
      }
      if (Object.keys(changed).length > 0) {
        await apiService.updateRoom(room.code, changed);
      }

      // The VIDEO is a synced control, not a REST write: everyone switches
      // together through the sync:timeline broadcast, with the same
      // exactly-once machinery as play/pause/seek.
      const videoChanged = url !== (room.videoUrl || '');
      if (videoChanged) {
        if (socket === null || !sendSetVideo(socket, room.code, url)) {
          // dropped, never buffered: a stale reconnect flush must not change
          // the room's video minutes later
          toast.error('Not connected - the video was not changed');
          return;
        }
      }

      toast.success(
        videoChanged
          ? 'Saved - the video changed for everyone in the room'
          : 'Settings saved',
      );
      if (onUpdate) onUpdate();
      onClose();
    } catch (error: any) {
      toast.error(error?.response?.data?.message || "Couldn't save the settings");
    } finally {
      setLoading(false);
    }
  };

  const handleEndRoom = async () => {
    if (
      !window.confirm(
        'End this room? It disappears for everyone in it, and the link stops working.',
      )
    ) {
      return;
    }

    setLoading(true);
    try {
      // This used to be a lie: the delete was commented out, so "End room"
      // congratulated you and navigated away while the room carried on
      // existing with everyone still in it.
      await apiService.deleteRoom(room.code);
      toast.success('Room ended');
      navigate('/');
    } catch (error: any) {
      toast.error(error?.response?.data?.message || "Couldn't end the room");
    } finally {
      setLoading(false);
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
        <Label htmlFor="room-settings-name">Room name</Label>
        <UrlInput
          id="room-settings-name"
          type="text"
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          placeholder="Movie night"
        />
      </SettingRow>

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

      {/* The one setting that changes what other people can DO, rather than
          what the room looks like - so it says which it is, not just its name. */}
      <SettingRow>
        <Label htmlFor="room-settings-guest-control">
          Let everyone control playback
        </Label>
        <Toggle>
          <input
            id="room-settings-guest-control"
            type="checkbox"
            checked={allowGuestControl}
            onChange={(e) => setAllowGuestControl(e.target.checked)}
          />
          <span />
        </Toggle>
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
