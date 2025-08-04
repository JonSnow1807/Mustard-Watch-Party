import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSocket } from '../contexts/SocketContext';
import { useAuth } from '../contexts/AuthContext';
import styled from '@emotion/styled';

const PlayerContainer = styled.div`
  width: 100%;
  display: flex;
  flex-direction: column;
`;

const VideoWrapper = styled.div`
  position: relative;
  width: 100%;
  padding-bottom: 56.25%; /* 16:9 aspect ratio */
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

const Controls = styled.div`
  background: rgba(0, 0, 0, 0.9);
  padding: 12px 20px;
  display: flex;
  align-items: center;
  gap: 15px;
  color: white;
  font-size: 14px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
`;

const StatusBar = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
`;

const StatusDot = styled.div<{ connected: boolean }>`
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: ${props => props.connected ? '#4CAF50' : '#f44336'};
`;

const PlayButton = styled.button`
  background: #007bff;
  border: none;
  color: white;
  padding: 8px 16px;
  border-radius: 4px;
  cursor: pointer;
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 5px;
  transition: all 0.2s;
  
  &:hover {
    background: #0056b3;
  }
  
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

const SyncButton = styled.button<{ active?: boolean }>`
  background: ${props => props.active ? '#28a745' : '#6c757d'};
  border: none;
  color: white;
  padding: 6px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  transition: all 0.2s;
  
  &:hover {
    opacity: 0.8;
  }
`;

const TimeDisplay = styled.div`
  margin-left: auto;
  font-size: 13px;
  color: #ccc;
`;

const ProgressBar = styled.div`
  flex: 1;
  height: 4px;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 2px;
  cursor: pointer;
  position: relative;
  margin: 0 15px;
`;

const ProgressFill = styled.div<{ progress: number }>`
  height: 100%;
  background: #007bff;
  border-radius: 2px;
  width: ${props => props.progress}%;
  transition: width 0.1s;
`;

const SyncIndicator = styled.div<{ status: 'synced' | 'syncing' | 'buffering' | 'off' }>`
  font-size: 11px;
  color: ${props => {
    switch(props.status) {
      case 'syncing': return '#ffc107';
      case 'buffering': return '#ff9800';
      case 'off': return '#6c757d';
      default: return '#28a745';
    }
  }};
  margin-left: 10px;
  display: flex;
  align-items: center;
  gap: 4px;
`;

const Message = styled.div`
  padding: 40px;
  text-align: center;
  color: white;
  background: #000;
  aspect-ratio: 16 / 9;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  
  h3 {
    margin-bottom: 10px;
  }
  
  p {
    color: #999;
    margin: 5px 0;
  }
  
  code {
    background: rgba(255, 255, 255, 0.1);
    padding: 2px 6px;
    border-radius: 3px;
    font-family: monospace;
    font-size: 12px;
  }
