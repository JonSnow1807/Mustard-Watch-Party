import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthProvider, useAuth } from './AuthContext';
import { apiService } from '../services/api';
import { toast } from 'react-hot-toast';

jest.mock('../services/api', () => ({
  AUTH_EXPIRED_EVENT: 'mustard:auth-expired',
  apiBaseUrl: 'http://api.test/api',
  apiService: { claim: jest.fn(), getMe: jest.fn() },
}));

jest.mock('react-hot-toast', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

const claim = apiService.claim as jest.Mock;

/** A guest already in a session, which is the only state claiming applies to. */
const guest = {
  id: 'g1',
  username: 'guest-quiet-fox',
  email: '11111111@guest.invalid',
  token: 'old-token',
};

const Probe: React.FC = () => {
  const { user, isGuest, claimAccount } = useAuth();
  return (
    <div>
      <span data-testid="name">{user?.username}</span>
      <span data-testid="token">{user?.token}</span>
      <span data-testid="guest">{String(isGuest)}</span>
      <button
        onClick={() => {
          claimAccount('ada', 'ada@example.com', 'a-real-password').catch(
            () => undefined,
          );
        }}
      >
        claim
      </button>
    </div>
  );
};

const renderAsGuest = () => {
  localStorage.setItem('user', JSON.stringify(guest));
  return render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
};

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
});

test('a guest is recognised as one by the address no real account can hold', async () => {
  renderAsGuest();
  await waitFor(() =>
    expect(screen.getByTestId('guest')).toHaveTextContent('true'),
  );
});

test('a successful claim adopts the new identity and the new token', async () => {
  // The server issues a fresh token because the old one carries the guest
  // name. Keeping the old one would leave the stale name on everything the
  // socket handshake and the room list display.
  claim.mockResolvedValue({
    data: {
      id: 'g1',
      username: 'ada',
      email: 'ada@example.com',
      token: 'new-token',
    },
  });
  renderAsGuest();
  await waitFor(() =>
    expect(screen.getByTestId('guest')).toHaveTextContent('true'),
  );

  await userEvent.click(screen.getByRole('button', { name: 'claim' }));

  await waitFor(() =>
    expect(screen.getByTestId('name')).toHaveTextContent('ada'),
  );
  expect(screen.getByTestId('token')).toHaveTextContent('new-token');
  // and no longer a guest, so the "keep this account" button goes away
  expect(screen.getByTestId('guest')).toHaveTextContent('false');

  // persisted, or a reload would drop them back into the guest session they
  // just replaced
  expect(JSON.parse(localStorage.getItem('user') || '{}')).toMatchObject({
    id: 'g1',
    username: 'ada',
    token: 'new-token',
  });
});

test('the id is unchanged, which is the whole point of claiming', async () => {
  claim.mockResolvedValue({
    data: { id: 'g1', username: 'ada', email: 'a@b.co', token: 't' },
  });
  renderAsGuest();
  await waitFor(() =>
    expect(screen.getByTestId('guest')).toHaveTextContent('true'),
  );
  await userEvent.click(screen.getByRole('button', { name: 'claim' }));
  await waitFor(() =>
    expect(screen.getByTestId('name')).toHaveTextContent('ada'),
  );
  expect(JSON.parse(localStorage.getItem('user') || '{}').id).toBe('g1');
});

describe('when it fails', () => {
  it("shows the server's reason for a taken name, not a generic one", async () => {
    // 409 and 400 are the two the server explains usefully - "that name or
    // email is taken" tells someone what to change, and swallowing it for a
    // house string would make the form unfixable.
    claim.mockRejectedValue({
      response: { status: 409, data: { message: 'That name or email is taken' } },
    });
    renderAsGuest();
    await waitFor(() =>
      expect(screen.getByTestId('guest')).toHaveTextContent('true'),
    );
    await userEvent.click(screen.getByRole('button', { name: 'claim' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('That name or email is taken'),
    );
    // and the session is untouched, so nothing was half-changed
    expect(screen.getByTestId('name')).toHaveTextContent('guest-quiet-fox');
    expect(screen.getByTestId('token')).toHaveTextContent('old-token');
  });

  it('leaves the guest session intact on a server error', async () => {
    claim.mockRejectedValue({ response: { status: 500 } });
    renderAsGuest();
    await waitFor(() =>
      expect(screen.getByTestId('guest')).toHaveTextContent('true'),
    );
    await userEvent.click(screen.getByRole('button', { name: 'claim' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't save your account"),
    );
    expect(screen.getByTestId('guest')).toHaveTextContent('true');
    expect(JSON.parse(localStorage.getItem('user') || '{}').token).toBe(
      'old-token',
    );
  });
});
