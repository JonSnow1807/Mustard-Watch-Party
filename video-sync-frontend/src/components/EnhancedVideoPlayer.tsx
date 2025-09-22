import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSocket } from '../contexts/SocketContext';
import { useAuth } from '../contexts/AuthContext';
import styled from '@emotion/styled';
import { toast } from 'react-hot-toast';

const PlayerContainer = styled.div`
  width: 100%;
  display: flex;
  flex-direction: column;
  border-radius: 16px;
  overflow: hidden;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
  background: linear-gradient(135deg, #0f2027 0%, #203a43 100%);
`;

const VideoWrapper = styled.div`
  position: relative;
  width: 100%;
  padding-bottom: 56.25%;
  background: #000;
  overflow: hidden;
`;

const PlayerDiv = styled.div`
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
`;

const LatencyBadge = styled.div<{ latency: number }>`
  position: absolute;
  top: 20px;
  right: 20px;
  background: ${props =>
    props.latency < 100 ? 'rgba(76, 175, 80, 0.9)' :
    props.latency < 300 ? 'rgba(255, 193, 7, 0.9)' :
    props.latency < 500 ? 'rgba(255, 152, 0, 0.9)' :
    'rgba(244, 67, 54, 0.9)'
  };
  color: white;
  padding: 8px 16px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 600;
  backdrop-filter: blur(10px);
  z-index: 100;
  display: flex;
  align-items: center;
  gap: 6px;
  animation: fadeIn 0.3s ease;

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(-10px); }
    to { opacity: 1; transform: translateY(0); }
  }
`;

const Controls = styled.div`
  background: linear-gradient(180deg, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.95) 100%);
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
`;

const ControlRow = styled.div`
  display: flex;
  align-items: center;
  gap: 16px;
`;

const PlayButton = styled.button<{ canControl: boolean }>`
  background: ${props => props.canControl
    ? 'linear-gradient(135deg, #10b981 0%, #14b8a6 100%)'
    : 'rgba(108, 117, 125, 0.5)'};
  border: none;
  color: white;
  padding: 12px 24px;
  border-radius: 12px;
  cursor: ${props => props.canControl ? 'pointer' : 'not-allowed'};
  font-weight: 600;
  font-size: 15px;
  display: flex;
  align-items: center;
  gap: 8px;
  transition: all 0.3s ease;
  box-shadow: ${props => props.canControl
    ? '0 4px 15px rgba(16, 185, 129, 0.4)'
    : 'none'};

  &:hover {
    transform: ${props => props.canControl ? 'translateY(-2px)' : 'none'};
    box-shadow: ${props => props.canControl
      ? '0 6px 20px rgba(16, 185, 129, 0.6)'
      : 'none'};
  }

  &:active {
    transform: ${props => props.canControl ? 'translateY(0)' : 'none'};
  }
`;

const ProgressContainer = styled.div`
  flex: 1;
  position: relative;
  height: 40px;
  display: flex;
  align-items: center;
`;

const ProgressBar = styled.div<{ canControl: boolean }>`
  width: 100%;
  height: 6px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 3px;
  cursor: ${props => props.canControl ? 'pointer' : 'default'};
  position: relative;
  overflow: hidden;
  transition: height 0.2s ease;

  &:hover {
    height: ${props => props.canControl ? '10px' : '6px'};
  }
`;

const ProgressFill = styled.div<{ progress: number }>`
  height: 100%;
  background: linear-gradient(90deg, #10b981 0%, #14b8a6 100%);
  border-radius: 3px;
  width: ${props => props.progress}%;
  position: relative;
  transition: width 0.1s linear;

  &::after {
    content: '';
    position: absolute;
    right: 0;
    top: 50%;
    transform: translateY(-50%);
    width: 14px;
    height: 14px;
    background: white;
    border-radius: 50%;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    opacity: 0;
    transition: opacity 0.2s;
  }

  ${ProgressBar}:hover &::after {
    opacity: 1;
  }
`;

const TimeDisplay = styled.div`
  color: rgba(255, 255, 255, 0.9);
  font-size: 14px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  min-width: 100px;
  text-align: right;
`;

const StatusRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 0;
  border-top: 1px solid rgba(255, 255, 255, 0.05);
`;

const StatusGroup = styled.div`
  display: flex;
  align-items: center;
  gap: 16px;
`;

const StatusItem = styled.div<{ type?: 'success' | 'warning' | 'error' | 'info' }>`
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: ${props => {
    switch(props.type) {
      case 'success': return '#4CAF50';
      case 'warning': return '#FFC107';
      case 'error': return '#F44336';
      case 'info': return '#2196F3';
      default: return 'rgba(255, 255, 255, 0.7)';
    }
  }};