`;

const ErrorMessage = styled.div`
  position: absolute;
  top: 10px;
  right: 10px;
  background: #f44336;
  color: white;
  padding: 8px 12px;
  border-radius: 4px;
  font-size: 12px;
  z-index: 1000;
  animation: fadeIn 0.3s ease-in;
  
  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: translateY(-10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
`;

interface VideoPlayerProps {
  videoUrl: string;
  roomCode: string;
  isHost?: boolean;
}

interface VideoSyncState {
  currentTime: number;
  isPlaying: boolean;
  timestamp: number;
  userId?: string;
  playbackRate?: number;
}

declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady: () => void;
  }
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({ videoUrl, roomCode, isHost = false }) => {
  const { socket, connected } = useSocket();
  const { user } = useAuth();
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const [videoId, setVideoId] = useState<string | null>(null);
  const [syncEnabled, setSyncEnabled] = useState(true);
  const [syncStatus, setSyncStatus] = useState<'synced' | 'syncing' | 'buffering' | 'off'>('synced');
  const [controlError, setControlError] = useState<string | null>(null);
  
  const playerRef = useRef<any>(null);
  const isProcessingRemoteUpdate = useRef(false);
  const pendingAction = useRef<any>(null);
  const lastActionTime = useRef(0);
  const syncDebounceTimer = useRef<NodeJS.Timeout | null>(null);
  const bufferingTimer = useRef<NodeJS.Timeout | null>(null);
  const lastBroadcastState = useRef<VideoSyncState | null>(null);

  // Extract YouTube video ID
  const getYouTubeId = useCallback((url: string): string | null => {
    if (!url) return null;
    
    url = url.trim();
    
    const patterns = [
      /(?:https?:\/\/)?(?:www\.)?youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/,
      /(?:https?:\/\/)?(?:www\.)?youtu\.be\/([a-zA-Z0-9_-]{11})/,
      /(?:https?:\/\/)?(?:www\.)?youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
      /^([a-zA-Z0-9_-]{11})$/ // Just the video ID
    ];
    
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }
    
    return null;
  }, []);

  // Load YouTube IFrame API
  useEffect(() => {
    const id = getYouTubeId(videoUrl);
    setVideoId(id);

    if (!id) return;

    // Check if API is already loaded
    if (window.YT && window.YT.Player) {
      initializePlayer(id);
      return;
    }

    // Load the IFrame Player API code asynchronously
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    const firstScriptTag = document.getElementsByTagName('script')[0];
    firstScriptTag.parentNode?.insertBefore(tag, firstScriptTag);

    // Create YouTube player after API loads
    window.onYouTubeIframeAPIReady = () => {
      initializePlayer(id);
    };

    return () => {
      if (playerRef.current && playerRef.current.destroy) {
        playerRef.current.destroy();
      }
      if (syncDebounceTimer.current) {
        clearTimeout(syncDebounceTimer.current);
      }
      if (bufferingTimer.current) {
        clearTimeout(bufferingTimer.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoUrl]);

  const initializePlayer = (videoId: string) => {
    new window.YT.Player('youtube-player', {
      height: '100%',
      width: '100%',
      videoId: videoId,
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
          console.log('Player ready');
          playerRef.current = event.target;
          setIsReady(true);
          setDuration(event.target.getDuration());
        },
        onStateChange: (event: any) => {
          // Skip if we're processing a remote update
          if (isProcessingRemoteUpdate.current) return;
          
          const time = event.target.getCurrentTime();
          
          switch(event.data) {
            case window.YT.PlayerState.PLAYING:
              setIsPlaying(true);
              setSyncStatus('synced');
              // Clear any pending pauses
              if (pendingAction.current?.type === 'pause') {
                pendingAction.current = null;
              }
              // Only broadcast if user is host
              if (isHost) {
                broadcastStateRef.current?.('play', time);
              }
              break;
              
            case window.YT.PlayerState.PAUSED:
              setIsPlaying(false);
              // Only broadcast if this isn't from a seek operation and user is host
              if (pendingAction.current?.type !== 'seek' && isHost) {
                broadcastStateRef.current?.('pause', time);
              }
              break;
              
            case window.YT.PlayerState.BUFFERING:
              setSyncStatus('buffering');
              // Set a timeout to check if still buffering
              if (bufferingTimer.current) clearTimeout(bufferingTimer.current);
              bufferingTimer.current = setTimeout(() => {
                if (playerRef.current && playerRef.current.getPlayerState() === window.YT.PlayerState.BUFFERING) {
                  broadcastStateRef.current?.('buffering', time);
                }
              }, 1000);
              break;
              
            case window.YT.PlayerState.ENDED:
              if (isHost) {
                broadcastStateRef.current?.('ended', time);
              }
              break;
          }
        }
      }
    });
  };

  // Debounced broadcast to prevent spam
  const broadcastState = useCallback((action: string, time?: number) => {
    if (!socket || !connected || !syncEnabled || !playerRef.current) return;
    
    // Only allow host to broadcast video state changes
    if (!isHost && (action === 'play' || action === 'pause' || action === 'seek')) {
      return;
    }
    
    // Prevent duplicate broadcasts
    const now = Date.now();
    if (now - lastActionTime.current < 200 && action !== 'force-sync') return;
    lastActionTime.current = now;
    
    const currentTime = time ?? playerRef.current.getCurrentTime();
    const state: VideoSyncState = {
      currentTime,
      isPlaying: action === 'play',
      timestamp: now,
      userId: user?.id,
      playbackRate: playerRef.current.getPlaybackRate ? playerRef.current.getPlaybackRate() : 1
    };
    
    // Don't broadcast if state hasn't changed
    if (lastBroadcastState.current && 
        Math.abs(lastBroadcastState.current.currentTime - state.currentTime) < 0.1 &&
        lastBroadcastState.current.isPlaying === state.isPlaying &&
        action !== 'force-sync') {
      return;
    }
    
    lastBroadcastState.current = state;
    
    socket.emit('video-state', {
      roomCode,
      state,
      action
    });
    
    console.log(`Broadcasting ${action} at ${currentTime.toFixed(1)}s`);
  }, [socket, connected, syncEnabled, roomCode, user, isHost]);

  // Store broadcast function in ref to avoid stale closures
  const broadcastStateRef = useRef<typeof broadcastState | null>(null);
  broadcastStateRef.current = broadcastState;

  // Smart sync that handles edge cases
  const applySync = useCallback((state: VideoSyncState, action?: string) => {
    if (!playerRef.current || !playerRef.current.getCurrentTime || state.userId === user?.id) return;
    
    isProcessingRemoteUpdate.current = true;
    setSyncStatus('syncing');
    
    // Clear any pending debounce
    if (syncDebounceTimer.current) {
      clearTimeout(syncDebounceTimer.current);
    }
    
    const applyUpdate = () => {
      const player = playerRef.current;
      if (!player) return;
      
      const currentPlayerTime = player.getCurrentTime();
      const targetTime = state.currentTime;
      const timeDiff = Math.abs(currentPlayerTime - targetTime);
      
      // Calculate network delay compensation
      const networkDelay = (Date.now() - state.timestamp) / 1000;
      const compensatedTime = state.isPlaying ? targetTime + networkDelay : targetTime;
      
      console.log(`Sync: action=${action}, diff=${timeDiff.toFixed(2)}s, delay=${networkDelay.toFixed(2)}s`);
      
      // Handle different sync scenarios
      switch(action) {
        case 'play':
          pendingAction.current = { type: 'play', time: compensatedTime };
          if (timeDiff > 0.3) {
            player.seekTo(compensatedTime, true);
          }
          player.playVideo();
          break;
          
        case 'pause':
          pendingAction.current = { type: 'pause', time: targetTime };
          player.pauseVideo();
          if (timeDiff > 0.3) {
            player.seekTo(targetTime, true);
          }
          break;
          
        case 'seek':
          pendingAction.current = { type: 'seek', time: targetTime };
          player.seekTo(targetTime, true);
          // Maintain play state after seek
          setTimeout(() => {
            if (state.isPlaying && player.getPlayerState() !== window.YT.PlayerState.PLAYING) {
              player.playVideo();
            }
            pendingAction.current = null;
          }, 300);
          break;
          
        case 'buffering':
          // Pause and wait for the buffering user
          if (state.isPlaying) {
            player.pauseVideo();
          }
          break;
          
        case 'sync':
        case 'force-sync':
          // For periodic sync, be less aggressive
          if (timeDiff > 1.5) {
            player.seekTo(compensatedTime, true);
          }
          if (state.isPlaying !== (player.getPlayerState() === window.YT.PlayerState.PLAYING)) {
            state.isPlaying ? player.playVideo() : player.pauseVideo();
          }
          break;
      }
      
      // Reset processing flag after a delay
      setTimeout(() => {
        isProcessingRemoteUpdate.current = false;
        setSyncStatus(syncEnabled ? 'synced' : 'off');
      }, 500);
    };
    
    // Debounce rapid updates
    syncDebounceTimer.current = setTimeout(applyUpdate, 50);
    
  }, [user, syncEnabled]);

  // Socket event listeners
  useEffect(() => {
    if (!socket) return;

    // Initial room state
    const handleRoomJoined = (data: any) => {
      if (data.state && playerRef.current) {
        console.log('Applying initial room state:', data.state);
        setTimeout(() => {
          applySync({
            currentTime: data.state.currentTime,
            isPlaying: data.state.isPlaying,
            timestamp: Date.now()
          }, 'initial');
        }, 500);
      }
    };

    // Video state updates from other users
    const handleVideoStateUpdate = (data: VideoSyncState & { action?: string }) => {
      if (!syncEnabled) return;
      applySync(data, data.action);
    };

    // Handle control permission errors
    const handleError = (data: { message: string }) => {
      if (data.message.includes('Only the host can control')) {
        setControlError(data.message);
        setTimeout(() => setControlError(null), 3000);
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
  }, [socket, syncEnabled, applySync, isHost]);

  // Update current time and periodic sync
  useEffect(() => {
    if (!playerRef.current || !isReady) return;

    const interval = setInterval(() => {
      if (playerRef.current && playerRef.current.getCurrentTime) {
        const time = playerRef.current.getCurrentTime();
        setCurrentTime(time);
        
        // Light periodic sync every 8 seconds when playing (host only)
        if (isPlaying && syncEnabled && !isProcessingRemoteUpdate.current && isHost) {
          const now = Date.now();
          if (now - lastActionTime.current > 8000) {
            broadcastState('sync', time);
          }
        }
      }
    }, 100);

    return () => clearInterval(interval);
  }, [isReady, isPlaying, syncEnabled, broadcastState]);

  const handlePlayPause = () => {
    if (!playerRef.current || isProcessingRemoteUpdate.current) return;
    
    // Only allow host to control video
    if (!isHost) {
      setControlError('Only the host can control video playback');
      setTimeout(() => setControlError(null), 3000);
      return;
    }
    
    if (isPlaying) {
      playerRef.current.pauseVideo();
    } else {
      playerRef.current.playVideo();
    }
  };

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!playerRef.current || !duration || isProcessingRemoteUpdate.current) return;

    // Only allow host to seek video
    if (!isHost) {
      setControlError('Only the host can control video playback');
      setTimeout(() => setControlError(null), 3000);
      return;
    }

    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const clickedTime = (x / rect.width) * duration;
    
    pendingAction.current = { type: 'seek', time: clickedTime };
    playerRef.current.seekTo(clickedTime, true);
    
    // Broadcast seek immediately
    setTimeout(() => {
      broadcastState('seek', clickedTime);
    }, 50);
  };

  const handleForceSync = () => {
    if (!playerRef.current || !isHost) return;
    const currentTime = playerRef.current.getCurrentTime();
    broadcastState('force-sync', currentTime);
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const getSyncStatusText = () => {
    switch(syncStatus) {
      case 'syncing': return '⟳ Syncing...';
      case 'buffering': return '⏳ Buffering...';
      case 'off': return '✗ Sync OFF';
      default: return '✓ In Sync';
    }
  };

  if (!videoId) {
    return (
      <PlayerContainer>
        <Message>
          <h3>No Video Selected</h3>
          <p>Please provide a valid YouTube URL in the room settings.</p>
          <p>Supported formats:</p>
          <p><code>https://youtube.com/watch?v=VIDEO_ID</code></p>
          <p><code>https://youtu.be/VIDEO_ID</code></p>
          <p>Current URL: <code>{videoUrl || 'None'}</code></p>
        </Message>
      </PlayerContainer>
    );
  }

  return (
    <PlayerContainer>
      <VideoWrapper>
        <PlayerDiv id="youtube-player" />
      </VideoWrapper>
      
      <Controls>
        <StatusBar>
          <StatusDot connected={connected} />
          <span>{connected ? 'Connected' : 'Disconnected'}</span>
          <SyncIndicator status={syncEnabled ? syncStatus : 'off'}>
            {getSyncStatusText()}
          </SyncIndicator>
          {!isHost && (
            <span style={{ color: '#ffc107', fontSize: '12px', marginLeft: '10px' }}>
              👑 Host Only Controls
            </span>
          )}
        </StatusBar>
        
        <PlayButton 
          onClick={handlePlayPause} 
          disabled={!isReady || isProcessingRemoteUpdate.current || !isHost}
          title={!isHost ? 'Only the host can control video playback' : undefined}
        >
          {isPlaying ? '⏸ Pause' : '▶ Play'}
        </PlayButton>
        
        <SyncButton active={syncEnabled} onClick={() => setSyncEnabled(!syncEnabled)}>
          {syncEnabled ? '🔗 Sync ON' : '🔗 Sync OFF'}
        </SyncButton>
        
        <SyncButton 
          onClick={handleForceSync} 
          title="Resync with room"
          disabled={!isHost}
        >
          ⚡ Resync
        </SyncButton>
        
        <ProgressBar 
          onClick={handleProgressClick}
          style={{ cursor: isHost ? 'pointer' : 'not-allowed' }}
          title={!isHost ? 'Only the host can control video playback' : 'Click to seek'}
        >
          <ProgressFill progress={duration > 0 ? (currentTime / duration) * 100 : 0} />
        </ProgressBar>
        
        <TimeDisplay>
          {formatTime(currentTime)} / {formatTime(duration)}
        </TimeDisplay>
      </Controls>
      
      {controlError && (
        <ErrorMessage>
          {controlError}
        </ErrorMessage>
      )}
    </PlayerContainer>
  );
};