import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useSocket } from '../contexts/SocketContext';
import { useAuth } from '../contexts/AuthContext';
import { EnhancedVideoPlayer } from '../components/EnhancedVideoPlayer';
import { ChatPanel } from '../components/ChatPanel';
import { EnhancedVoiceChat } from '../components/EnhancedVoiceChat';
import { RoomSettings } from '../components/RoomSettings';
import { apiService } from '../services/api';
import { rememberRoom } from '../services/recent-rooms';
import styled from '@emotion/styled';
import { toast } from 'react-hot-toast';
import {
  color,
  font,
  button,
  buttonSm,
  chip,
  chipStatic,
  chipInteractive,
  chipMono,
  card,
  sectionLabel,
} from '../theme';
import {
  Wordmark,
  IconCopy,
  IconCheck,
  IconShare,
  IconSettings,
  IconLeave,
} from '../components/Icons';

const Page = styled.div`
  min-height: 100vh;
  background: ${color.bg0};
  color: ${color.text};
  font-family: ${font.body};
`;

const TopBar = styled.header`
  position: sticky;
  top: 0;
  z-index: 100;
  background: ${color.bg0};
  border-bottom: 1px solid ${color.line};
`;

const TopBarInner = styled.div`
  height: 56px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 20px;
`;

const Identity = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 1;
`;

/**
 * The wordmark is the first thing to go on a phone: the room NAME is this
 * page's h1 and the only thing telling you which room you are in, so it
 * stays at every width (it truncates) and the brand steps aside.
 */
const BrandSlot = styled.span`
  display: inline-flex;
  align-items: center;
  flex: none;

  @media (max-width: 560px) {
    display: none;
  }
`;

const Divider = styled.span`
  color: ${color.faint};
  font-size: 13px;
  line-height: 1;

  @media (max-width: 560px) {
    display: none;
  }
`;

const RoomName = styled.h1`
  margin: 0;
  min-width: 0;
  font-family: ${font.display};
  font-weight: 600;
  font-size: 15px;
  color: ${color.text};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const CodeChip = styled.button<{ copied?: boolean }>`
  ${chip.sm}
  ${chipInteractive}
  font-family: ${font.mono};
  letter-spacing: 0.04em;
  flex-shrink: 0;
  color: ${props => (props.copied ? color.ok : color.text)};
  border-color: ${props => (props.copied ? color.ok : color.lineBright)};

  &:hover {
    border-color: ${props => (props.copied ? color.ok : color.mustardDeep)};
    color: ${props => (props.copied ? color.ok : color.text)};
  }
`;

const Actions = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`;

const ActionLabel = styled.span`
  @media (max-width: 880px) {
    display: none;
  }
`;

/** Below 880px the labels drop out and these become icon-only squares. */
const actionTight = `
  @media (max-width: 880px) {
    padding: 6px 8px;
  }
`;

const SecondaryAction = styled.button`
  ${button.secondary}
  ${buttonSm}
  ${actionTight}
`;

const DangerAction = styled.button`
  ${button.danger}
  ${buttonSm}
  ${actionTight}
`;

const BackButton = styled.button`
  ${button.secondary}
`;

const Grid = styled.main`
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  gap: 20px;
  padding: 20px;

  @media (max-width: 1100px) {
    grid-template-columns: minmax(0, 1fr);
  }
`;

const MainColumn = styled.div`
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 20px;
`;

const SideColumn = styled.div`
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 20px;
  height: fit-content;
  position: sticky;
  top: 76px;

  @media (max-width: 1100px) {
    position: static;
  }
`;

const ParticipantsPanel = styled.div`
  ${card}
  padding: 16px;
`;

const PanelHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 16px;
`;

// h3, not h2: Participants, Chat and Voice are sibling panels of equal
// rank under the page's single h1 (the room name).
const PanelLabel = styled.h3`
  ${sectionLabel}
  margin: 0;
`;

const CountChip = styled.span`
  ${chip.sm}
  ${chipStatic}
  ${chipMono}
`;

