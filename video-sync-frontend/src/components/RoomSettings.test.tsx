import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { RoomSettings } from './RoomSettings';
import { apiService } from '../services/api';

jest.mock('../services/api', () => ({
  AUTH_EXPIRED_EVENT: 'mustard:auth-expired',
  apiBaseUrl: 'http://api.test/api',
  apiService: { updateRoom: jest.fn(), deleteRoom: jest.fn() },
}));

const mockSendSetVideo = jest.fn((..._args: unknown[]) => true);
jest.mock('../sync/SyncEngine', () => ({
  sendSetVideo: (...args: unknown[]) => mockSendSetVideo(...args),
}));

const mockSocket = { id: 'sock' };
jest.mock('../contexts/SocketContext', () => ({
  useSocket: () => ({ socket: mockSocket }),
}));

const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

const updateRoom = apiService.updateRoom as jest.Mock;
const deleteRoom = apiService.deleteRoom as jest.Mock;

const room = {
  id: 'r1',
  code: 'ABC123',
  name: 'Movie night',
  videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
  isPublic: false,
  allowGuestControl: false,
  maxUsers: 20,
};

const renderSettings = (overrides = {}) => {
  const onClose = jest.fn();
  const onUpdate = jest.fn();
  render(
    <MemoryRouter>
      <RoomSettings
        room={{ ...room, ...overrides }}
        onClose={onClose}
        onUpdate={onUpdate}
      />
    </MemoryRouter>,
  );
  return { onClose, onUpdate };
};

beforeEach(() => {
  jest.clearAllMocks();
  updateRoom.mockResolvedValue({ data: {} });
  deleteRoom.mockResolvedValue({ data: {} });
  mockSendSetVideo.mockReturnValue(true);
});

describe('settings that used to be collected and thrown away', () => {
  it('sends the public flag to the server when it is toggled', async () => {
    renderSettings();
    await userEvent.click(screen.getByLabelText('List publicly'));
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(updateRoom).toHaveBeenCalled());
    expect(updateRoom).toHaveBeenCalledWith('ABC123', { isPublic: true });
  });

  it('sends guest control - the toggle that decides who may press play', async () => {
    renderSettings();
    await userEvent.click(
      screen.getByLabelText('Let everyone control playback'),
    );
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(updateRoom).toHaveBeenCalledWith('ABC123', {
        allowGuestControl: true,
      }),
    );
  });

  it('sends a renamed room', async () => {
    renderSettings();
    const field = screen.getByLabelText('Room name');
    await userEvent.clear(field);
    await userEvent.type(field, 'Sunday matinee');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(updateRoom).toHaveBeenCalledWith('ABC123', {
        name: 'Sunday matinee',
      }),
    );
  });

  it('sends nothing at all when nothing changed', async () => {
    // an unchanged save must not rewrite the row, and must NOT re-broadcast
    // the video - that would restart playback for everyone in the room
    renderSettings();
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(screen.queryByText(/saving/i)).not.toBeInTheDocument(),
    );
    expect(updateRoom).not.toHaveBeenCalled();
    expect(mockSendSetVideo).not.toHaveBeenCalled();
  });

  it('refuses to save a room with no name', async () => {
    renderSettings();
    await userEvent.clear(screen.getByLabelText('Room name'));
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(updateRoom).not.toHaveBeenCalled());
  });
});

describe('the video still travels as a synced control', () => {
  it('broadcasts a changed video instead of PATCHing it', async () => {
    renderSettings();
    const field = screen.getByLabelText('Video URL');
    await userEvent.clear(field);
    await userEvent.type(field, 'https://cdn.example.com/film.mp4');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(mockSendSetVideo).toHaveBeenCalled());
    expect(mockSendSetVideo).toHaveBeenCalledWith(
      mockSocket,
      'ABC123',
      'https://cdn.example.com/film.mp4',
    );
    // the video is NOT a column write from here
    expect(updateRoom).not.toHaveBeenCalled();
  });

  it('refuses a URL no player can take, without touching the server', async () => {
    renderSettings();
    const field = screen.getByLabelText('Video URL');
    await userEvent.clear(field);
    await userEvent.type(field, 'javascript:alert(1)');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(mockSendSetVideo).not.toHaveBeenCalled());
    expect(updateRoom).not.toHaveBeenCalled();
  });
});

describe('End room', () => {
  it('actually ends the room', async () => {
    // it used to toast "Room ended" and navigate away with the delete
    // commented out, so the room carried on with everyone still in it
    window.confirm = jest.fn(() => true);
    renderSettings();
    await userEvent.click(screen.getByRole('button', { name: /end room/i }));

    await waitFor(() => expect(deleteRoom).toHaveBeenCalledWith('ABC123'));
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('does nothing when the confirmation is declined', async () => {
    window.confirm = jest.fn(() => false);
    renderSettings();
    await userEvent.click(screen.getByRole('button', { name: /end room/i }));

    expect(deleteRoom).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('keeps you in the room when the delete fails', async () => {
    window.confirm = jest.fn(() => true);
    deleteRoom.mockRejectedValue({ response: { data: { message: 'nope' } } });
    renderSettings();
    await userEvent.click(screen.getByRole('button', { name: /end room/i }));

    await waitFor(() => expect(deleteRoom).toHaveBeenCalled());
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
