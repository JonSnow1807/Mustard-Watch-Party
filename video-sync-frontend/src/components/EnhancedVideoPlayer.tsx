import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSocket } from '../contexts/SocketContext';
import styled from '@emotion/styled';
import { toast } from 'react-hot-toast';
import {
  SyncEngine,
  type EngineAdapter,
  type EngineStatus,
} from '../sync/SyncEngine';
import { classifyMediaSource } from '../shared/media-source';
import { SYNC_EVENTS } from '../shared/sync-protocol';
import { SyncHud } from './SyncHud';
import { FailureCard } from './player/FailureCard';
import { YouTubeMount } from './player/YouTubeMount';
import { Html5Mount } from './player/Html5Mount';
import { VimeoMount } from './player/VimeoMount';
import {
  button,
  card,
  chip,
  chipInteractive,
  chipStatic,
  color,
  focusRing,
  font,
  radius,
} from '../theme';
import { IconCrown, IconPause, IconPlay, IconSync, IconUsers } from './Icons';

const PlayerContainer = styled.div`
  ${card}
  width: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
`;

const VideoWrapper = styled.div`
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  /* the controls must stay reachable without scrolling: on a short laptop
     a full-width 16:9 stage alone is taller than the viewport, which put
     Play below the fold. Cap the stage, letterbox the rest. */
  max-height: calc(100vh - 230px);
  min-height: 260px;
  margin: 0 auto;
  background: #000;
  overflow: hidden;
`;

const GestureChip = styled.button`
  ${button.primary}
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 105;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border-radius: ${radius.pill};
`;

const Controls = styled.div`
  background: ${color.bg1};
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  border-top: 1px solid ${color.line};
`;

const ControlRow = styled.div`
  display: flex;
  align-items: center;
  gap: 16px;
`;

const PlayButton = styled.button<{ canControl: boolean }>`
  ${button.primary}
  display: inline-flex;
  align-items: center;
  gap: 8px;
  ${props =>
    props.canControl
      ? ''
      : `
    background: ${color.bg3};
    border-color: ${color.bg3};
    /* dim, not faint: faint on bg3 is 4.16:1, under AA for this 14px label */
    color: ${color.dim};
    cursor: not-allowed;
    &:hover { background: ${color.bg3}; border-color: ${color.bg3}; }
  `}
`;

const ProgressContainer = styled.div`
  flex: 1;
  min-width: 0;
  position: relative;
  height: 40px;
  display: flex;
  align-items: center;
`;

/**
 * The scrub thumb lives on the BAR, not on the fill. It used to hang off
 * ProgressFill and be revealed by `${ProgressBar}:hover &` - a component
 * selector, which CRA cannot compile because it does not enable
 * @emotion/babel-plugin, so the thumb never rendered at all. The bar owns
 * its own :hover, so putting the ::after here works with no plugin; it is
 * placed at the same spot (the fill's leading edge) from the same progress.
 */
const ProgressBar = styled.div<{ canControl: boolean; progress: number }>`
  width: 100%;
  height: 4px;
  background: ${color.lineBright};
  border-radius: ${radius.pill};
  cursor: ${props => (props.canControl ? 'pointer' : 'default')};
  position: relative;
  transition: height 120ms ease;

  &::after {
    content: '';
    position: absolute;
    top: 50%;
    left: ${props => props.progress}%;
    transform: translate(-50%, -50%);
    width: 10px;
    height: 10px;
    background: ${color.mustard};
    border-radius: 50%;
    opacity: 0;
    transition: opacity 120ms ease, left 100ms linear;
  }

  &:hover {
    height: ${props => (props.canControl ? '6px' : '4px')};

    /* only whoever can actually seek gets a scrub handle */
    &::after {
      opacity: ${props => (props.canControl ? 1 : 0)};
    }
  }

  &:focus-visible {
    outline: none;
    box-shadow: ${focusRing};
  }
`;

const ProgressFill = styled.div<{ progress: number }>`
  height: 100%;
  background: ${color.mustard};
  border-radius: ${radius.pill};
  width: ${props => props.progress}%;
  transition: width 100ms linear;
`;

const TimeDisplay = styled.div`
  font-family: ${font.mono};
  font-size: 12.5px;
  color: ${color.dim};
  font-variant-numeric: tabular-nums;
  min-width: 100px;
  text-align: right;
`;

const StatusRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  padding-top: 12px;
  border-top: 1px solid ${color.line};