const ParticipantRow = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 6px 0;
`;

const Avatar = styled.div`
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  border-radius: 50%;
  background: ${color.bg3};
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: ${font.display};
  font-weight: 600;
  font-size: 13px;
  color: ${color.mustard};
`;

const ParticipantName = styled.div`
  flex: 1;
  min-width: 0;
  font-size: 13.5px;
  color: ${color.text};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const SelfTag = styled.span`
  color: ${color.dim};
`;

const HostChip = styled.span`
  ${chip.sm}
  ${chipStatic}
  ${chipMono}
  color: ${color.mustard};
  background: transparent;
  border-color: ${color.mustardDeep};
  flex-shrink: 0;
`;

/**
 * Settings is a modal, not a slot at the bottom of the document.
 *
 * It used to render after the video and voice sections, which on any normal
 * window put it below the fold: pressing Settings appended a panel nobody
 * could see, so the button read as broken. A dialog cannot be missed, and it
 * is also the honest shape - changing the video for everyone in the room is a
 * focused task, not something to do while scrolled past the player.
 */
const SettingsOverlay = styled.div`
  position: fixed;
  inset: 0;
  z-index: 200;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 6vh 20px 40px;
  overflow-y: auto;
`;

const SettingsDialog = styled.div`
  width: 100%;
  max-width: 520px;
`;

const CenteredState = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  min-height: 100vh;
  padding: 24px;
  text-align: center;
`;

const StateText = styled.p`
  margin: 0;
  font-size: 13.5px;
  color: ${color.dim};
`;

const StateTitle = styled.h2`
  margin: 0;
  font-family: ${font.display};
  font-weight: 700;
  font-size: 20px;
  color: ${color.text};
