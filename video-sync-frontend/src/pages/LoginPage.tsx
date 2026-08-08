import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import styled from '@emotion/styled';
import { color, font, radius, focusRing, button, input, card } from '../theme';
import { Wordmark } from '../components/Icons';

const Page = styled.div`
  min-height: 100vh;
  background: ${color.bg0};
  padding: 12vh 20px 64px;
`;

const Column = styled.div`
  max-width: 400px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 24px;
`;

const LoginCard = styled.div`
  ${card}
  padding: 24px;
`;

const Title = styled.h2`
  font-family: ${font.display};
  font-size: 24px;
  font-weight: 700;
  color: ${color.text};
  margin: 0 0 20px;
`;

const Form = styled.form`
  display: flex;
  flex-direction: column;
  gap: 12px;
`;

const Input = styled.input`
  ${input}
`;

const SubmitButton = styled.button`
  ${button.primary}
  width: 100%;
  margin-top: 4px;
`;

const ToggleText = styled.p`
  margin: 0;
  text-align: center;
  font-family: ${font.body};
  font-size: 13px;
  color: ${color.dim};
`;

const ToggleButton = styled.button`
  font-family: ${font.body};
  font-size: 13px;
  font-weight: 600;
  color: ${color.mustard};
  background: none;
  border: none;
  border-radius: ${radius.sm};
  padding: 2px 4px;
  cursor: pointer;
  transition: color 120ms ease;

  &:hover {
    color: ${color.mustardBright};
  }

  &:focus-visible {
    outline: none;
    box-shadow: ${focusRing};
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
    <Page>
      <Column>
        <Wordmark size={22} />

        <LoginCard>
          <Title>{isLogin ? 'Sign in' : 'Create your account'}</Title>

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

            <SubmitButton type="submit" disabled={loading}>
              {loading ? 'One moment…' : isLogin ? 'Sign in' : 'Create account'}
            </SubmitButton>
          </Form>
        </LoginCard>

        <ToggleText>
          {isLogin ? 'New here? ' : 'Already have an account? '}
          <ToggleButton onClick={() => setIsLogin(!isLogin)}>
            {isLogin ? 'Create an account' : 'Sign in'}
          </ToggleButton>
        </ToggleText>
      </Column>
    </Page>
  );
};