`;

const StatusGroup = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
`;

/* the word carries the state too, not just the dot - a 6px dot is the
   whole difference otherwise, and it is the one thing color-blind and
   small-screen readers lose first */
const ConnectionState = styled.div<{ connected: boolean }>`
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: ${props => (props.connected ? color.dim : color.danger)};
`;

/* `tone`, not `color`: emotion forwards a prop literally named color to the
   DOM, which emits an invalid <div color="..."> attribute */
const StatusDot = styled.div<{ tone: string }>`
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
  background: ${props => props.tone};
  animation: pulse 2s ease-in-out infinite;
`;

/** Static status chip: who may drive playback. No hover, border `line`. */
const CollaborativeIndicator = styled.div<{ enabled: boolean }>`
  ${chip.sm}
  ${chipStatic}
  background: ${props => (props.enabled ? color.okFaint : color.bg2)};
  color: ${props => (props.enabled ? color.ok : color.dim)};
`;

const RttReadout = styled.div`
  font-family: ${font.mono};
  font-size: 12px;
  color: ${color.dim};
  font-variant-numeric: tabular-nums;
`;

/** Interactive chip: rests on `lineBright`, hovers toward mustard. */
const SyncToggle = styled.button<{ active?: boolean }>`
  ${chip.sm}
  ${chipInteractive}
  background: ${props => (props.active ? color.mustardFaint : color.bg2)};
  color: ${props => (props.active ? color.mustard : color.dim)};
  border-color: ${props => (props.active ? color.mustardDeep : color.lineBright)};
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

/**
 * The player SHELL: engine lifecycle, controls, HUD, failure card. Which
 * player actually renders is decided by classifyMediaSource - the same
 * classification the backend validates against, so a URL the API admitted
 * always lands on a mount (or the explicit not-yet-supported card), never
 * on undefined behavior. Mounts report an EngineAdapter up when drivable;
 * adapter presence is the shell's readiness.
 */
export const EnhancedVideoPlayer: React.FC<VideoPlayerProps> = ({
  videoUrl,
  roomCode,
  isHost = false,
  allowGuestControl = false
}) => {
  const { socket, connected } = useSocket();
  const [isReady, setIsReady] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [syncEnabled, setSyncEnabled] = useState(true);
  const syncEnabledRef = useRef(true);
  const [status, setStatus] = useState<EngineStatus>(EMPTY_STATUS);
  const [showHud, setShowHud] = useState(
    () => new URLSearchParams(window.location.search).get('debug') === '1',
  );

  const engineRef = useRef<SyncEngine | null>(null);
  const adapterRef = useRef<EngineAdapter | null>(null);
  const canControl = isHost || allowGuestControl;

  // Which video the room is showing: the TIMELINE is the authority once one
  // exists - set-video switches every participant through sync:timeline -
  // and the room row's URL only covers the gap before the first timeline
  // arrives. Both originate from the same store, so the handover is a
  // no-op unless a switch actually happened.
  const activeVideoUrl =
    status.timeline !== null ? status.timeline.videoId ?? '' : videoUrl;
  const source = useMemo(
    () => classifyMediaSource(activeVideoUrl),
    [activeVideoUrl],
  );

  // a failure belongs to one attempted source; the next video starts clean
  useEffect(() => setFailure(null), [activeVideoUrl]);

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
          duration: 2000,
        });
      } else if (r.reason === 'invalid-video-url') {
        toast.error('That video URL was refused by the server', {
          duration: 3000,
        });
      }
      // 'stale-video' stays silent by design: the targeted re-anchor that
      // accompanies it already switches this client to the video it missed
    };
    socket.on(SYNC_EVENTS.controlRejected, onRejected);

    return () => {
      socket.off(SYNC_EVENTS.controlRejected, onRejected);
      unsubscribe();
      engine.dispose();
      engineRef.current = null;
      // adapterRef is owned by the active mount - clearing it here orphaned
      // a live adapter (and its poll timer) on every reconnect
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

  // Mount callbacks: stable so mounts don't remount on shell re-renders
  const handleAdapter = useCallback((adapter: EngineAdapter | null) => {
    adapterRef.current = adapter;
    if (adapter) engineRef.current?.attachAdapter(adapter);
    setIsReady(adapter !== null);
  }, []);

  const handleFailure = useCallback((reason: string) => {
    setFailure(reason);
  }, []);

  // ---- gesture-only intents (wait-for-broadcast: the player is never
  // touched here; everyone converges from the sync:timeline broadcast) ----
  const handlePlayPause = () => {
    if (!canControl) {
      toast.error('Only the host can control video playback', {
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

  // What fills the 16:9 area. null mount = nothing playable = no controls.
  // (`overlay`, not `card` - that name belongs to the imported css fragment.)
  let mount: React.ReactNode = null;
  let overlay: React.ReactNode = null;
  if (failure) {
    overlay = (
      <FailureCard
        title="Couldn't play this video"
        detail={failure}
        url={activeVideoUrl}
      />
    );
  } else {
    switch (source.kind) {
      case 'youtube':
        // key: a new video id must tear the old player down, not mutate it
        mount = (
          <YouTubeMount
            key={source.videoId}
            videoId={source.videoId}
            onAdapter={handleAdapter}
            onFailure={handleFailure}
          />
        );
        break;
      case 'hls':
      case 'file':
        mount = (
          <Html5Mount
            key={source.url}
            url={source.url}
            hls={source.kind === 'hls'}
            onAdapter={handleAdapter}
            onFailure={handleFailure}
          />
        );
        break;
      case 'vimeo':
        mount = (
          <VimeoMount
            key={source.videoId}
            videoId={source.videoId}
            hash={source.hash}
            onAdapter={handleAdapter}
            onFailure={handleFailure}
          />
        );
        break;
      case 'none':
        overlay =
          source.reason === 'empty' ? (
            <FailureCard
              title="No video yet"
              detail="Add a video URL in the room settings to start watching together."
            />
          ) : (
            <FailureCard
              title="This video URL can't be played"
              detail="It isn't an http(s) video link a player could fetch."
              url={activeVideoUrl}
            />
          );
        break;
    }
  }

  const shownTime = status.roomPlaying
    ? status.projectedS
    : status.timeline?.mediaTime ?? 0;

  // one value, two consumers: the fill's width and the bar's scrub thumb
  const progressPct =
    status.durationS > 0
      ? Math.min(100, (shownTime / status.durationS) * 100)
      : 0;

  return (
    <PlayerContainer>
      <VideoWrapper>
        {mount ?? overlay}
        {mount && status.needsGesture && (
          <GestureChip onClick={() => engineRef.current?.resumeFromGesture()}>
            <IconPlay size={16} />
            Join playback
          </GestureChip>
        )}
        {showHud && <SyncHud status={status} />}
      </VideoWrapper>

      {mount && (
        <Controls>
          <ControlRow>
            <PlayButton
              data-testid="play-button"
              onClick={handlePlayPause}
              canControl={canControl}
              disabled={!isReady}
            >
              {status.roomPlaying ? <IconPause size={16} /> : <IconPlay size={16} />}
              {status.roomPlaying ? 'Pause' : 'Play'}
            </PlayButton>

            <ProgressContainer>
              <ProgressBar
                data-testid="progress-bar"
                onClick={handleProgressClick}
                canControl={canControl}
                progress={progressPct}
              >
                <ProgressFill progress={progressPct} />
              </ProgressBar>
            </ProgressContainer>

            <TimeDisplay>
              {formatTime(shownTime)} / {formatTime(status.durationS)}
            </TimeDisplay>
          </ControlRow>

          <StatusRow>
            <StatusGroup>
              <ConnectionState connected={connected}>
                <StatusDot tone={connected ? color.ok : color.danger} />
                {connected ? 'Connected' : 'Disconnected'}
              </ConnectionState>

              <CollaborativeIndicator enabled={allowGuestControl}>
                {allowGuestControl ? <IconUsers size={13} /> : <IconCrown size={13} />}
                {allowGuestControl ? 'Collaborative' : 'Host only'}
              </CollaborativeIndicator>
            </StatusGroup>

            <StatusGroup>
              <RttReadout title="Round-trip time to the sync server">
                {Number.isFinite(status.rttMs) ? `${Math.round(status.rttMs)} ms rtt` : '— ms rtt'}
              </RttReadout>
              <SyncToggle active={syncEnabled} onClick={handleSyncToggle}>
                <IconSync size={13} />
                {syncEnabled ? 'Sync on' : 'Sync off'}
              </SyncToggle>
            </StatusGroup>
          </StatusRow>
        </Controls>
      )}
    </PlayerContainer>
  );
};