`;

const StatusDot = styled.div<{ color: string }>`
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: ${props => props.color};
  animation: pulse 2s ease-in-out infinite;

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
`;

const ControlButton = styled.button<{ active?: boolean; variant?: 'primary' | 'secondary' }>`
  background: ${props =>
    props.variant === 'primary'
      ? 'linear-gradient(135deg, #10b981 0%, #14b8a6 100%)'
      : props.active
        ? 'rgba(16, 185, 129, 0.2)'
        : 'rgba(255, 255, 255, 0.05)'
  };
  border: 1px solid ${props =>
    props.active ? 'rgba(16, 185, 129, 0.5)' : 'rgba(255, 255, 255, 0.1)'
  };
  color: white;
  padding: 8px 16px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  gap: 6px;

  &:hover {
    background: ${props =>
      props.variant === 'primary'
        ? 'linear-gradient(135deg, #7788ee 0%, #8659b2 100%)'
        : props.active
          ? 'rgba(102, 126, 234, 0.3)'
          : 'rgba(255, 255, 255, 0.1)'
    };
    transform: translateY(-1px);
  }
`;

const CollaborativeIndicator = styled.div<{ enabled: boolean }>`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: ${props => props.enabled
    ? 'rgba(76, 175, 80, 0.1)'
    : 'rgba(255, 255, 255, 0.05)'
  };
  border: 1px solid ${props => props.enabled
    ? 'rgba(76, 175, 80, 0.3)'
    : 'rgba(255, 255, 255, 0.1)'
  };
  border-radius: 8px;
  font-size: 12px;
  color: ${props => props.enabled ? '#4CAF50' : 'rgba(255, 255, 255, 0.5)'};
  font-weight: 500;
