import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { apiService } from '../services/api';
import { toast } from 'react-hot-toast';
import styled from '@emotion/styled';

const Container = styled.div`
  max-width: 700px;
  margin: 0 auto;
  padding: 2rem;
  min-height: 100vh;
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
                radial-gradient(circle at 80% 20%, rgba(139, 92, 246, 0.03) 0%, transparent 50%);
    pointer-events: none;
    z-index: -1;
  }
`;

const Header = styled.header`
  text-align: center;
  margin-bottom: 3rem;
  animation: fadeIn 1s ease-out;
`;

const Title = styled.h1`
  font-size: 3.5rem;
  font-weight: 700;
  margin-bottom: 1rem;
  background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 50%, #10b981 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;

  @media (max-width: 768px) {
    font-size: 2.5rem;
  }
`;

const Subtitle = styled.p`
  font-size: 1.2rem;
  color: #718096;
  margin-bottom: 2rem;
  animation: fadeIn 1s ease-out 0.2s both;
`;

const Form = styled.form`
  background: #ffffff;
  backdrop-filter: blur(20px);
  border: 1px solid #e2e8f0;
  border-radius: 20px;
  padding: 3rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
  animation: fadeIn 1s ease-out 0.4s both;

  @media (max-width: 768px) {
    padding: 2rem;
  }
`;

const FormGroup = styled.div`
  margin-bottom: 2rem;
`;

const Label = styled.label`
  display: block;
  margin-bottom: 0.75rem;
  font-weight: 600;
  color: #4a5568;
  font-size: 1rem;
`;

const Input = styled.input`
  width: 100%;
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

const TextArea = styled.textarea`
  width: 100%;
  padding: 1rem 1.25rem;
  background: #fcfcfc;
  border: 2px solid #e2e8f0;
  border-radius: 12px;
  font-size: 1rem;
  color: #2d3748;
  min-height: 120px;
  resize: vertical;
  transition: all 0.3s ease;
  backdrop-filter: blur(10px);
  font-family: inherit;
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

const CheckboxGroup = styled.div`
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-bottom: 1.5rem;
  padding: 1rem;
  background: #f8fafc;
  border-radius: 12px;
  border: 1px solid #e2e8f0;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
`;

const Checkbox = styled.input`
  width: 20px;
  height: 20px;
  accent-color: #6366f1;
  cursor: pointer;
`;

const Button = styled.button`
  width: 100%;
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

const BackButton = styled.button`
  padding: 0.75rem 1.5rem;
  background: #f8fafc;
  color: #718096;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  cursor: pointer;
  margin-bottom: 2rem;
  font-weight: 500;
  transition: all 0.3s ease;
  backdrop-filter: blur(10px);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);

  &:hover {
    background: #f1f5f9;
    border-color: #cbd5e1;
    transform: translateY(-1px);
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.07);
  }
`;

const HelpText = styled.p`
  font-size: 0.9rem;
  color: #a0aec0;
  margin-top: 0.5rem;
  line-height: 1.4;
`;

const ExampleText = styled.div`
  background: #f8fafc;
  padding: 1.5rem;
  border-radius: 12px;
  margin-top: 1rem;
  font-size: 0.9rem;
  color: #718096;
  border: 1px solid #e2e8f0;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);

  strong {
    color: #4a5568;
    font-weight: 600;
  }

  code {
    background: rgba(99, 102, 241, 0.1);
    padding: 0.25rem 0.5rem;
    border-radius: 6px;
    font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
    font-size: 0.85rem;
    color: #6366f1;
    border: 1px solid rgba(99, 102, 241, 0.2);
  }