`;

interface Room {
  id: string;
  name: string;
  code: string;
  videoUrl: string;
  creatorId: string;
  creator: { id: string; username: string };
  allowGuestControl?: boolean;
}

interface Participant {
  id: string;
  username: string;
}

export const EnhancedRoomPage: React.FC = () => {
  const { roomCode } = useParams<{ roomCode: string }>();
  const navigate = useNavigate();
  const { socket, connected } = useSocket();
  const { user, ready: authReady } = useAuth();

  const [room, setRoom] = useState<Room | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [loading, setLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);

  // The roster as the socket handlers last saw it. Join/leave toasts have to
  // fire exactly once per real event, so the "is this genuinely new?" decision
  // cannot live inside a setState updater - React runs updaters twice in
  // StrictMode and they must stay pure. Every write below sets the ref and the
  // state together, so back-to-back events in one tick still dedupe.
  const participantsRef = useRef<Participant[]>([]);

  useEffect(() => {
    participantsRef.current = participants;
  }, [participants]);

  // With several rooms open, every tab read "Mustard Watch Party" and the
  // only way to find the right one was to click through them.
  // A room joined by link belongs to no listing: "Your rooms" is what you
  // created, and a private room appears nowhere else. Remember it so closing
  // the tab does not mean hunting for the original message again.
  useEffect(() => {
    if (!room?.code) return;
    rememberRoom({ code: room.code, name: room.name });
  }, [room?.code, room?.name]);

  useEffect(() => {
    if (!room?.name) return;
    const previous = document.title;
    document.title = `${room.name} · mustard.watch`;
    return () => {
      document.title = previous;
    };
  }, [room?.name]);

  // Escape closes the settings dialog, and focus moves into it on open so a
  // keyboard user is not left tabbing through the page behind the overlay.
  const settingsRef = useRef<HTMLDivElement | null>(null);
  const settingsTriggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!showSettings) return;

    const FOCUSABLE =
      'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowSettings(false);
        return;
      }
      // Keep Tab inside the dialog. Without this, tabbing walks straight out
      // onto the page behind the overlay - which is invisible, still
      // clickable by keyboard, and a good way to change the video by
      // accident while thinking you are still in the settings.
      if (e.key !== 'Tab') return;
      const focusable = Array.from(
        settingsRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !settingsRef.current?.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKey);
    // Remember what opened it, so closing puts the caret back where it was
    // rather than dumping focus at the top of the document.
    settingsTriggerRef.current = document.activeElement as HTMLElement | null;
    settingsRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    return () => {
      window.removeEventListener('keydown', onKey);
      settingsTriggerRef.current?.focus?.();
    };
  }, [showSettings]);

  useEffect(() => {
    if (!roomCode) {
      navigate('/');
      return;
    }
    // Wait for the stored session to be read. `user` is null on the first
    // render of every page load, so redirecting here on !user alone sent
    // signed-in people to the join page too - every room link, and every
    // reload of the room you were already sitting in, cost an extra click.
    if (!authReady) return;

    // Room details now require a token (the REST guard), and the socket has
    // always required one. A signed-out visitor arriving on a shared link
    // should be asked to sign in, not shown "Couldn't load the room" - so
    // send them to the join page, which explains the room and offers sign-in.
    if (!user) {
      navigate(`/join-room/${roomCode}`, { replace: true });
      return;
    }

    fetchRoomDetails();
    // intentional: fetch once per room code, and again if auth appears
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode, user, authReady]);

  useEffect(() => {
    if (!socket || !connected || !user || !room) return;

    socket.emit('join-room', {
      roomCode: room.code,
      userId: user.id,
    });

    const handleRoomJoined = (data: any) => {
      if (data.participants) {
        participantsRef.current = data.participants;
        setParticipants(data.participants);
      }
      toast.success('Joined the room');
    };

    const handleUserJoined = (data: { userId: string; username: string }) => {
      if (participantsRef.current.some(p => p.id === data.userId)) return;
      const next = [
        ...participantsRef.current,
        { id: data.userId, username: data.username },
      ];
      participantsRef.current = next;
      setParticipants(next);
      toast(`${data.username} joined`);
    };

    const handleUserLeft = (data: { userId: string }) => {
      const leaving = participantsRef.current.find(p => p.id === data.userId);
      if (!leaving) return;
      const next = participantsRef.current.filter(p => p.id !== data.userId);
      participantsRef.current = next;
      setParticipants(next);
      toast(`${leaving.username} left`);
    };

    const handleParticipantsUpdate = (data: { participants: Participant[] }) => {
      participantsRef.current = data.participants;
      setParticipants(data.participants);
    };

    socket.on('room-joined', handleRoomJoined);
    socket.on('user-joined', handleUserJoined);
    socket.on('user-left', handleUserLeft);
    socket.on('participants-update', handleParticipantsUpdate);

    socket.emit('request-participants', { roomCode: room.code });

    return () => {
      socket.off('room-joined', handleRoomJoined);
      socket.off('user-joined', handleUserJoined);
      socket.off('user-left', handleUserLeft);
      socket.off('participants-update', handleParticipantsUpdate);
    };
  }, [socket, connected, user, room]);

  const fetchRoomDetails = async () => {
    try {
      const response = await apiService.getRoomByCode(roomCode!);
      setRoom(response.data);
      if (response.data.participants) {
        const roster = response.data.participants.map((p: any) => ({
          id: p.user.id,
          username: p.user.username,
        }));
        participantsRef.current = roster;
        setParticipants(roster);
      }
    } catch (error: any) {
      // A rejected token is not "this room is broken", it is "sign in
      // again" - and it must not throw the room away. Dropping people on
      // the marketing page with the code discarded is what every expired
      // session used to do, twelve hours after they last signed in.
      if (error?.response?.status === 401) {
        navigate(`/join-room/${roomCode}`, { replace: true });
        return;
      }
      toast.error("Couldn't load the room");
      navigate('/');
    } finally {
      setLoading(false);
    }
  };

  const handleCopyRoomCode = () => {
    if (room) {
      navigator.clipboard.writeText(room.code);
      setCopySuccess(true);
      toast.success('Room code copied');
      setTimeout(() => setCopySuccess(false), 2000);
    }
  };

  const handleShareRoom = () => {
    if (room) {
      const shareUrl = `${window.location.origin}/join-room/${room.code}`;
      navigator.clipboard.writeText(shareUrl);
      toast.success('Share link copied');
    }
  };

  const handleLeaveRoom = () => {
    if (socket && room) {
      socket.emit('leave-room', { roomCode: room.code, userId: user?.id });
    }
    navigate('/');
    toast.success('Left the room');
  };

  if (loading) {
    return (
      <Page>
        <CenteredState>
          <div className="spinner" />
          <StateText>Loading the room…</StateText>
        </CenteredState>
      </Page>
    );
  }

  if (!room) {
    return (
      <Page>
        <CenteredState>
          <StateTitle>Room not found</StateTitle>
          <BackButton type="button" onClick={() => navigate('/')}>Back to home</BackButton>
        </CenteredState>
      </Page>
    );
  }

  const isHost = user?.id === room.creatorId;

  return (
    <Page>
      <TopBar>
        <TopBarInner>
          <Identity>
            <BrandSlot>
              <Wordmark size={15} />
            </BrandSlot>
            <Divider>·</Divider>
            <RoomName>{room.name}</RoomName>
            <CodeChip
              type="button"
              copied={copySuccess}
              onClick={handleCopyRoomCode}
              title="Click to copy"
            >
              {copySuccess ? <IconCheck size={13} /> : <IconCopy size={13} />}
              {copySuccess ? 'copied' : room.code}
            </CodeChip>
          </Identity>

          <Actions>
            <SecondaryAction type="button" onClick={handleShareRoom} aria-label="Share">
              <IconShare size={14} />
              <ActionLabel>Share</ActionLabel>
            </SecondaryAction>

            {isHost && (
              <SecondaryAction
                type="button"
                onClick={() => setShowSettings(!showSettings)}
                aria-label="Settings"
              >
                <IconSettings size={14} />
                <ActionLabel>Settings</ActionLabel>
              </SecondaryAction>
            )}

            <DangerAction type="button" onClick={handleLeaveRoom} aria-label="Leave">
              <IconLeave size={14} />
              <ActionLabel>Leave</ActionLabel>
            </DangerAction>
          </Actions>
        </TopBarInner>
      </TopBar>

      <Grid>
        <MainColumn>
          <EnhancedVideoPlayer
            videoUrl={room.videoUrl}
            roomCode={room.code}
            isHost={isHost}
            userId={user?.id}
            allowGuestControl={room.allowGuestControl}
          />

          <EnhancedVoiceChat roomCode={room.code} />
        </MainColumn>

        <SideColumn>
          <ParticipantsPanel>
            <PanelHeader>
              <PanelLabel>Participants</PanelLabel>
              <CountChip>{participants.length}</CountChip>
            </PanelHeader>

            {/* Host */}
            {room.creator && (
              <ParticipantRow>
                <Avatar>{room.creator.username?.[0]?.toUpperCase() ?? '?'}</Avatar>
                <ParticipantName>
                  {room.creator.username}
                  {room.creator.id === user?.id && <SelfTag> (you)</SelfTag>}
                </ParticipantName>
                <HostChip>HOST</HostChip>
              </ParticipantRow>
            )}

            {/* Other participants */}
            {participants
              .filter(p => p.id !== room.creatorId)
              .map(participant => (
                <ParticipantRow key={participant.id}>
                  <Avatar>{participant.username?.[0]?.toUpperCase() ?? '?'}</Avatar>
                  <ParticipantName>
                    {participant.username}
                    {participant.id === user?.id && <SelfTag> (you)</SelfTag>}
                  </ParticipantName>
                </ParticipantRow>
              ))}
          </ParticipantsPanel>

          <ChatPanel roomCode={room.code} />
        </SideColumn>
      </Grid>

      {showSettings && isHost && (
        <SettingsOverlay
          role="dialog"
          aria-modal="true"
          aria-label="Room settings"
          // click-away closes, but only on the backdrop itself: without the
          // target check, a click that starts inside the panel and drifts
          // onto the overlay would discard whatever was being edited
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowSettings(false);
          }}
        >
          <SettingsDialog ref={settingsRef}>
            <RoomSettings
              room={room}
              onClose={() => setShowSettings(false)}
              onUpdate={() => fetchRoomDetails()}
            />
          </SettingsDialog>
        </SettingsOverlay>
      )}
    </Page>
  );
};
