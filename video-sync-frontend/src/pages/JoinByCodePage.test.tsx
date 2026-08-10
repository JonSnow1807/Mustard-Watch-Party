import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { JoinByCodePage } from './JoinByCodePage';

const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

const renderPage = () =>
  render(
    <MemoryRouter>
      <JoinByCodePage />
    </MemoryRouter>,
  );

beforeEach(() => jest.clearAllMocks());

describe('somewhere to type a room code', () => {
  it('takes a plain code to the room', async () => {
    renderPage();
    await userEvent.type(screen.getByLabelText('Room code'), 'ABC123');
    await userEvent.click(screen.getByRole('button', { name: /join room/i }));

    expect(mockNavigate).toHaveBeenCalledWith('/join-room/ABC123');
  });

  it.each([
    ['a share link', 'https://mustard.watch/join-room/ABC123'],
    ['a room URL', 'https://mustard.watch/room/ABC123'],
    ['surrounding whitespace', '  ABC123  '],
  ])('accepts %s, because that is what people paste', async (_name, typed) => {
    renderPage();
    await userEvent.type(screen.getByLabelText('Room code'), typed);
    await userEvent.click(screen.getByRole('button', { name: /join room/i }));

    expect(mockNavigate).toHaveBeenCalledWith('/join-room/ABC123');
  });

  it('does not navigate on an empty or junk-only code', async () => {
    renderPage();
    const button = screen.getByRole('button', { name: /join room/i });
    expect(button).toBeDisabled();

    await userEvent.type(screen.getByLabelText('Room code'), '///');
    await userEvent.click(button);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('is reachable without an account - the invite path starts here', () => {
    // no auth context is mounted in this test at all; the page must not
    // depend on one, because "I have a code" is a signed-out entry point
    renderPage();
    expect(screen.getByLabelText('Room code')).toBeInTheDocument();
  });
});
