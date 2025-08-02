import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { apiService } from '../services/api';
import { toast } from 'react-hot-toast';
import styled from '@emotion/styled';

const Container = styled.div`
  max-width: 600px;
  margin: 0 auto;
  padding: 2rem;
`;

const Header = styled.header`
  text-align: center;
  margin-bottom: 2rem;
`;

const Title = styled.h1`
  color: #333;
  font-size: 2.5rem;
  margin-bottom: 0.5rem;
`;

const Subtitle = styled.p`
  color: #666;
  font-size: 1.1rem;
`;

const Form = styled.form`
  background: white;
  border-radius: 12px;
  padding: 2rem;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
`;

const FormGroup = styled.div`
  margin-bottom: 1.5rem;
`;

const Label = styled.label`
  display: block;
  margin-bottom: 0.5rem;
  font-weight: 600;
  color: #333;
`;

const Input = styled.input`
  width: 100%;
  padding: 0.75rem;
  border: 2px solid #e1e5e9;
  border-radius: 8px;
  font-size: 1rem;
  transition: border-color 0.2s;
  
  &:focus {
    outline: none;
    border-color: #007bff;
  }
`;

const TextArea = styled.textarea`
  width: 100%;
  padding: 0.75rem;
  border: 2px solid #e1e5e9;
  border-radius: 8px;
  font-size: 1rem;
  min-height: 100px;
  resize: vertical;
  transition: border-color 0.2s;
  
  &:focus {
    outline: none;
    border-color: #007bff;
  }
`;

const CheckboxGroup = styled.div`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 1rem;
`;

const Checkbox = styled.input`
  width: 18px;
  height: 18px;
  accent-color: #007bff;
`;

const Button = styled.button`
  width: 100%;
  padding: 1rem;
  background: #007bff;
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 1.1rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  
  &:hover {
    background: #0056b3;
  }
  
  &:disabled {
    background: #ccc;
    cursor: not-allowed;
  }
`;

const BackButton = styled.button`
  padding: 0.5rem 1rem;
  background: #6c757d;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  margin-bottom: 1rem;
  
  &:hover {
    background: #5a6268;
  }
`;

const HelpText = styled.p`
  font-size: 0.9rem;
  color: #666;
  margin-top: 0.25rem;
`;

const ExampleText = styled.div`
  background: #f8f9fa;
  padding: 1rem;
  border-radius: 8px;
  margin-top: 0.5rem;
  font-size: 0.9rem;
  color: #666;
  
  code {
    background: #e9ecef;
    padding: 0.2rem 0.4rem;
    border-radius: 4px;
    font-family: monospace;
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
      });
      
      toast.success('Room created successfully!');
      navigate(`/room/${response.data.code}`);
    } catch (error: any) {
      toast.error(error.response?.data?.message || 'Failed to create room');
    } finally {
      setLoading(false);
    }
  };

  if (!user) {
    return (
      <Container>
        <Header>
          <Title>Create Room</Title>
          <Subtitle>Please login to create a room</Subtitle>
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
        <Title>🎬 Create New Room</Title>
        <Subtitle>Set up a watch party for you and your friends</Subtitle>
      </Header>

      <Form onSubmit={handleSubmit}>
        <FormGroup>
          <Label htmlFor="name">Room Name *</Label>
          <Input
            id="name"
            name="name"
            type="text"
            placeholder="Enter room name (e.g., Movie Night with Friends)"
            value={formData.name}
            onChange={handleInputChange}
            required
          />
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
            You can add a video URL now or later in the room settings
          </HelpText>
          <ExampleText>
            <strong>Supported formats:</strong><br />
            • <code>https://youtube.com/watch?v=VIDEO_ID</code><br />
            • <code>https://youtu.be/VIDEO_ID</code><br />
            • <code>https://vimeo.com/VIDEO_ID</code>
          </ExampleText>
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
            <Label htmlFor="isPublic" style={{ margin: 0, cursor: 'pointer' }}>
              Make this room public (anyone can discover and join)
            </Label>
          </CheckboxGroup>
          <HelpText>
            Public rooms appear in the public rooms list and can be joined by anyone
          </HelpText>
        </FormGroup>

        {formData.isPublic && (
          <>
            <FormGroup>
              <Label htmlFor="description">Room Description</Label>
              <TextArea
                id="description"
                name="description"
                placeholder="Describe what you'll be watching or the theme of your room..."
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
                Add tags to help others discover your room (comma separated)
              </HelpText>
            </FormGroup>
          </>
        )}

        <Button type="submit" disabled={loading}>
          {loading ? 'Creating Room...' : 'Create Room'}
        </Button>
      </Form>
    </Container>
  );
}; 