`;

const FeatureCard = styled.div`
  background: #f8fafc;
  padding: 1.5rem;
  border-radius: 12px;
  margin-bottom: 2rem;
  border: 1px solid #e2e8f0;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);

  h4 {
    color: #2d3748;
    margin-bottom: 0.5rem;
    font-weight: 600;
  }

  p {
    color: #718096;
    font-size: 0.9rem;
    line-height: 1.5;
  }
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
      toast.error('Please login first');
      navigate('/login');
      return;
    }

    if (!formData.name.trim()) {
      toast.error('Please enter a room name');
      return;
    }

    setLoading(true);
    try {
      const response = await apiService.createRoom({
        name: formData.name,
        videoUrl: formData.videoUrl || undefined,
        userId: user.id,
        isPublic: formData.isPublic,
        description: formData.isPublic ? formData.description : undefined,
        tags: formData.isPublic && formData.tags ? formData.tags.split(',').map(t => t.trim()) : [],
        allowGuestControl: formData.allowGuestControl,
      });
      
      toast.success('Watch party created successfully! 🎉');
      navigate(`/room/${response.data.code}`);
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to create watch party');
    } finally {
      setLoading(false);
    }
  };

  if (!user) {
    return (
      <Container>
        <Header>
          <Title>Create Watch Party</Title>
          <Subtitle>Please login to create a synchronized video experience</Subtitle>
        </Header>
        <Button onClick={() => navigate('/login')}>Go to Login</Button>
      </Container>
    );
  }

  return (
    <Container>
      <BackButton onClick={() => navigate('/')}>
        ← Back to Home
      </BackButton>
      
      <Header>
        <Title>🎬 Create New Watch Party</Title>
        <Subtitle>Set up a synchronized video experience for you and your friends</Subtitle>
      </Header>

      <Form onSubmit={handleSubmit}>
        <FormGroup>
          <Label htmlFor="name">Party Name *</Label>
          <Input
            id="name"
            name="name"
            type="text"
            placeholder="Enter party name (e.g., Movie Night with Friends)"
            value={formData.name}
            onChange={handleInputChange}
            required
          />
          <HelpText>
            Choose a catchy name that will attract participants to your watch party
          </HelpText>
        </FormGroup>

        <FormGroup>
          <Label htmlFor="videoUrl">Video URL (Optional)</Label>
          <Input
            id="videoUrl"
            name="videoUrl"
            type="url"
            placeholder="https://youtube.com/watch?v=..."
            value={formData.videoUrl}
            onChange={handleInputChange}
          />
          <HelpText>
            You can add a video URL now or later in the party settings
          </HelpText>
          <ExampleText>
            <strong>Supported platforms:</strong><br />
            • <code>https://youtube.com/watch?v=VIDEO_ID</code><br />
            • <code>https://youtu.be/VIDEO_ID</code><br />
            • <code>https://vimeo.com/VIDEO_ID</code>
          </ExampleText>
        </FormGroup>

        <FormGroup>
          <CheckboxGroup>
            <Checkbox
              id="allowGuestControl"
              name="allowGuestControl"
              type="checkbox"
              checked={formData.allowGuestControl}
              onChange={handleInputChange}
            />
            <Label htmlFor="allowGuestControl" style={{ margin: 0, cursor: 'pointer', flex: 1 }}>
              👥 Allow collaborative control (all participants can control video)
            </Label>
          </CheckboxGroup>
          <HelpText>
            Enable this to let all participants play, pause, and seek the video. Otherwise, only you can control.
          </HelpText>
        </FormGroup>

        <FormGroup>
          <CheckboxGroup>
            <Checkbox
              id="isPublic"
              name="isPublic"
              type="checkbox"
              checked={formData.isPublic}
              onChange={handleInputChange}
            />
            <Label htmlFor="isPublic" style={{ margin: 0, cursor: 'pointer', flex: 1 }}>
              Make this party public (discoverable by everyone)
            </Label>
          </CheckboxGroup>
          <HelpText>
            Public parties appear in the discovery feed and can be joined by anyone
          </HelpText>
        </FormGroup>

        {formData.isPublic && (
          <>
            <FormGroup>
              <Label htmlFor="description">Party Description</Label>
              <TextArea
                id="description"
                name="description"
                placeholder="Describe what you'll be watching or the theme of your party..."
                value={formData.description}
                onChange={handleInputChange}
                maxLength={200}
              />
              <HelpText>
                {formData.description.length}/200 characters
              </HelpText>
            </FormGroup>

            <FormGroup>
              <Label htmlFor="tags">Tags</Label>
              <Input
                id="tags"
                name="tags"
                type="text"
                placeholder="movies, horror, friends, weekend"
                value={formData.tags}
                onChange={handleInputChange}
              />
              <HelpText>
                Add tags to help others discover your party (comma separated)
              </HelpText>
            </FormGroup>
          </>
        )}

        <FeatureCard>
          <h4>✨ What makes a great watch party?</h4>
          <p>
            • Choose an engaging video that everyone will enjoy<br />
            • Set the right mood with a descriptive title and tags<br />
            • Consider enabling collaborative control for interactive sessions<br />
            • Invite friends who share similar interests<br />
            • Be active in the chat to keep everyone engaged
          </p>
        </FeatureCard>

        <Button type="submit" disabled={loading}>
          {loading ? 'Creating Watch Party...' : 'Create Watch Party'}
        </Button>
      </Form>
    </Container>
  );
}; 