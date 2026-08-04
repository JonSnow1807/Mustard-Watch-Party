import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSocket } from '../contexts/SocketContext';
import styled from '@emotion/styled';
import { toast } from 'react-hot-toast';
import {
  SyncEngine,
  type EngineAdapter,
  type EngineStatus,
} from '../sync/SyncEngine';
import { YouTubeAdapter } from '../sync/YouTubeAdapter';
import { Html5Adapter } from '../sync/Html5Adapter';
import { AudioTruthProbe } from '../sync/audio-truth';
import { SYNC_EVENTS } from '../shared/sync-protocol';
import { SyncHud } from './SyncHud';

const PlayerContainer = styled.div`
  width: 100%;
  display: flex;
  flex-direction: column;
  border-radius: 16px;
  overflow: hidden;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
  background: #ffffff;
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

const GestureChip = styled.button`
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 105;
  background: rgba(15, 23, 42, 0.9);
  color: white;
  border: none;
  padding: 14px 28px;
  border-radius: 24px;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;

  &:hover {
    background: rgba(15, 23, 42, 1);
  }
`;

const Controls = styled.div`
  background: #ffffff;
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  border-top: 1px solid #e2e8f0;
`;

const ControlRow = styled.div`
  display: flex;
  align-items: center;
  gap: 16px;
