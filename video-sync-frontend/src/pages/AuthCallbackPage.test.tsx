import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../contexts/AuthContext';
import { AuthCallbackPage } from './AuthCallbackPage';
import { apiService } from '../services/api';

jest.mock('../services/api', () => ({
  AUTH_EXPIRED_EVENT: 'mustard:auth-expired',
  apiBaseUrl: 'http://api.test/api',
  apiService: { getMe: jest.fn(), getProviders: jest.fn() },
}));

const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

const getMe = apiService.getMe as jest.Mock;

const renderAt = (hash: string) => {
  window.history.replaceState(null, '', `/auth/callback${hash}`);
  return render(
    <AuthProvider>
      <MemoryRouter>
        <AuthCallbackPage />
      </MemoryRouter>
    </AuthProvider>,
  );
};

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  getMe.mockResolvedValue({
    data: { id: 'u1', username: 'ada', email: 'ada@example.com' },
  });
});

describe('the OAuth return trip', () => {
  it('exchanges the fragment token for a session', async () => {
    renderAt('#token=the-token');

    await waitFor(() => expect(getMe).toHaveBeenCalledWith('the-token'));
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem('user')!)).toMatchObject({
        id: 'u1',
        username: 'ada',
        token: 'the-token',
      }),
    );
    expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
  });

  it('scrubs the token out of the address bar', async () => {
    // it must not survive into history, a bookmark, or a shared URL
    renderAt('#token=the-token');
    await waitFor(() => expect(window.location.hash).toBe(''));
    expect(window.location.pathname).toBe('/auth/callback');
  });

  it('returns to where the sign-in started', async () => {
    renderAt('#token=the-token&to=%2Froom%2Fabc');
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith('/room/abc', { replace: true }),
    );
  });

  it.each([
    ['an absolute URL', 'https%3A%2F%2Fevil.example%2F'],
    ['a protocol-relative URL', '%2F%2Fevil.example%2F'],
  ])('refuses to be redirected off-site by %s', async (_name, to) => {
    // the server already filtered this, but the page must not depend on
    // that: the fragment is under the reader's control by construction
    renderAt(`#token=the-token&to=${to}`);
    await waitFor(() => expect(mockNavigate).toHaveBeenCalled());
    expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
  });

  it('signs nobody in when the API rejects the token', async () => {
    getMe.mockRejectedValue(new Error('401'));
    renderAt('#token=forged');

    await waitFor(() =>
      expect(screen.getByText(/couldn't sign you in/i)).toBeInTheDocument(),
    );
    expect(localStorage.getItem('user')).toBeNull();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('explains each failure the server can report, in its own words', async () => {
    const cases: Array<[string, RegExp]> = [
      ['denied', /cancelled/i],
      ['state', /expired/i],
      ['unverified', /verified/i],
      ['email_taken', /already has an account/i],
      ['exchange', /couldn't finish with google/i],
    ];
    for (const [code, expected] of cases) {
      const { unmount } = renderAt(`#error=${code}`);
      await waitFor(() =>
        expect(screen.getByText(expected)).toBeInTheDocument(),
      );
      expect(getMe).not.toHaveBeenCalled();
      unmount();
    }
  });

  it('falls back to a generic message for a code it does not know', async () => {
    renderAt('#error=something_new');
    await waitFor(() =>
      expect(screen.getByText(/couldn't sign you in/i)).toBeInTheDocument(),
    );
  });

  it('does not sign in twice when the effect runs twice', async () => {
    // StrictMode double-mounts effects in development, and this one has a
    // side effect that must happen once
    const { rerender } = renderAt('#token=the-token');
    rerender(
      <AuthProvider>
        <MemoryRouter>
          <AuthCallbackPage />
        </MemoryRouter>
      </AuthProvider>,
    );
    await waitFor(() => expect(getMe).toHaveBeenCalled());
    expect(getMe).toHaveBeenCalledTimes(1);
  });
});
