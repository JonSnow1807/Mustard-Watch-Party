import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../contexts/AuthContext';
import { LoginPage } from './LoginPage';
import { apiService } from '../services/api';

jest.mock('../services/api', () => ({
  AUTH_EXPIRED_EVENT: 'mustard:auth-expired',
  apiBaseUrl: 'http://api.test/api',
  apiService: { getProviders: jest.fn(), getMe: jest.fn() },
}));

const getProviders = apiService.getProviders as jest.Mock;

const renderPage = () =>
  render(
    <AuthProvider>
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    </AuthProvider>,
  );

beforeEach(() => {
  jest.clearAllMocks();
  getProviders.mockResolvedValue({ data: { google: false } });
});

test('renders the sign-in form', async () => {
  renderPage();
  expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  await waitFor(() => expect(getProviders).toHaveBeenCalled());
});

describe('the Google button', () => {
  it('appears only once the API says it can complete the flow', async () => {
    getProviders.mockResolvedValue({ data: { google: true } });
    renderPage();

    const link = await screen.findByRole('link', {
      name: /continue with google/i,
    });
    // an anchor, so middle-click and "open in new tab" work; and it points
    // at the API, since the browser has to leave for Google
    expect(link).toHaveAttribute(
      'href',
      'http://api.test/api/auth/google/start',
    );
  });

  it('stays hidden on a deployment with no Google credentials', async () => {
    renderPage();
    await waitFor(() => expect(getProviders).toHaveBeenCalled());
    expect(
      screen.queryByRole('link', { name: /continue with google/i }),
    ).not.toBeInTheDocument();
  });

  it('stays hidden when the API cannot be reached', async () => {
    // a dead button is worse than no button
    getProviders.mockRejectedValue(new Error('network'));
    renderPage();

    await waitFor(() => expect(getProviders).toHaveBeenCalled());
    expect(
      screen.queryByRole('link', { name: /continue with google/i }),
    ).not.toBeInTheDocument();
    // and the password form still works
    expect(screen.getByRole('button', { name: /sign in/i })).toBeEnabled();
  });
});
