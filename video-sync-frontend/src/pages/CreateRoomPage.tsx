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
  
  &::before {
    content: '';
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: radial-gradient(circle at 20% 80%, rgba(59, 130, 246, 0.3) 0%, transparent 50%),
                radial-gradient(circle at 80% 20%, rgba(37, 99, 235, 0.3) 0%, transparent 50%);
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
  background: linear-gradient(135deg, #3b82f6 0%, #2563eb 50%, #1e40af 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  
  @media (max-width: 768px) {
    font-size: 2.5rem;
  }
`;

const Subtitle = styled.p`
  font-size: 1.2rem;
  color: rgba(255, 255, 255, 0.7);
  margin-bottom: 2rem;
  animation: fadeIn 1s ease-out 0.2s both;
`;

const Form = styled.form`
  background: rgba(255, 255, 255, 0.05);
  backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 20px;
  padding: 3rem;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
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
  color: rgba(255, 255, 255, 0.9);
  font-size: 1rem;
`;

const Input = styled.input`
  width: 100%;
  padding: 1rem 1.25rem;
  background: rgba(255, 255, 255, 0.05);
  border: 2px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  font-size: 1rem;
  color: #ffffff;
  transition: all 0.3s ease;
  backdrop-filter: blur(10px);
  
  &::placeholder {
    color: rgba(255, 255, 255, 0.5);
  }
  
  &:focus {
    outline: none;
    border-color: rgba(59, 130, 246, 0.5);
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
    background: rgba(255, 255, 255, 0.08);
  }
  
  &:hover {
    border-color: rgba(255, 255, 255, 0.2);
  }
`;

const TextArea = styled.textarea`
  width: 100%;
  padding: 1rem 1.25rem;
  background: rgba(255, 255, 255, 0.05);
  border: 2px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  font-size: 1rem;
  color: #ffffff;
  min-height: 120px;
  resize: vertical;
  transition: all 0.3s ease;
  backdrop-filter: blur(10px);
  font-family: inherit;
  
  &::placeholder {
    color: rgba(255, 255, 255, 0.5);
  }
  
  &:focus {
    outline: none;
    border-color: rgba(59, 130, 246, 0.5);
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
    background: rgba(255, 255, 255, 0.08);
  }
  
  &:hover {
    border-color: rgba(255, 255, 255, 0.2);
  }
`;

const CheckboxGroup = styled.div`
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-bottom: 1.5rem;
  padding: 1rem;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.1);
`;

const Checkbox = styled.input`
  width: 20px;
  height: 20px;
  accent-color: #3b82f6;
  cursor: pointer;
`;

const Button = styled.button`
  width: 100%;
  padding: 1.25rem;
  background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
  color: white;
  border: none;
  border-radius: 12px;
  font-size: 1.1rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
  box-shadow: 0 4px 20px rgba(59, 130, 246, 0.4);
  
  &:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 30px rgba(59, 130, 246, 0.6);
  }
  
  &:disabled {
    background: rgba(255, 255, 255, 0.1);
    color: rgba(255, 255, 255, 0.5);
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
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.8);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 10px;
  cursor: pointer;
  margin-bottom: 2rem;
  font-weight: 500;
  transition: all 0.3s ease;
  backdrop-filter: blur(10px);
  
  &:hover {
    background: rgba(255, 255, 255, 0.15);
    border-color: rgba(255, 255, 255, 0.3);
    transform: translateY(-1px);
  }
`;

const HelpText = styled.p`
  font-size: 0.9rem;
  color: rgba(255, 255, 255, 0.6);
  margin-top: 0.5rem;
  line-height: 1.4;
`;

const ExampleText = styled.div`
  background: rgba(255, 255, 255, 0.03);
  padding: 1.5rem;
  border-radius: 12px;
  margin-top: 1rem;
  font-size: 0.9rem;
  color: rgba(255, 255, 255, 0.7);
  border: 1px solid rgba(255, 255, 255, 0.1);
  
  strong {
    color: rgba(255, 255, 255, 0.9);
    font-weight: 600;
  }
  
  code {
    background: rgba(59, 130, 246, 0.2);
    padding: 0.25rem 0.5rem;
    border-radius: 6px;
    font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
    font-size: 0.85rem;
    color: #93bbfd;
    border: 1px solid rgba(59, 130, 246, 0.3);
  }
`;

const FeatureCard = styled.div`
  background: rgba(255, 255, 255, 0.03);
  padding: 1.5rem;
  border-radius: 12px;
  margin-bottom: 2rem;
  border: 1px solid rgba(255, 255, 255, 0.1);
  
  h4 {
    color: #ffffff;
    margin-bottom: 0.5rem;
    font-weight: 600;
  }
  
  p {
    color: rgba(255, 255, 255, 0.7);
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