import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import styled from '@emotion/styled';

const Container = styled.div`
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  
  &::before {
    content: '';
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: radial-gradient(circle at 20% 80%, rgba(37, 99, 235, 0.08) 0%, transparent 50%),
                radial-gradient(circle at 80% 20%, rgba(30, 64, 175, 0.08) 0%, transparent 50%),
                radial-gradient(circle at 40% 40%, rgba(25, 57, 155, 0.05) 0%, transparent 50%);
    pointer-events: none;
    z-index: -1;
  }
`;

const LoginCard = styled.div`
  background: rgba(255, 255, 255, 0.95);
  backdrop-filter: blur(20px);
  border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 20px;
  padding: 3rem;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
  width: 100%;
  max-width: 450px;
  animation: fadeIn 1s ease-out;

  @media (max-width: 768px) {
    padding: 2rem;
    margin: 1rem;
  }
`;

const Title = styled.h2`
  text-align: center;
  margin-bottom: 0.5rem;
  font-size: 2.5rem;
  font-weight: 700;
  background: linear-gradient(135deg, #2563eb 0%, #1e40af 50%, #1d4ed8 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
`;

const Subtitle = styled.p`
  text-align: center;
  margin-bottom: 2.5rem;
  color: #64748b;
  font-size: 1.1rem;
`;

const Form = styled.form`
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
`;

const Input = styled.input`
  padding: 1rem 1.25rem;
  background: rgba(0, 0, 0, 0.03);
  border: 2px solid rgba(0, 0, 0, 0.1);
  border-radius: 12px;
  font-size: 1rem;
  color: #1e293b;
  transition: all 0.3s ease;
  backdrop-filter: blur(10px);

  &::placeholder {
    color: #94a3b8;
  }

  &:focus {
    outline: none;
    border-color: rgba(37, 99, 235, 0.5);
    box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
    background: rgba(0, 0, 0, 0.05);
  }

  &:hover {
    border-color: rgba(0, 0, 0, 0.2);
  }
`;

const Button = styled.button`
  padding: 1.25rem;
  background: linear-gradient(135deg, #2563eb 0%, #1e40af 100%);
  color: white;
  border: none;
  border-radius: 12px;
  font-size: 1.1rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
  box-shadow: 0 4px 20px rgba(37, 99, 235, 0.3);

  &:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 30px rgba(37, 99, 235, 0.4);
  }

  &:disabled {
    background: rgba(0, 0, 0, 0.1);
    color: #94a3b8;
    cursor: not-allowed;
    transform: none;
    box-shadow: none;
  }

  &:active {
    transform: translateY(0);
  }
`;

const ToggleText = styled.p`
  text-align: center;
  margin-top: 2rem;
  color: #64748b;
  font-size: 1rem;

  button {
    background: none;
    border: none;
    color: #2563eb;
    cursor: pointer;
    font-weight: 600;
    transition: color 0.3s ease;

    &:hover {
      color: #1e40af;
      text-decoration: underline;
    }
  }
`;

const FeatureList = styled.div`
  margin-top: 2rem;
  padding: 1.5rem;
  background: rgba(0, 0, 0, 0.03);
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.1);

  h4 {
    color: #1e293b;
    margin-bottom: 1rem;
    font-weight: 600;
    text-align: center;
  }

  ul {
    list-style: none;
    padding: 0;
    margin: 0;
  }

  li {
    color: #64748b;
    margin-bottom: 0.5rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;

    &::before {
      content: '✨';
      font-size: 0.9rem;
    }
  }
`;

export const LoginPage: React.FC = () => {
  const navigate = useNavigate();
  const { login, register } = useAuth();
  const [isLogin, setIsLogin] = useState(true);
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    username: '',
    email: '',
    password: '',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      if (isLogin) {
        await login(formData.username, formData.password);
      } else {
        await register(formData.username, formData.email, formData.password);
      }
      navigate('/');
    } catch (error) {
      // Error handling is done in the auth context
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value,
    });
  };

  return (
    <Container>
      <LoginCard>
        <Title>{isLogin ? 'Welcome Back' : 'Join the Party'}</Title>
        <Subtitle>
          {isLogin 
            ? 'Sign in to continue your synchronized video experience'
            : 'Create an account to start hosting watch parties'
          }
        </Subtitle>
        
        <Form onSubmit={handleSubmit}>
          <Input
            type="text"
            name="username"
            placeholder="Username"
            value={formData.username}
            onChange={handleChange}
            required
          />
          
          {!isLogin && (
            <Input
              type="email"
              name="email"
              placeholder="Email"
              value={formData.email}
              onChange={handleChange}
              required
            />
          )}
          
          <Input
            type="password"
            name="password"
            placeholder="Password"
            value={formData.password}
            onChange={handleChange}
            required
          />
          
          <Button type="submit" disabled={loading}>
            {loading ? 'Loading...' : isLogin ? 'Sign In' : 'Create Account'}
          </Button>
        </Form>
        
        <ToggleText>
          {isLogin ? "Don't have an account? " : "Already have an account? "}
          <button onClick={() => setIsLogin(!isLogin)}>
            {isLogin ? 'Sign Up' : 'Sign In'}
          </button>
        </ToggleText>
        
        <FeatureList>
          <h4>🎬 Why Choose Mustard Watch Party?</h4>
          <ul>
            <li>Real-time synchronized video playback</li>
            <li>Live chat with friends while watching</li>
            <li>Create public or private watch parties</li>
            <li>Works with YouTube, Vimeo, and more</li>
            <li>Beautiful, modern interface</li>
          </ul>
        </FeatureList>
      </LoginCard>
    </Container>
  );
};