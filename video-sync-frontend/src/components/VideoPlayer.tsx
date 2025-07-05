import React, { useState, useEffect, useRef } from 'react';
import { useSocket } from '../contexts/SocketContext';
import styled from '@emotion/styled';

const Container = styled.div`
  width: 100%;
`;

const VideoWrapper = styled.div`
  position: relative;
  padding-top: 56.25%; /* 16:9 Aspect Ratio */
  background: #000;
  border-radius: 8px;
  overflow: hidden;
  
  #youtube-player {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
  }
`;

const ControlsBar = styled.div`
  margin-top: 1rem;
  padding: 1rem;
  background: #f5f5f5;
  border-radius: 8px;
  display: flex;
  align-items: center;
  gap: 1rem;
`;

const Status = styled.div`
  font-size: 0.9rem;
  color: #666;
`;

const ProgressBar = styled.div`
  flex: 1;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  
  span {
    min-width: 80px;
  }
  
  input {
    flex: 1;
    height: 6px;
  }
`;

declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady: () => void;
  }
}

interface VideoPlayerProps {
  videoUrl: string;
  roomCode: string;
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({ videoUrl, roomCode }) => {
  const { socket } = useSocket();
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const playerRef = useRef<any>(null);
  const [playerReady, setPlayerReady] = useState(false);
  const isSyncingRef = useRef(false);
  const lastSeekTime = useRef(0);
  
  // Extract video ID from YouTube URL
  const getVideoId = (url: string) => {
    const match = url.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/);
    return match ? match[1] : null;
  };
  
  const videoId = getVideoId(videoUrl);
  
  // Load YouTube IFrame API
  useEffect(() => {
    if (!videoId) return;
    
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    const firstScriptTag = document.getElementsByTagName('script')[0];
    firstScriptTag.parentNode?.insertBefore(tag, firstScriptTag);
    
    window.onYouTubeIframeAPIReady = () => {
      playerRef.current = new window.YT.Player('youtube-player', {
        videoId: videoId,
        playerVars: {
          autoplay: 0,
          controls: 1,
          modestbranding: 1,
          rel: 0,
        },
        events: {
          onReady: () => {
            console.log('YouTube player ready');
            setPlayerReady(true);
            setDuration(playerRef.current.getDuration());
          },
          onStateChange: (event: any) => {
            if (isSyncingRef.current) return;
            
            // 1 = playing, 2 = paused, 3 = buffering
            if (event.data === 1) {
              console.log('Video playing locally');
              setIsPlaying(true);
              const time = playerRef.current.getCurrentTime();
              socket?.emit('video-state', {
                roomCode,
                state: { currentTime: time, isPlaying: true }
              });
            } else if (event.data === 2) {
              console.log('Video paused locally');
              setIsPlaying(false);
              const time = playerRef.current.getCurrentTime();
              socket?.emit('video-state', {
                roomCode,
                state: { currentTime: time, isPlaying: false }
              });
            }
          }
        }
      });
    };
    
    return () => {
      if (playerRef.current && playerRef.current.destroy) {
        playerRef.current.destroy();
      }
    };
  }, [videoId, roomCode, socket]);
  
  // Listen for sync events from other users
  useEffect(() => {
    if (!socket || !playerReady) return;
    
    // Handle initial room state when joining
    socket.on('room-joined', (data: any) => {
      if (data.state && playerRef.current) {
        console.log('Syncing to room state:', data.state);
        isSyncingRef.current = true;
        
        // Immediately sync to room state
        playerRef.current.seekTo(data.state.currentTime || 0, true);
        setCurrentTime(data.state.currentTime || 0);
        
        // Small delay before playing to ensure seek completes
        setTimeout(() => {
          if (data.state.isPlaying) {
            playerRef.current.playVideo();
            setIsPlaying(true);
          } else {
            playerRef.current.pauseVideo();
            setIsPlaying(false);
          }
          isSyncingRef.current = false;
        }, 100);
      }
    });
    
    // Handle state updates from other users
    socket.on('video-state-update', (state: any) => {
      if (playerRef.current && !isSyncingRef.current) {
        console.log('Received state update:', state);
        isSyncingRef.current = true;
        
        const currentPlayerTime = playerRef.current.getCurrentTime();
        const timeDiff = Math.abs(currentPlayerTime - state.currentTime);
        
        // More aggressive sync - only 0.5 second tolerance
        if (timeDiff > 0.5) {
          playerRef.current.seekTo(state.currentTime, true);
          setCurrentTime(state.currentTime);
        }
        
        if (state.isPlaying && playerRef.current.getPlayerState() !== 1) {
          playerRef.current.playVideo();
          setIsPlaying(true);
        } else if (!state.isPlaying && playerRef.current.getPlayerState() === 1) {
          playerRef.current.pauseVideo();
          setIsPlaying(false);
        }
        
        setTimeout(() => {
          isSyncingRef.current = false;
        }, 300);
      }
    });
    
    return () => {
      socket.off('room-joined');
      socket.off('video-state-update');
    };
  }, [socket, playerReady]);
  
  // Update current time periodically
  useEffect(() => {
    const interval = setInterval(() => {
      if (playerRef.current && playerReady && isPlaying) {
        const time = playerRef.current.getCurrentTime();
        setCurrentTime(time);
        
        // Detect manual seeks (big time jumps)
        const timeDiff = Math.abs(time - lastSeekTime.current);
        if (timeDiff > 2 && !isSyncingRef.current) {
          console.log('Detected seek:', time);
          socket?.emit('video-state', {
            roomCode,
            state: { currentTime: time, isPlaying }
          });
        }
        lastSeekTime.current = time;
      }
    }, 500); // Check every 500ms for better responsiveness
    
    return () => clearInterval(interval);
  }, [isPlaying, playerReady, roomCode, socket]);
  
  const formatTime = (seconds: number) => {
    if (isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };
  
  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    if (playerRef.current && !isSyncingRef.current) {
      playerRef.current.seekTo(time, true);
      setCurrentTime(time);
      socket?.emit('video-state', {
        roomCode,
        state: { currentTime: time, isPlaying }
      });
    }
  };
  
  if (!videoId) {
    return (
      <Container>
        <VideoWrapper>
          <div style={{ 
            position: 'absolute', 
            top: '50%', 
            left: '50%', 
            transform: 'translate(-50%, -50%)',
            color: 'white',
            textAlign: 'center'
          }}>
            <h3>Invalid YouTube URL</h3>
            <p>Please use a valid YouTube video URL</p>
          </div>
        </VideoWrapper>
      </Container>
    );
  }
  
  return (
    <Container>
      <VideoWrapper>
        <div id="youtube-player" />
      </VideoWrapper>
      
      <ControlsBar>
        <Status>
          {playerReady ? '🟢 Connected' : '🔴 Loading...'} | 
          {isPlaying ? '▶️ Playing' : '⏸️ Paused'}
        </Status>
        
        <ProgressBar>
          <span>{formatTime(currentTime)}</span>
          <input
            type="range"
            min={0}
            max={duration || 100}
            value={currentTime}
            onChange={handleSeek}
            style={{ cursor: 'pointer' }}
          />
          <span>{formatTime(duration)}</span>
        </ProgressBar>
      </ControlsBar>
    </Container>
  );
};