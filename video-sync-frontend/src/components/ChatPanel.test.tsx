import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { ChatPanel } from './ChatPanel';

type Handler = (payload: any) => void;

const handlers: Record<string, Handler> = {};
const mockSocket = {
  on: (event: string, cb: Handler) => {
    handlers[event] = cb;
  },
  off: (event: string) => {
    delete handlers[event];
  },
  emit: jest.fn(),
};

jest.mock('../contexts/SocketContext', () => ({
  useSocket: () => ({ socket: mockSocket }),
}));

jest.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', username: 'ada' } }),
}));

const at = (iso: string) => new Date(iso);

const message = (over: Partial<Record<string, unknown>> = {}) => ({
  id: `m${Math.random()}`,
  userId: 'u2',
  username: 'grace',
  message: 'hello',
  timestamp: at('2026-08-09T20:30:00Z'),
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of Object.keys(handlers)) delete handlers[key];
  // scrollIntoView does not exist in jsdom
  Element.prototype.scrollIntoView = jest.fn();
});

const renderChat = () => render(<ChatPanel roomCode="ABC123" />);

describe('chat timestamps', () => {
  it('shows when a message was sent, with a machine-readable time', () => {
    renderChat();
    act(() => handlers['message-history']([message()]));

    const stamp = screen.getByText(/\d{1,2}:\d{2}/);
    expect(stamp.tagName.toLowerCase()).toBe('time');
    expect(stamp).toHaveAttribute('dateTime', '2026-08-09T20:30:00.000Z');
  });

  it('renders a message with an unusable timestamp rather than crashing', () => {
    // history comes off the wire; a bad value must not take the panel down
    renderChat();
    act(() => handlers['message-history']([message({ timestamp: 'nonsense' })]));

    expect(screen.getByText('hello')).toBeInTheDocument();
    expect(screen.queryByText(/invalid/i)).not.toBeInTheDocument();
  });
});

describe('scrolling while reading back', () => {
  it('follows the conversation when you are at the live end', () => {
    renderChat();
    act(() => handlers['chat-message'](message()));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(screen.queryByText(/new message/i)).not.toBeInTheDocument();
  });

  it('does not yank you to the bottom when you have scrolled up', () => {
    renderChat();
    const area = screen.getByTestId('chat-messages');
    // put the reader well away from the end
    Object.defineProperty(area, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(area, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(area, 'scrollTop', { value: 0, configurable: true });

    (Element.prototype.scrollIntoView as jest.Mock).mockClear();
    act(() => handlers['chat-message'](message({ message: 'while you read' })));

    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    // and it says what you missed, which is otherwise invisible
    expect(screen.getByText('1 new message')).toBeInTheDocument();
  });
});
