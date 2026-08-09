import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { apiService } from '../services/api';
import { toast } from 'react-hot-toast';
import styled from '@emotion/styled';
import { isAcceptableVideoUrl } from '../shared/media-source';
import { color, font, radius, focusRing, button, input, card, sectionLabel } from '../theme';
import { IconCheck, Wordmark } from '../components/Icons';

const Page = styled.div`
  min-height: 100vh;
  background: ${color.bg0};
`;

const TopBar = styled.header`
  max-width: 560px;
  margin: 0 auto;
  padding: 20px 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
`;

const BackButton = styled.button`
  font-family: ${font.body};
  font-size: 13px;
  font-weight: 500;
  color: ${color.dim};
  background: transparent;
  border: none;
  border-radius: ${radius.sm};
  padding: 4px 6px;
  cursor: pointer;
  transition: color 120ms ease;

  &:hover {
    color: ${color.text};
  }

  &:focus-visible {
    outline: none;
    box-shadow: ${focusRing};
  }
`;

const Content = styled.main`
  max-width: 560px;
  margin: 0 auto;
  padding: 12px 24px 64px;
`;

const Title = styled.h1`
  font-family: ${font.display};
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: ${color.text};
  margin: 0 0 6px;
`;

const Subtitle = styled.p`
  font-family: ${font.body};
  font-size: 14px;
  color: ${color.dim};
  margin: 0 0 24px;
`;

const Form = styled.form`
  ${card}
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 20px;
`;

const Field = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
`;

const Label = styled.label`
  ${sectionLabel}
`;

const Input = styled.input`
  ${input}
`;

const TextArea = styled.textarea`
  ${input}
  min-height: 92px;
  line-height: 1.5;
  resize: vertical;
`;

const HelpText = styled.p`
  font-family: ${font.body};
  font-size: 12px;
  line-height: 1.5;
  color: ${color.faint};
  margin: 0;
`;

const CountText = styled.p`
  font-family: ${font.mono};
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  color: ${color.faint};
  margin: 0;
`;

const CheckRow = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 12px;
`;

const CheckControl = styled.span`
  position: relative;
  flex: none;
  width: 18px;
  height: 18px;
  margin-top: 1px;
`;

const HiddenCheckbox = styled.input`
  position: absolute;
  top: 0;
  left: 0;
  width: 18px;
  height: 18px;
  margin: 0;
  opacity: 0;
  cursor: pointer;
`;

const CheckMark = styled.span<{ isChecked: boolean }>`
  position: absolute;
  top: 0;
  left: 0;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: ${radius.sm};
  background: ${p => (p.isChecked ? color.mustard : color.bg2)};
  border: 1px solid ${p => (p.isChecked ? color.mustard : color.lineBright)};
  color: ${color.mustardInk};
  pointer-events: none;
  transition: background 120ms ease, border-color 120ms ease;

  input:focus-visible + & {
    box-shadow: ${focusRing};
  }
`;

const CheckText = styled.div`
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
`;

const CheckLabel = styled.label`
  font-family: ${font.body};
  font-size: 14px;
  color: ${color.text};
  cursor: pointer;
`;

const CheckSub = styled.span`
  font-family: ${font.body};
  font-size: 12px;
  line-height: 1.5;
  color: ${color.faint};
`;

const SubmitButton = styled.button`
  ${button.primary}
  width: 100%;
`;

const GateCard = styled.div`
  ${card}
  padding: 24px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 16px;
`;

const GateTitle = styled.h1`
  font-family: ${font.display};
  font-size: 20px;
  font-weight: 700;
  color: ${color.text};
  margin: 0;
`;

const GateButton = styled.button`
  ${button.primary}
`;

