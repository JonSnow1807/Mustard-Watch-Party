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

const renderPage = (search = '') => {
  window.history.replaceState(null, '', `/login${search}`);
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[`/login${search}`]}>
        <LoginPage />
      </MemoryRouter>
    </AuthProvider>,
  );
};

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

describe('the room survives sign-in', () => {
  it('hands the destination to Google so the callback can return there', async () => {
    getProviders.mockResolvedValue({ data: { google: true } });
    renderPage('?next=%2Froom%2FABC123');

    const link = await screen.findByRole('link', {
      name: /continue with google/i,
    });
    expect(link).toHaveAttribute(
      'href',
      'http://api.test/api/auth/google/start?returnTo=%2Froom%2FABC123',
    );
  });

  it('leaves the Google link bare when there is nowhere to return to', async () => {
    getProviders.mockResolvedValue({ data: { google: true } });
    renderPage();

    const link = await screen.findByRole('link', {
      name: /continue with google/i,
    });
    expect(link).toHaveAttribute(
      'href',
      'http://api.test/api/auth/google/start',
    );
  });

  it('ignores a destination pointing off-site', async () => {
    // the value rides in a link anyone can send, so it is filtered here too
    getProviders.mockResolvedValue({ data: { google: true } });
    renderPage('?next=https%3A%2F%2Fevil.example');

    const link = await screen.findByRole('link', {
      name: /continue with google/i,
    });
    expect(link).toHaveAttribute(
      'href',
      'http://api.test/api/auth/google/start',
    );
  });
});
