import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import styled from '@emotion/styled';
import { color, font, radius, focusRing, button, input, card } from '../theme';
import { IconGoogle, Wordmark } from '../components/Icons';
import { apiBaseUrl, apiService } from '../services/api';
import { readReturnTo } from '../services/return-to';

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

/**
 * An anchor, not a button: this is a full-page navigation off to Google, so
 * middle-click, "open in new tab" and the status bar preview should all
 * behave the way they do for any other link.
 */
const GoogleButton = styled.a`
  ${button.secondary}
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  text-decoration: none;
`;

const Divider = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 18px 0;
  font-family: ${font.body};
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: ${color.faint};

  &::before,
  &::after {
    content: '';
    flex: 1;
    height: 1px;
    background: ${color.line};
  }
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
  const location = useLocation();
  const { login, register } = useAuth();
  // Where the person was heading before we interrupted them to sign in.
  const returnTo = readReturnTo(location.search);
  const [isLogin, setIsLogin] = useState(true);
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    username: '',
    email: '',
    password: '',
  });
  // null while unknown: the button appears once the API confirms it can
  // actually complete the flow, rather than flashing in and out on a
  // deployment that has no Google credentials.
  const [googleEnabled, setGoogleEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiService
      .getProviders()
      .then(({ data }) => {
        if (!cancelled) setGoogleEnabled(Boolean(data?.google));
      })
      // an unreachable API is not a reason to show a broken button
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      if (isLogin) {
        await login(formData.username, formData.password);
      } else {
        await register(formData.username, formData.email, formData.password);
      }
      navigate(returnTo ?? '/', { replace: true });
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

          {googleEnabled && (
            <>
              <GoogleButton
                href={
                  returnTo
                    ? `${apiBaseUrl}/auth/google/start?returnTo=${encodeURIComponent(returnTo)}`
                    : `${apiBaseUrl}/auth/google/start`
                }
              >
                <IconGoogle size={16} />
                Continue with Google
              </GoogleButton>
              <Divider>or</Divider>
            </>
          )}

          <Form onSubmit={handleSubmit}>
            {/* the card carries no visible labels, so each control names
                itself - a placeholder is not an accessible name and it
                disappears the moment someone types */}
            <Input
              type="text"
              name="username"
              aria-label="Username"
              placeholder="Username"
              value={formData.username}
              onChange={handleChange}
              required
            />

            {!isLogin && (
              <Input
                type="email"
                name="email"
                aria-label="Email"
                placeholder="Email"
                value={formData.email}
                onChange={handleChange}
                required
              />
            )}

            <Input
              type="password"
              name="password"
              aria-label="Password"
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
