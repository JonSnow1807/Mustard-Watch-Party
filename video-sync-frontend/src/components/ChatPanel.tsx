import React, { useState, useEffect, useRef } from 'react';
import { useSocket } from '../contexts/SocketContext';
import { useAuth } from '../contexts/AuthContext';
import styled from '@emotion/styled';
import { card, color, font, input, button, buttonSm, sectionLabel } from '../theme';

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

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
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
      <MessagesArea>
        {messages.length === 0 && (
          <EmptyState>
            <EmptyTitle>No messages yet.</EmptyTitle>
            <EmptyHint>Say something while you watch.</EmptyHint>
          </EmptyState>
        )}
        {messages.map((msg) => (
          <MessageRow key={msg.id}>
            <Sender isOwn={msg.userId === user?.id}>{msg.username}</Sender>
            <MessageText>{msg.message}</MessageText>
          </MessageRow>
        ))}
        <div ref={messagesEndRef} />
      </MessagesArea>

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
