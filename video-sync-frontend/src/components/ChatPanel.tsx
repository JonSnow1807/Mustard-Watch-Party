import React, { useState, useEffect, useRef } from 'react';
import { useSocket } from '../contexts/SocketContext';
import { useAuth } from '../contexts/AuthContext';
import styled from '@emotion/styled';

const ChatContainer = styled.div`
  height: 400px;
  display: flex;
  flex-direction: column;
  background: white;
  border-radius: 8px;
  box-shadow: 0 2px 10px rgba(0,0,0,0.1);
`;

const MessagesArea = styled.div`
  flex: 1;
  overflow-y: auto;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
`;

const Message = styled.div<{ isOwn: boolean }>`
  padding: 0.5rem 1rem;
  border-radius: 18px;
  max-width: 70%;
  word-wrap: break-word;
  align-self: ${props => props.isOwn ? 'flex-end' : 'flex-start'};
  background: ${props => props.isOwn ? '#007bff' : '#f1f1f1'};
  color: ${props => props.isOwn ? 'white' : 'black'};
`;

const InputArea = styled.form`
  display: flex;
  padding: 1rem;
  border-top: 1px solid #eee;
  gap: 0.5rem;
`;

const Input = styled.input`
  flex: 1;
  padding: 0.5rem 1rem;
  border: 1px solid #ddd;
  border-radius: 20px;
  outline: none;
  
  &:focus {
    border-color: #007bff;
  }
`;

const SendButton = styled.button`
  padding: 0.5rem 1.5rem;
  background: #007bff;
  color: white;
  border: none;
  border-radius: 20px;
  cursor: pointer;
  
  &:hover {
    background: #0056b3;
  }
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
      <h3 style={{ padding: '1rem 1rem 0', margin: 0 }}>💬 Chat</h3>
      <MessagesArea>
        {messages.map((msg) => (
          <div key={msg.id}>
            {msg.userId !== user?.id && (
              <div style={{ fontSize: '0.8rem', color: '#666', marginBottom: '2px' }}>
                {msg.username}
              </div>
            )}
            <Message isOwn={msg.userId === user?.id}>
              {msg.message}
            </Message>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </MessagesArea>
      
      <InputArea onSubmit={sendMessage}>
        <Input
          type="text"
          placeholder="Type a message..."
          value={inputMessage}
          onChange={(e) => setInputMessage(e.target.value)}
          maxLength={200}
        />
        <SendButton type="submit">Send</SendButton>
      </InputArea>
    </ChatContainer>
  );
};