`;

interface VideoPlayerProps {
  videoUrl: string;
  roomCode: string;
  isHost?: boolean;
  allowGuestControl?: boolean;
}

export const EnhancedVideoPlayer: React.FC<VideoPlayerProps> = ({
  videoUrl,
  roomCode,
  isHost = false,
  allowGuestControl = false
}) => {
  const { socket, connected } = useSocket();
  const { user } = useAuth();
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const [videoId, setVideoId] = useState<string | null>(null);
  const [syncEnabled, setSyncEnabled] = useState(true);
  const [latency, setLatency] = useState(0);
  const [showLatency, setShowLatency] = useState(false);

  const playerRef = useRef<any>(null);
  const canControl = isHost || allowGuestControl;

  // Extract YouTube video ID
  const getYouTubeId = useCallback((url: string): string | null => {
    if (!url) return null;

    const patterns = [
      /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/,
      /(?:https?:\/\/)?(?:www\.)?youtu\.be\/([a-zA-Z0-9_-]{11})/,
      /(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
      /^([a-zA-Z0-9_-]{11})$/
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match?.[1]) return match[1];
    }

    return null;
  }, []);

  // Load YouTube IFrame API
  useEffect(() => {
    const id = getYouTubeId(videoUrl);
    setVideoId(id);

    if (!id) return;

    if (window.YT?.Player) {
      initializePlayer(id);
      return;
    }

    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);

    window.onYouTubeIframeAPIReady = () => initializePlayer(id);

    return () => {
      playerRef.current?.destroy?.();
    };
  }, [videoUrl]);

  const initializePlayer = (videoId: string) => {
    new window.YT.Player('youtube-player', {
      height: '100%',
      width: '100%',
      videoId,
      playerVars: {
        autoplay: 0,
        controls: 0,
        disablekb: 1,
        modestbranding: 1,
        rel: 0,
        showinfo: 0,
        iv_load_policy: 3,
        enablejsapi: 1,
        origin: window.location.origin,
        playsinline: 1
      },
      events: {
        onReady: (event: any) => {
          playerRef.current = event.target;
          setIsReady(true);
          setDuration(event.target.getDuration());
        },
        onStateChange: (event: any) => {
          if (event.data === window.YT.PlayerState.PLAYING) {
            setIsPlaying(true);
            if (canControl) {
              broadcastState('play');
            }
          } else if (event.data === window.YT.PlayerState.PAUSED) {
            setIsPlaying(false);
            if (canControl) {
              broadcastState('pause');
            }
          }
        }
      }
    });
  };

  const broadcastState = useCallback((action: string) => {
    if (!socket || !connected || !canControl) return;

    const state = {
      currentTime: playerRef.current?.getCurrentTime() || 0,
      isPlaying: action === 'play',
      clientTimestamp: Date.now()
    };

    socket.emit('video-state', {
      roomCode,
      state,
      action,
      clientTimestamp: Date.now()
    });
  }, [socket, connected, canControl, roomCode]);

  // Socket event listeners
  useEffect(() => {
    if (!socket) return;

    const handleRoomJoined = (data: any) => {
      if (data.latency) {
        setLatency(data.latency);
        setShowLatency(true);
        setTimeout(() => setShowLatency(false), 3000);
      }

      if (data.state && playerRef.current) {
        const { currentTime, isPlaying } = data.state;
        playerRef.current.seekTo(currentTime, true);
        if (isPlaying) {
          playerRef.current.playVideo();
        } else {
          playerRef.current.pauseVideo();
        }
      }
    };

    const handleVideoStateUpdate = (data: any) => {
      if (!syncEnabled || !playerRef.current) return;

      if (data.latency) {
        setLatency(data.latency);
        setShowLatency(true);
        setTimeout(() => setShowLatency(false), 3000);
      }

      const { currentTime, isPlaying, action } = data;

      if (action === 'seek') {
        playerRef.current.seekTo(currentTime, true);
      }

      if (isPlaying && playerRef.current.getPlayerState() !== window.YT.PlayerState.PLAYING) {
        playerRef.current.playVideo();
      } else if (!isPlaying && playerRef.current.getPlayerState() === window.YT.PlayerState.PLAYING) {
        playerRef.current.pauseVideo();
      }
    };

    const handleError = (data: { message: string }) => {
      if (data.message.includes('Only the host')) {
        toast.error(data.message, {
          icon: '🔒',
          duration: 3000
        });
      }
    };

    socket.on('room-joined', handleRoomJoined);
    socket.on('video-state-update', handleVideoStateUpdate);
    socket.on('error', handleError);

    return () => {
      socket.off('room-joined', handleRoomJoined);
      socket.off('video-state-update', handleVideoStateUpdate);
      socket.off('error', handleError);
    };
  }, [socket, syncEnabled]);

  // Update current time
  useEffect(() => {
    if (!playerRef.current || !isReady) return;

    const interval = setInterval(() => {
      if (playerRef.current?.getCurrentTime) {
        setCurrentTime(playerRef.current.getCurrentTime());
      }
    }, 100);

    return () => clearInterval(interval);
  }, [isReady]);

  const handlePlayPause = () => {
    if (!playerRef.current || !canControl) {
      if (!canControl) {
        toast.error('Only the host can control video playback', {
          icon: '👑',
          duration: 2000
        });
      }
      return;
    }

    if (isPlaying) {
      playerRef.current.pauseVideo();
    } else {
      playerRef.current.playVideo();
    }
  };

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!playerRef.current || !duration || !canControl) {
      if (!canControl) {
        toast.error('Only the host can seek the video', {
          icon: '👑',
          duration: 2000
        });
      }
      return;
    }

    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const clickedTime = (x / rect.width) * duration;

    playerRef.current.seekTo(clickedTime, true);
    broadcastState('seek');
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  if (!videoId) {
    return (
      <PlayerContainer>
        <div style={{ padding: '60px', textAlign: 'center', color: 'white' }}>
          <h3>No Video Selected</h3>
          <p style={{ color: 'rgba(255, 255, 255, 0.6)' }}>
            Please provide a valid YouTube URL
          </p>
        </div>
      </PlayerContainer>
    );
  }

  return (
    <PlayerContainer>
      <VideoWrapper>
        <PlayerDiv id="youtube-player" />
        {showLatency && (
          <LatencyBadge latency={latency}>
            <span>⚡</span>
            <span>{latency}ms</span>
          </LatencyBadge>
        )}
      </VideoWrapper>

      <Controls>
        <ControlRow>
          <PlayButton
            onClick={handlePlayPause}
            canControl={canControl}
            disabled={!isReady}
          >
            {isPlaying ? '⏸' : '▶'}
            {isPlaying ? 'Pause' : 'Play'}
          </PlayButton>

          <ProgressContainer>
            <ProgressBar
              onClick={handleProgressClick}
              canControl={canControl}
            >
              <ProgressFill progress={duration > 0 ? (currentTime / duration) * 100 : 0} />
            </ProgressBar>
          </ProgressContainer>

          <TimeDisplay>
            {formatTime(currentTime)} / {formatTime(duration)}
          </TimeDisplay>
        </ControlRow>

        <StatusRow>
          <StatusGroup>
            <StatusItem type={connected ? 'success' : 'error'}>
              <StatusDot color={connected ? '#4CAF50' : '#F44336'} />
              {connected ? 'Connected' : 'Disconnected'}
            </StatusItem>

            <CollaborativeIndicator enabled={allowGuestControl}>
              {allowGuestControl ? '👥 Collaborative' : '👑 Host Only'}
            </CollaborativeIndicator>
          </StatusGroup>

          <StatusGroup>
            <ControlButton
              active={syncEnabled}
              onClick={() => setSyncEnabled(!syncEnabled)}
            >
              🔗 Sync {syncEnabled ? 'ON' : 'OFF'}
            </ControlButton>

            {isHost && (
              <ControlButton
                variant="primary"
                onClick={() => broadcastState('force-sync')}
              >
                ⚡ Force Sync
              </ControlButton>
            )}
          </StatusGroup>
        </StatusRow>
      </Controls>
    </PlayerContainer>
  );
};