`;

const PlayButton = styled.button<{ canControl: boolean }>`
  background: ${props => props.canControl
    ? '#6366f1'
    : '#a0aec0'};
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
    ? '0 1px 3px rgba(0, 0, 0, 0.05)'
    : 'none'};

  &:hover {
    transform: ${props => props.canControl ? 'translateY(-1px)' : 'none'};
    background: ${props => props.canControl ? '#5558e3' : '#a0aec0'};
    box-shadow: ${props => props.canControl
      ? '0 4px 6px rgba(0, 0, 0, 0.07)'
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
  background: #e2e8f0;
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
  background: #6366f1;
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
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
    opacity: 0;
    transition: opacity 0.2s;
  }

  ${ProgressBar}:hover &::after {
    opacity: 1;
  }
`;

const TimeDisplay = styled.div`
  color: #4a5568;
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
  border-top: 1px solid #e2e8f0;
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
      case 'success': return '#10b981';
      case 'warning': return '#f59e0b';
      case 'error': return '#f87171';
      case 'info': return '#6366f1';
      default: return '#718096';
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

const ControlButton = styled.button<{ active?: boolean }>`
  background: ${props => props.active ? 'rgba(99, 102, 241, 0.1)' : '#ffffff'};
  border: 1px solid ${props =>
    props.active ? 'rgba(99, 102, 241, 0.3)' : '#e2e8f0'
  };
  color: #2d3748;
  padding: 8px 16px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  gap: 6px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);

  &:hover {
    background: ${props =>
      props.active ? 'rgba(99, 102, 241, 0.15)' : '#f8fafc'};
    transform: translateY(-1px);
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.07);
  }
`;

const CollaborativeIndicator = styled.div<{ enabled: boolean }>`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: ${props => props.enabled
    ? 'rgba(16, 185, 129, 0.1)'
    : '#ffffff'
  };
  border: 1px solid ${props => props.enabled
    ? 'rgba(16, 185, 129, 0.3)'
    : '#e2e8f0'
  };
  border-radius: 8px;
  font-size: 12px;
  color: ${props => props.enabled ? '#10b981' : '#a0aec0'};
  font-weight: 500;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
`;

interface VideoPlayerProps {
  videoUrl: string;
  roomCode: string;
  isHost?: boolean;
  allowGuestControl?: boolean;
}

const EMPTY_STATUS: EngineStatus = {
  timeline: null,
  roomPlaying: false,
  projectedS: 0,
  durationS: 0,
  driftMs: 0,
  offsetMs: 0,
  uncertaintyMs: Infinity,
  rttMs: NaN,
  ctrlState: 'LOCKED',
  seq: -1,
  fractionalRateOK: false,
  needsGesture: false,
  seeksIssued: 0,
};

export const EnhancedVideoPlayer: React.FC<VideoPlayerProps> = ({
  videoUrl,
  roomCode,
  isHost = false,
  allowGuestControl = false
}) => {
  const { socket, connected } = useSocket();
  const [videoId, setVideoId] = useState<string | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [syncEnabled, setSyncEnabled] = useState(true);
  const syncEnabledRef = useRef(true);
  const [status, setStatus] = useState<EngineStatus>(EMPTY_STATUS);
  const [showHud, setShowHud] = useState(
    () => new URLSearchParams(window.location.search).get('debug') === '1',
  );

  const playerRef = useRef<YTPlayer | null>(null);
  const engineRef = useRef<SyncEngine | null>(null);
  const adapterRef = useRef<EngineAdapter | null>(null);
  const mediaRef = useRef<HTMLVideoElement | null>(null);
  const probeRef = useRef<AudioTruthProbe | null>(null);
  // a same-origin media file drives the HTML5 path: the sync core is
  // player-agnostic, and only a same-origin element can be audio-tapped
  const isDirectMedia = /^\/?media\/.+\.(mp4|webm|ogg)$/i.test(videoUrl ?? '');
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

  // Engine lifecycle: starts with the socket (before the player is ready, so
  // no room-joined timeline is ever missed) and adopts the adapter later.
  useEffect(() => {
    if (!socket) return;
    const engine = new SyncEngine(socket, roomCode);
    engineRef.current = engine;
    engine.start();
    // the player may already be ready (socket reconnect / room change with a
    // live player): adopt the existing adapter or the new engine would never
    // get one and every control would dead-end
    if (adapterRef.current) engine.attachAdapter(adapterRef.current);
    engine.setEnabled(syncEnabledRef.current);
    const unsubscribe = engine.onStatus(setStatus);

    const onRejected = (r: { reason: string }) => {
      if (r.reason === 'not-controller') {
        toast.error('Only the host can control video playback', {
          icon: '👑',
          duration: 2000,
        });
      }
    };
    socket.on(SYNC_EVENTS.controlRejected, onRejected);

    return () => {
      socket.off(SYNC_EVENTS.controlRejected, onRejected);
      unsubscribe();
      engine.dispose();
      engineRef.current = null;
      // adapterRef is owned by the player effect below - clearing it here
      // orphaned a live adapter (and its poll timer) on every reconnect
    };
  }, [socket, roomCode]);

  // HUD toggle on backtick
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '`') setShowHud((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // HTML5 bootstrap (audio-truth + player-agnostic proof)
  useEffect(() => {
    if (!isDirectMedia) return;
    const el = mediaRef.current;
    if (!el) return;
    const adapter = new Html5Adapter(el);
    adapterRef.current = adapter;
    engineRef.current?.attachAdapter(adapter);
    setIsReady(true);
    const probe = new AudioTruthProbe(el);
    probeRef.current = probe;
    void probe.start();
    return () => {
      probe.stop();
      probeRef.current = null;
      adapterRef.current = null;
      setIsReady(false);
    };
  }, [isDirectMedia, videoUrl]);

  // Player bootstrap
  useEffect(() => {
    if (isDirectMedia) return;
    const id = getYouTubeId(videoUrl);
    setVideoId(id);
    if (!id) return;

    let cancelled = false;
    const initializePlayer = (vid: string) => {
      if (cancelled) return;
      playerRef.current = new window.YT.Player('youtube-player', {
        videoId: vid,
        playerVars: {
          autoplay: 0,
          controls: 0,
          disablekb: 1,
          modestbranding: 1,
          rel: 0,
          iv_load_policy: 3,
          enablejsapi: 1,
          origin: window.location.origin,
          playsinline: 1,
        },
        events: {
          onReady: (event) => {
            playerRef.current = event.target;
            setIsReady(true);
            const adapter = new YouTubeAdapter(event.target);
            adapterRef.current = adapter;
            engineRef.current?.attachAdapter(adapter);
          },
        },
      });
    };

    const API_SRC = 'https://www.youtube.com/iframe_api';
    const onApiReady = () => initializePlayer(id);
    if (window.YT?.Player) {
      initializePlayer(id);
    } else {
      // the API script is global: appending it twice re-runs it and races
      if (!document.querySelector(`script[src="${API_SRC}"]`)) {
        const tag = document.createElement('script');
        tag.src = API_SRC;
        document.head.appendChild(tag);
      }
      window.onYouTubeIframeAPIReady = onApiReady;
    }

    return () => {
      // a late API load would otherwise build an orphan player (and an
      // undisposed adapter poll timer) after this effect is gone
      cancelled = true;
      if (window.onYouTubeIframeAPIReady === onApiReady) {
        window.onYouTubeIframeAPIReady = undefined;
      }
      adapterRef.current?.dispose();
      adapterRef.current = null;
      playerRef.current?.destroy?.();
      setIsReady(false);
    };
    // intentional: the player re-initializes only when the video changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoUrl]);

  // ---- gesture-only intents (wait-for-broadcast: the player is never
  // touched here; everyone converges from the sync:timeline broadcast) ----
  const handlePlayPause = () => {
    if (!canControl) {
      toast.error('Only the host can control video playback', {
        icon: '👑',
        duration: 2000
      });
      return;
    }
    const engine = engineRef.current;
    const adapter = adapterRef.current;
    if (!engine || !adapter) return;
    if (status.roomPlaying) {
      // P4: pause freezes at the frame the presser saw
      engine.sendIntent('pause', adapter.getPlayerTime());
    } else {
      const from = status.timeline ? status.projectedS : adapter.getPlayerTime();
      engine.sendIntent('play', from);
    }
  };

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!canControl) {
      toast.error('Only the host can seek the video', {
        icon: '👑',
        duration: 2000
      });
      return;
    }
    const engine = engineRef.current;
    if (!engine || !status.durationS) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const fraction = (e.clientX - rect.left) / rect.width;
    engine.sendIntent('seek', fraction * status.durationS);
  };

  const handleSyncToggle = () => {
    const next = !syncEnabled;
    setSyncEnabled(next);
    syncEnabledRef.current = next;
    engineRef.current?.setEnabled(next);
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  if (isDirectMedia) {
    return (
      <PlayerContainer>
        <VideoWrapper>
          <video
            ref={mediaRef}
            src={videoUrl}
            playsInline
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
            }}
          />
          {showHud && <SyncHud status={status} />}
        </VideoWrapper>
        <Controls>
          <ControlRow>
            <PlayButton
              data-testid="play-button"
              onClick={handlePlayPause}
              canControl={canControl}
              disabled={!isReady}
            >
              {status.roomPlaying ? '⏸' : '▶'}
              {status.roomPlaying ? 'Pause' : 'Play'}
            </PlayButton>
            <ProgressContainer>
              <ProgressBar
                data-testid="progress-bar"
                onClick={handleProgressClick}
                canControl={canControl}
              >
                <ProgressFill
                  progress={
                    status.durationS > 0
                      ? Math.min(
                          100,
                          ((status.roomPlaying
                            ? status.projectedS
                            : (status.timeline?.mediaTime ?? 0)) /
                            status.durationS) *
                            100,
                        )
                      : 0
                  }
                />
              </ProgressBar>
            </ProgressContainer>
          </ControlRow>
        </Controls>
      </PlayerContainer>
    );
  }

  if (!videoId) {
    return (
      <PlayerContainer>
        <div style={{ padding: '60px', textAlign: 'center', color: '#2d3748' }}>
          <h3>No Video Selected</h3>
          <p style={{ color: '#718096' }}>
            Please provide a valid YouTube URL
          </p>
        </div>
      </PlayerContainer>
    );
  }

  const shownTime = status.roomPlaying
    ? status.projectedS
    : status.timeline?.mediaTime ?? 0;

  return (
    <PlayerContainer>
      <VideoWrapper>
        <PlayerDiv id="youtube-player" />
        {status.needsGesture && (
          <GestureChip onClick={() => engineRef.current?.resumeFromGesture()}>
            ▶ Click to join playback
          </GestureChip>
        )}
        {showHud && <SyncHud status={status} />}
      </VideoWrapper>

      <Controls>
        <ControlRow>
          <PlayButton
            data-testid="play-button"
            onClick={handlePlayPause}
            canControl={canControl}
            disabled={!isReady}
          >
            {status.roomPlaying ? '⏸' : '▶'}
            {status.roomPlaying ? 'Pause' : 'Play'}
          </PlayButton>

          <ProgressContainer>
            <ProgressBar
              data-testid="progress-bar"
              onClick={handleProgressClick}
              canControl={canControl}
            >
              <ProgressFill
                progress={
                  status.durationS > 0
                    ? Math.min(100, (shownTime / status.durationS) * 100)
                    : 0
                }
              />
            </ProgressBar>
          </ProgressContainer>

          <TimeDisplay>
            {formatTime(shownTime)} / {formatTime(status.durationS)}
          </TimeDisplay>
        </ControlRow>

        <StatusRow>
          <StatusGroup>
            <StatusItem type={connected ? 'success' : 'error'}>
              <StatusDot color={connected ? '#6366f1' : '#f87171'} />
              {connected ? 'Connected' : 'Disconnected'}
            </StatusItem>

            <CollaborativeIndicator enabled={allowGuestControl}>
              {allowGuestControl ? '👥 Collaborative' : '👑 Host Only'}
            </CollaborativeIndicator>
          </StatusGroup>

          <StatusGroup>
            <StatusItem type="info">
              {Number.isFinite(status.rttMs) ? `${Math.round(status.rttMs)}ms` : '—'}
            </StatusItem>
            <ControlButton active={syncEnabled} onClick={handleSyncToggle}>
              🔗 Sync {syncEnabled ? 'ON' : 'OFF'}
            </ControlButton>
          </StatusGroup>
        </StatusRow>
      </Controls>
    </PlayerContainer>
  );
};