export const CreateRoomPage: React.FC = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    videoUrl: '',
    isPublic: false,
    description: '',
    tags: '',
    allowGuestControl: false,
  });

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value, type } = e.target;
    const checked = (e.target as HTMLInputElement).checked;

    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value,
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!user) {
      toast.error('Sign in first');
      navigate('/login');
      return;
    }

    if (!formData.name.trim()) {
      toast.error('Please enter a room name');
      return;
    }

    // the same shared admission rule the backend DTO enforces - refused
    // here it is instant feedback instead of a 400
    const videoUrl = formData.videoUrl.trim();
    if (videoUrl && !isAcceptableVideoUrl(videoUrl)) {
      toast.error("That URL can't be played - use a video link or YouTube id");
      return;
    }

    setLoading(true);
    try {
      const response = await apiService.createRoom({
        name: formData.name,
        videoUrl: videoUrl || undefined,
        isPublic: formData.isPublic,
        description: formData.isPublic ? formData.description : undefined,
        tags: formData.isPublic && formData.tags ? formData.tags.split(',').map(t => t.trim()) : [],
        allowGuestControl: formData.allowGuestControl,
      });

      toast.success('Room created');
      navigate(`/room/${response.data.code}`);
    } catch (error: any) {
      toast.error(error.response?.data?.message || "Couldn't create the room");
    } finally {
      setLoading(false);
    }
  };

  if (!user) {
    return (
      <Page>
        <TopBar>
          <Wordmark size={16} />
        </TopBar>
        <Content>
          <GateCard>
            <GateTitle>Sign in to start a room</GateTitle>
            <GateButton onClick={() => navigate('/login')}>Go to sign in</GateButton>
          </GateCard>
        </Content>
      </Page>
    );
  }

  return (
    <Page>
      <TopBar>
        <Wordmark size={16} />
        <BackButton onClick={() => navigate('/')}>Back to rooms</BackButton>
      </TopBar>

      <Content>
        <Title>Start a room</Title>
        <Subtitle>Name it, drop a link, share the code.</Subtitle>

        <Form onSubmit={handleSubmit}>
          <Field>
            <Label htmlFor="name">Room name</Label>
            <Input
              id="name"
              name="name"
              type="text"
              placeholder="Movie night"
              value={formData.name}
              onChange={handleInputChange}
              required
            />
          </Field>

          <Field>
            <Label htmlFor="videoUrl">Video link</Label>
            <Input
              id="videoUrl"
              name="videoUrl"
              type="url"
              placeholder="https://youtube.com/watch?v=… — or Vimeo, HLS, MP4"
              value={formData.videoUrl}
              onChange={handleInputChange}
            />
            <HelpText>
              Optional — set or change it any time from room settings. Works with YouTube,
              Vimeo, HLS manifests, and direct MP4/WebM links.
            </HelpText>
          </Field>

          <CheckRow>
            <CheckControl>
              <HiddenCheckbox
                id="allowGuestControl"
                name="allowGuestControl"
                type="checkbox"
                checked={formData.allowGuestControl}
                onChange={handleInputChange}
              />
              <CheckMark isChecked={formData.allowGuestControl}>
                {formData.allowGuestControl && <IconCheck size={12} />}
              </CheckMark>
            </CheckControl>
            <CheckText>
              <CheckLabel htmlFor="allowGuestControl">Open controls to everyone</CheckLabel>
              <CheckSub>Anyone in the room can play, pause, and seek.</CheckSub>
            </CheckText>
          </CheckRow>

          <CheckRow>
            <CheckControl>
              <HiddenCheckbox
                id="isPublic"
                name="isPublic"
                type="checkbox"
                checked={formData.isPublic}
                onChange={handleInputChange}
              />
              <CheckMark isChecked={formData.isPublic}>
                {formData.isPublic && <IconCheck size={12} />}
              </CheckMark>
            </CheckControl>
            <CheckText>
              <CheckLabel htmlFor="isPublic">List publicly</CheckLabel>
              <CheckSub>Show this room on the home page.</CheckSub>
            </CheckText>
          </CheckRow>

          {formData.isPublic && (
            <>
              <Field>
                <Label htmlFor="description">Description</Label>
                <TextArea
                  id="description"
                  name="description"
                  placeholder="What you'll be watching."
                  value={formData.description}
                  onChange={handleInputChange}
                  maxLength={200}
                />
                <CountText>{formData.description.length}/200</CountText>
              </Field>

              <Field>
                <Label htmlFor="tags">Tags</Label>
                <Input
                  id="tags"
                  name="tags"
                  type="text"
                  placeholder="movies, horror, weekend"
                  value={formData.tags}
                  onChange={handleInputChange}
                />
                <HelpText>
                  Comma-separated.
                </HelpText>
              </Field>
            </>
          )}

          <SubmitButton type="submit" disabled={loading}>
            {loading ? 'Creating…' : 'Create room'}
          </SubmitButton>
        </Form>
      </Content>
    </Page>
  );
};
