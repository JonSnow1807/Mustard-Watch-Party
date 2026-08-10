import React, { useState, useEffect, useRef } from 'react';
import { useSocket } from '../contexts/SocketContext';
import { useAuth } from '../contexts/AuthContext';
import styled from '@emotion/styled';
import {
  card,
  chip,
  chipInteractive,
  color,
  font,
  input,
  button,
  buttonSm,
  sectionLabel,
} from '../theme';

// The chat is a linear log, not a chat-bubble app: one column, sender
// names carrying the only color distinction. The 400px height and the
// messages area's own scroll are load-bearing - the end-anchor scroll
// only works while the list, not the page, is what overflows.
const ChatContainer = styled.div`
  ${card}
  height: 400px;
  display: flex;
  flex-direction: column;
  padding: 16px;
`;

const PanelTitle = styled.h3`
  ${sectionLabel}
  margin: 0 0 16px;
`;

const MessagesArea = styled.div`
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
`;

const MessageRow = styled.div`
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
`;

// An empty log should read as "nothing has happened yet", not as a bug.
const EmptyState = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  text-align: center;
`;

const EmptyTitle = styled.div`
  font-family: ${font.body};
  font-size: 13px;
  color: ${color.dim};
`;

const EmptyHint = styled.div`
  font-family: ${font.body};
  font-size: 12px;
  color: ${color.faint};
`;

/** Sender and time share a line: the time is metadata, not a message. */
const MessageHead = styled.div`
  display: flex;
  align-items: baseline;
  gap: 6px;
`;

const Timestamp = styled.time`
  font-family: ${font.mono};
  font-size: 10.5px;
  color: ${color.faint};
  font-variant-numeric: tabular-nums;
`;

const Sender = styled.div<{ isOwn: boolean }>`
  font-family: ${font.body};
  font-size: 11.5px;
  font-weight: 600;
  color: ${props => (props.isOwn ? color.text : color.mustard)};
`;

const MessageText = styled.div`
  font-family: ${font.body};
  font-size: 13.5px;
  line-height: 1.45;
  color: ${color.text};
  overflow-wrap: break-word;
  word-break: break-word;
`;

/**
 * Only appears when you have scrolled away AND missed something - it is the
 * answer to "did I miss anything", which is otherwise invisible while you
 * are reading back.
 */
const JumpToLatest = styled.button`
  ${chip.sm}
  ${chipInteractive}
  align-self: center;
  margin-bottom: 8px;
  background: ${color.mustardFaint};
  color: ${color.mustard};
  border-color: ${color.mustardDeep};
`;

const InputArea = styled.form`
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid ${color.line};
`;

const Input = styled.input`
  ${input}
  padding: 8px 12px;
  flex: 1;
  min-width: 0;
`;

const SendButton = styled.button`
  ${button.primary}
  ${buttonSm}
  flex-shrink: 0;
`;

/** Within this many pixels of the end counts as "reading the live end". */
const NEAR_BOTTOM_PX = 48;

/**
 * A time, not a date: chat is read during a film, so the useful question is
 * "was that just now or ten minutes ago", and anything older than today is
 * scrollback where the day matters more than the minute.
 */
const formatStamp = (value: Date | string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const sameDay = new Date().toDateString() === date.toDateString();
  return date.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    ...(sameDay ? {} : { month: 'short', day: 'numeric' }),
  });
};

interface ChatMessage {
  id: string;
  userId: string;
  username: string;
  message: string;
  timestamp: Date;
}

interface ChatPanelProps {
  roomCode: string;
}

export const ChatPanel: React.FC<ChatPanelProps> = ({ roomCode }) => {
  const { socket } = useSocket();
  const { user } = useAuth();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesAreaRef = useRef<HTMLDivElement>(null);
  const [unread, setUnread] = useState(0);
  // Whether the reader was at the live end BEFORE this message arrived.
  // Measuring after the render is too late: a message taller than the
  // near-bottom threshold pushes the end away by itself, so someone who was
  // reading live gets classed as reading history and stops being followed.
  const wasNearBottomRef = useRef(true);

  useEffect(() => {
    if (!socket) return;

    socket.on('chat-message', (data: ChatMessage) => {
      setMessages(prev => [...prev, data]);
    });

    socket.on('message-history', (history: ChatMessage[]) => {
      setMessages(history);
    });

    return () => {
      socket.off('chat-message');
      socket.off('message-history');
    };
  }, [socket]);

  // Only follow the conversation if the reader is already at the bottom.
  // Unconditional scrolling yanked anyone scrolling back through history
  // to the end every time somebody typed.
  useEffect(() => {
    if (wasNearBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      setUnread(0);
    } else {
      setUnread((n) => n + 1);
    }
  }, [messages]);

  const sendMessage = (e: React.FormEvent) => {
    e.preventDefault();

    if (!inputMessage.trim() || !socket || !user) return;

    const message = {
      userId: user.id,
      username: user.username,
      message: inputMessage.trim(),
    };

    socket.emit('send-message', {
      roomCode,
      message,
    });

    setInputMessage('');
  };

  return (
    <ChatContainer>
      <PanelTitle>Chat</PanelTitle>
      <MessagesArea
        data-testid="chat-messages"
        ref={messagesAreaRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom =
            el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
          wasNearBottomRef.current = atBottom;
          if (atBottom) setUnread(0);
        }}
      >
        {messages.length === 0 && (
          <EmptyState>
            <EmptyTitle>No messages yet.</EmptyTitle>
            <EmptyHint>Say something while you watch.</EmptyHint>
          </EmptyState>
        )}
        {messages.map((msg) => (
          <MessageRow key={msg.id}>
            <MessageHead>
              <Sender isOwn={msg.userId === user?.id}>{msg.username}</Sender>
              {formatStamp(msg.timestamp) && (
                <Timestamp dateTime={new Date(msg.timestamp).toISOString()}>
                  {formatStamp(msg.timestamp)}
                </Timestamp>
              )}
            </MessageHead>
            <MessageText>{msg.message}</MessageText>
          </MessageRow>
        ))}
        <div ref={messagesEndRef} />
      </MessagesArea>

      {unread > 0 && (
        <JumpToLatest
          type="button"
          onClick={() => {
            messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
            setUnread(0);
          }}
        >
          {unread} new {unread === 1 ? 'message' : 'messages'}
        </JumpToLatest>
      )}

      <InputArea onSubmit={sendMessage}>
        <Input
          type="text"
          placeholder="Type a message…"
          value={inputMessage}
          onChange={(e) => setInputMessage(e.target.value)}
          maxLength={200}
        />
        <SendButton type="submit">Send</SendButton>
      </InputArea>
    </ChatContainer>
  );
};
