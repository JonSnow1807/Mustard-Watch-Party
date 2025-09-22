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
  background: linear-gradient(to bottom, #ffffff, #fafafa);

  &::before {
    content: '';
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: radial-gradient(circle at 20% 80%, rgba(99, 102, 241, 0.03) 0%, transparent 50%),
                radial-gradient(circle at 80% 20%, rgba(139, 92, 246, 0.03) 0%, transparent 50%),
                radial-gradient(circle at 40% 40%, rgba(16, 185, 129, 0.02) 0%, transparent 50%);
    pointer-events: none;
    z-index: -1;
  }
`;

const LoginCard = styled.div`
  background: #ffffff;
  backdrop-filter: blur(20px);
  border: 1px solid #e2e8f0;
  border-radius: 20px;
  padding: 3rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
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
  background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #10b981 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
`;

const Subtitle = styled.p`
  text-align: center;
  margin-bottom: 2.5rem;
  color: #718096;
  font-size: 1.1rem;
`;

const Form = styled.form`
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
`;

const Input = styled.input`
  padding: 1rem 1.25rem;
  background: #fcfcfc;
  border: 2px solid #e2e8f0;
  border-radius: 12px;
  font-size: 1rem;
  color: #2d3748;
  transition: all 0.3s ease;
  backdrop-filter: blur(10px);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);

  &::placeholder {
    color: #a0aec0;
  }

  &:focus {
    outline: none;
    border-color: rgba(99, 102, 241, 0.3);
    box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
    background: #ffffff;
  }

  &:hover {
    border-color: #cbd5e1;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.07);
  }
`;

const Button = styled.button`
  padding: 1.25rem;
  background: #6366f1;
  color: white;
  border: none;
  border-radius: 12px;
  font-size: 1.1rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);

  &:hover {
    transform: translateY(-1px);
    background: #5558e3;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.07);
  }

  &:disabled {
    background: #e2e8f0;
    color: #a0aec0;
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
  color: #718096;
  font-size: 1rem;

  button {
    background: none;
    border: none;
    color: #6366f1;
    cursor: pointer;
    font-weight: 600;
    transition: color 0.3s ease;

    &:hover {
      color: #5558e3;
      text-decoration: underline;
    }
  }
`;

const FeatureList = styled.div`
  margin-top: 2rem;
  padding: 1.5rem;
  background: #f8fafc;
  border-radius: 12px;
  border: 1px solid #e2e8f0;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);

  h4 {
    color: #2d3748;
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
    color: #718096;
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