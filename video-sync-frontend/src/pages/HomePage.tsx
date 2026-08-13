import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useQuery } from '@tanstack/react-query';
import styled from '@emotion/styled';
import { apiService } from '../services/api';
import { listRecentRooms, type RecentRoom } from '../services/recent-rooms';
import { toast } from 'react-hot-toast';
import {
  color,
  font,
  radius,
  focusRing,
  button,
  buttonSm,
  chip,
  chipStatic,
  chipInteractive,
  chipMono,
  ghostIconButton,
  card,
  sectionLabel,
} from '../theme';
import { Wordmark, IconPlus, IconUsers, IconFilm, IconLock, IconX } from '../components/Icons';
import { ClaimAccountDialog, ClaimTrigger } from '../components/ClaimAccount';
import { AccountDialog } from '../components/AccountDialog';

const MEASUREMENTS_URL =
  'https://github.com/JonSnow1807/Mustard-Watch-Party/tree/main/docs/measurements';

const Page = styled.div`
  min-height: 100vh;
  background: ${color.bg0};
`;

const TopBar = styled.header`
  max-width: 1060px;
  margin: 0 auto;
  padding: 20px 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
`;

const TopBarRight = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
`;

// A BUTTON now, because it opens the account dialog - the first account
// surface this app has had. Styled to read as the same quiet text it
// always was, with just enough affordance to be discovered.
const SignedInAs = styled.button`
  font-family: ${font.body};
  font-size: 13px;
  color: ${color.dim};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: none;
  border: none;
  padding: 4px 6px;
  border-radius: 6px;
  cursor: pointer;
  &:hover {
    color: ${color.text};
    background: rgba(255, 255, 255, 0.04);
  }
  &:focus-visible {
    box-shadow: ${focusRing};
    outline: none;
  }
`;

const PrimaryButton = styled.button`
  ${button.primary}
  display: inline-flex;
  align-items: center;
  gap: 8px;
`;

const PrimarySmButton = styled.button`
  ${button.primary}
  ${buttonSm}
`;

const SecondaryButton = styled.button`
  ${button.secondary}
`;

const SecondarySmButton = styled.button`
  ${button.secondary}
  ${buttonSm}
`;

const Content = styled.main`
  max-width: 1060px;
  margin: 0 auto;
  padding: 0 24px 96px;
`;

/* ---- landing ---- */

const Hero = styled.section`
  padding-top: 96px;

  @media (max-width: 720px) {
    padding-top: 56px;
  }
`;

const HeroTitle = styled.h1`
  margin: 0;
  font-family: ${font.display};
  font-weight: 800;
  font-size: clamp(2.6rem, 6vw, 4.3rem);
  line-height: 1.03;
  letter-spacing: -0.02em;
  color: ${color.text};
`;

const HeroAccentLine = styled.span`
  display: block;
  color: ${color.mustard};
`;

const HeroBody = styled.p`
  margin: 20px 0 0;
  max-width: 520px;
  font-family: ${font.body};
  font-size: 17px;
  line-height: 1.6;
  color: ${color.dim};
`;

const CtaRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 32px;
`;

const StatStrip = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 48px;
  margin-top: 48px;
`;

const StatValue = styled.div`
  font-family: ${font.mono};
  font-size: 28px;
  font-weight: 500;
  color: ${color.text};
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
`;

const StatCaption = styled.div`
  ${sectionLabel}
  margin-top: 8px;
`;

const StatNote = styled.p`
  margin: 24px 0 0;
  font-family: ${font.body};
  font-size: 12px;
  line-height: 1.6;
  color: ${color.faint};
`;

const NoteLink = styled.a`
  color: ${color.mustard};
  text-decoration: none;
  border-bottom: 1px solid ${color.mustardDeep};
  transition: color 120ms ease, border-color 120ms ease;

  &:hover {
    color: ${color.mustardBright};
    border-color: ${color.mustardBright};
  }

  &:focus-visible {
    outline: none;
    box-shadow: ${focusRing};
    border-radius: ${radius.sm};
  }
`;

const Trio = styled.section`
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 32px;
  margin-top: 64px;

  @media (max-width: 720px) {
    grid-template-columns: 1fr;
    gap: 32px;
  }
`;

const TrioIndex = styled.div`
  font-family: ${font.mono};
  font-size: 11px;
  color: ${color.faint};
`;

const TrioTitle = styled.h2`
  margin: 8px 0 6px;
  font-family: ${font.display};
  font-weight: 600;
  font-size: 17px;
  color: ${color.text};
`;

const TrioBody = styled.p`
  margin: 0;
  font-family: ${font.body};
  font-size: 13.5px;
  line-height: 1.6;
  color: ${color.dim};
`;

/* ---- rooms ---- */

const Section = styled.section`
  margin-top: 48px;
`;

const EmptyActions = styled.div`
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
`;

const RecentRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 28px;
`;

const RecentChip = styled.button`
  ${chip.md}
  ${chipInteractive}
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const SectionActions = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`;

const SectionHead = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 16px;
`;

const SectionLabel = styled.h2`
  ${sectionLabel}
  margin: 0;
`;

const RoomsGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 16px;
  /* cards size to their own content: without this every card in a row
     stretches to the tallest one, leaving dead space under short ones */
  align-items: start;
`;

/* A plain container, not a control: the card carries the mouse affordance,
   while the two real buttons inside it (the name, the delete) carry focus.
   A role="button" here would make the delete button unreachable - ARIA
   forbids focusable content inside a button, and readers flatten it away. */
const RoomCard = styled.div`
  ${card}
  padding: 20px;
  cursor: pointer;
  transition: background 150ms ease, border-color 150ms ease;

  &:hover {
    background: ${color.bg2};
    border-color: ${color.lineBright};
  }
`;

const RoomCardHead = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 12px;
  min-width: 0;
`;

const RoomName = styled.h3`
  flex: 1;
  min-width: 0;
  margin: 0;
  font-family: ${font.display};
  font-weight: 600;
  font-size: 17px;
  line-height: 1.3;
  color: ${color.text};
`;

/* The name is the room's entry point for the keyboard: a real button, styled
   all the way back down to the heading text it renders, so nothing moves. */
const RoomNameButton = styled.button`
  display: block;
  width: 100%;
  margin: 0;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: ${radius.sm};
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;

  &:focus-visible {
    outline: none;
    box-shadow: ${focusRing};
  }
`;

/* The clamp lives on a child, not on the button: a button's own box wraps its
   content in an anonymous block, which swallows -webkit-line-clamp. */
const RoomNameText = styled.span`
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
`;

const LiveBadge = styled.span<{ isPlaying: boolean }>`
  ${chip.sm}
  ${chipStatic}
  ${chipMono}
  color: ${props => (props.isPlaying ? color.mustard : color.faint)};
  background: ${props => (props.isPlaying ? color.mustardFaint : color.bg2)};

  &::before {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: ${props => (props.isPlaying ? color.mustard : color.faint)};
    animation: ${props => (props.isPlaying ? 'pulse 2s infinite' : 'none')};
  }
`;

const GhostIconButton = styled.button`
  ${ghostIconButton}

  /* the one destructive control on the card: hover states in danger, not text */
  &:hover {
    color: ${color.danger};
    background: ${color.dangerFaint};
  }
`;

const RoomDescription = styled.p`
  margin: 10px 0 0;
  font-family: ${font.body};
  font-size: 13px;
  line-height: 1.5;
  color: ${color.dim};
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
`;

const MetaRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
  margin-top: 14px;
  font-family: ${font.body};
  font-size: 12.5px;
  color: ${color.dim};
`;

const Meta = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const MetaMono = styled.span`
  font-family: ${font.mono};
  font-size: 12.5px;
  color: ${color.dim};
  font-variant-numeric: tabular-nums;
`;

/* Text for screen readers only: the meta row's icons carry meaning that a
   sighted reader gets from the glyph and everyone else would get nothing. */
const SrOnly = styled.span`
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  border: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
`;

const ChipRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 12px;
`;

const Tag = styled.span`
  ${chip.sm}
  ${chipStatic}
  color: ${color.faint};
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const PrivateChip = styled.span`
  ${chip.sm}
  ${chipStatic}
`;

const FilterRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
`;

const FilterPill = styled.button<{ active: boolean }>`
  ${chip.sm}
  ${chipInteractive}
  border-color: ${props => (props.active ? color.mustardDeep : color.lineBright)};
  background: ${props => (props.active ? color.mustardFaint : 'transparent')};
  color: ${props => (props.active ? color.mustard : color.dim)};

  /* the selected pill stays mustard while hovered - hover must not undo state */
  &:hover {
    border-color: ${color.mustardDeep};
    color: ${props => (props.active ? color.mustard : color.text)};
  }
`;

const Loading = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 32px 0;
  font-family: ${font.body};
  font-size: 13.5px;
  color: ${color.dim};
`;

const EmptyCard = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 48px 24px;
  border: 1px dashed ${color.line};
  border-radius: ${radius.lg};
  color: ${color.faint};
  text-align: center;
`;

const EmptyTitle = styled.p`
  margin: 0;
  font-family: ${font.display};
  font-weight: 600;
  font-size: 16px;
  color: ${color.text};
`;

const EmptyText = styled.p`
  margin: 0;
  font-family: ${font.body};
  font-size: 13.5px;
  color: ${color.dim};
`;

/* ---- delete modal ---- */

const Overlay = styled.div`
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(8, 7, 5, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  z-index: 1000;
`;

const ModalCard = styled.div`
  ${card}
  padding: 24px;
  width: 100%;
  max-width: 420px;
`;

const ModalTitle = styled.h3`
  margin: 0 0 8px;
  font-family: ${font.display};
  font-weight: 600;
  font-size: 18px;
  color: ${color.text};
`;

const ModalText = styled.p`
  margin: 0 0 20px;
  font-family: ${font.body};
  font-size: 13.5px;
  line-height: 1.6;
  color: ${color.dim};
`;

const ModalButtons = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  justify-content: flex-end;
`;

const DangerFilledButton = styled.button`
  ${button.danger}
  background: ${color.danger};
  border-color: ${color.danger};
  color: ${color.mustardInk};
  font-weight: 600;

  &:hover {
    background: ${color.danger};
    border-color: ${color.danger};
    filter: brightness(1.08);
  }
`;

export const HomePage: React.FC = () => {
  const navigate = useNavigate();
  const { user, logout, isGuest } = useAuth();
  // A snapshot, so the row does not churn while you are looking at it - but
  // re-taken whenever the session changes. Reading it once for the lifetime
  // of the component meant a sign-out followed by a different sign-in, with
  // no reload in between, showed the previous person's room names.
  const [recentRooms, setRecentRooms] = useState<RecentRoom[]>([]);
  const userId = user?.id;
  useEffect(() => {
    setRecentRooms(userId ? listRecentRooms() : []);
  }, [userId]);

  const [publicFilter, setPublicFilter] = useState('all');
  const [deleteModal, setDeleteModal] = useState<{ show: boolean; room: any | null }>({ show: false, room: null });
  const cancelDeleteRef = useRef<HTMLButtonElement>(null);
  const deleteTriggerRef = useRef<HTMLElement | null>(null);

  // Fetch user's rooms
  const { data: userRooms, isLoading: userRoomsLoading, refetch: refetchUserRooms } = useQuery({
    // still keyed on the id so the cache busts when a different person signs
    // in, even though the request itself now carries the identity in its token
    queryKey: ['user-rooms', user?.id],
    queryFn: async () => {
      if (!user) return [];
      const response = await apiService.getUserRooms();
      return response.data;
    },
    enabled: !!user,
    refetchInterval: 10000,
  });

  // Fetch public rooms
  const { data: publicRooms, isLoading: publicRoomsLoading } = useQuery({
    queryKey: ['public-rooms', publicFilter],
    queryFn: async () => {
      const response = await apiService.getPublicRooms(publicFilter);
      return response.data;
    },
    refetchInterval: 10000,
  });

  const handleCreateRoom = () => {
    navigate('/create-room');
  };

  const handleJoinRoom = (roomCode: string, isPrivate: boolean = false) => {
    if (isPrivate) {
      navigate(`/join-room/${roomCode}`);
    } else {
      navigate(`/room/${roomCode}`);
    }
  };

  // The name button and the card both open the room; without this the click
  // would bubble to the card and push the same route twice.
  const handleRoomNameClick = (e: React.MouseEvent, roomCode: string) => {
    e.stopPropagation();
    handleJoinRoom(roomCode);
  };

  const handleDeleteRoom = async (room: any) => {
    try {
      await apiService.deleteRoom(room.code);
      toast.success('Room deleted');
      setDeleteModal({ show: false, room: null });
      refetchUserRooms();
    } catch (error: any) {
      toast.error(error.response?.data?.message || "Couldn't delete the room");
    }
  };

  const showDeleteModal = (room: any, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteModal({ show: true, room });
  };

  // The dialog itself lives in components/ClaimAccount, so the room page can
  // show the same one - a guest most wants to keep their account after an
  // evening in a room, which was the one place this could not be reached.
  const [claimOpen, setClaimOpen] = useState(false);
  const closeClaim = useCallback(() => setClaimOpen(false), []);
  const [accountOpen, setAccountOpen] = useState(false);
  const closeAccount = useCallback(() => setAccountOpen(false), []);

  const hideDeleteModal = useCallback(() => {
    setDeleteModal({ show: false, room: null });
  }, []);

  // A dialog has to behave like one: focus moves in when it opens, Escape
  // closes it, and focus returns to whatever opened it.
  useEffect(() => {
    if (!deleteModal.show) return;

    deleteTriggerRef.current = document.activeElement as HTMLElement | null;
    cancelDeleteRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hideDeleteModal();
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      // the trigger is gone once its room is deleted; focusing it is then a no-op
      deleteTriggerRef.current?.focus();
      deleteTriggerRef.current = null;
    };
  }, [deleteModal.show, hideDeleteModal]);

  const getTimeSince = (date: string) => {
    const minutes = Math.floor((Date.now() - new Date(date).getTime()) / 60000);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  };

  if (!user) {
    return (
      <Page>
        <TopBar>
          <Wordmark size={18} />
          <TopBarRight>
            <SecondaryButton type="button" onClick={() => navigate('/login')}>
              Sign in
            </SecondaryButton>
          </TopBarRight>
        </TopBar>

        <Content>
          <Hero>
            <HeroTitle>
              Watch together.
              <HeroAccentLine>Milliseconds apart.</HeroAccentLine>
            </HeroTitle>
            <HeroBody>
              Every player in the room holds to the same frame — YouTube, Vimeo, HLS, or a
              plain file — kept in sync by an engine whose drift numbers are published, not
              promised.
            </HeroBody>
            <CtaRow>
              <PrimaryButton type="button" onClick={() => navigate('/login')}>
                Start a room
              </PrimaryButton>
              <SecondaryButton type="button" onClick={() => navigate('/join')}>
                I have a code
              </SecondaryButton>
            </CtaRow>

            <StatStrip>
              <div>
                <StatValue>6 ms</StatValue>
                <StatCaption>median drift · direct file</StatCaption>
              </div>
              <div>
                <StatValue>16 ms</StatValue>
                <StatCaption>median drift · YouTube</StatCaption>
              </div>
              <div>
                <StatValue>19 ms</StatValue>
                <StatCaption>median drift · YouTube at 300 ms RTT</StatCaption>
              </div>
            </StatStrip>

            <StatNote>
              steady-state cross-client P50, player-reported · 3 Chrome clients ·{' '}
              <NoteLink href={MEASUREMENTS_URL} target="_blank" rel="noreferrer">
                measured, not claimed
              </NoteLink>
            </StatNote>
          </Hero>

          <Trio>
            <div>
              <TrioIndex>01</TrioIndex>
              <TrioTitle>Every source, same sync</TrioTitle>
              <TrioBody>
                One classifier decides what a URL is; one engine drives whatever mounts.
                YouTube quantizes its clock — we reconstruct it. Vimeo only speaks promises —
                we model it.
              </TrioBody>
            </div>
            <div>
              <TrioIndex>02</TrioIndex>
              <TrioTitle>Controls that can't double-fire</TrioTitle>
              <TrioBody>
                Every play, pause, and seek carries an idempotency key the server applies
                exactly once — model-checked first, then proven by injection: duplicated
                commands commit exactly zero extra times.
              </TrioBody>
            </div>
            <div>
              <TrioIndex>03</TrioIndex>
              <TrioTitle>Rooms that heal</TrioTitle>
              <TrioBody>
                A repair sweep re-anchors every client from the server's clock. Kill a server
                mid-playback and the room carries on.
              </TrioBody>
            </div>
          </Trio>
        </Content>
      </Page>
    );
  }

  return (
    <Page>
      <TopBar>
        <Wordmark size={18} />
        <TopBarRight>
          <SignedInAs
            type="button"
            onClick={() => setAccountOpen(true)}
            title="Account & security"
          >
            {isGuest ? `Guest · ${user.username}` : `Signed in as ${user.username}`}
          </SignedInAs>
          {/* This used to be a plain "temporary session" label, with a
              comment explaining that a "keep this account" button would be a
              promise nothing behind it could honour - signing up made a
              DIFFERENT account and abandoned the guest's rooms and messages.
              POST /auth/claim updates the row in place, so the promise can
              now be kept and the button is honest. */}
          {isGuest && (
            <ClaimTrigger
              type="button"
              onClick={() => setClaimOpen(true)}
              title="Guest sessions expire - keep this one, with everything in it"
            >
              Keep this account
            </ClaimTrigger>
          )}
          <SecondarySmButton type="button" onClick={() => logout()}>
            Sign out
          </SecondarySmButton>
        </TopBarRight>
      </TopBar>

      <Content>
        {recentRooms.length > 0 && (
          <>
            <SectionLabel as="h2">Jump back in</SectionLabel>
            <RecentRow>
              {recentRooms.map((r) => (
                <RecentChip
                  key={r.code}
                  type="button"
                  title={`Rejoin ${r.name}`}
                  onClick={() => navigate(`/room/${r.code}`)}
                >
                  {r.name}
                </RecentChip>
              ))}
            </RecentRow>
          </>
        )}

        {/* Your Rooms Section */}
        <Section>
          <SectionHead>
            <SectionLabel>Your rooms</SectionLabel>
            <SectionActions>
              {/* someone who was sent a code needs somewhere to put it, and
                  this dashboard was previously a dead end for them */}
              <SecondarySmButton type="button" onClick={() => navigate('/join')}>
                Join with a code
              </SecondarySmButton>
              <PrimarySmButton type="button" onClick={handleCreateRoom}>
                <IconPlus size={14} />
                New room
              </PrimarySmButton>
            </SectionActions>
          </SectionHead>

          {userRoomsLoading ? (
            <Loading>
              <div className="spinner"></div>
              <span>Loading rooms…</span>
            </Loading>
          ) : userRooms?.length > 0 ? (
            <RoomsGrid>
              {userRooms.map((room: any) => (
                <RoomCard key={room.id} onClick={() => handleJoinRoom(room.code)}>
                  <RoomCardHead>
                    <RoomName>
                      <RoomNameButton
                        type="button"
                        onClick={(e) => handleRoomNameClick(e, room.code)}
                      >
                        <RoomNameText>{room.name}</RoomNameText>
                      </RoomNameButton>
                    </RoomName>
                    <LiveBadge isPlaying={room.isPlaying}>
                      {room.isPlaying ? 'LIVE' : 'PAUSED'}
                    </LiveBadge>
                    {room.creatorId === user.id && (
                      <GhostIconButton
                        type="button"
                        onClick={(e) => showDeleteModal(room, e)}
                        title="Delete this watch party"
                      >
                        <IconX size={15} />
                      </GhostIconButton>
                    )}
                  </RoomCardHead>

                  {room.description && (
                    <RoomDescription>{room.description}</RoomDescription>
                  )}

                  {(!room.isPublic || room.tags?.length > 0) && (
                    <ChipRow>
                      {!room.isPublic && (
                        <PrivateChip>
                          <IconLock size={12} />
                          Private
                        </PrivateChip>
                      )}
                      {room.tags?.map((tag: string) => (
                        <Tag key={tag}>{tag}</Tag>
                      ))}
                    </ChipRow>
                  )}

                  <MetaRow>
                    <Meta title="Participants">
                      <IconUsers size={13} />
                      {room._count.participants}
                      <SrOnly>{' '}participants</SrOnly>
                    </Meta>
                    {room.videoUrl && (
                      <Meta title="Has a video">
                        <IconFilm size={13} />
                        <SrOnly>Has a video</SrOnly>
                      </Meta>
                    )}
                    <MetaMono>{getTimeSince(room.createdAt)}</MetaMono>
                  </MetaRow>
                </RoomCard>
              ))}
            </RoomsGrid>
          ) : (
            <EmptyCard>
              <IconFilm size={26} />
              <EmptyTitle>No rooms yet.</EmptyTitle>
              <EmptyText>Start one and send the code.</EmptyText>
              <EmptyActions>
                <PrimaryButton type="button" onClick={handleCreateRoom}>
                  New room
                </PrimaryButton>
                <SecondaryButton type="button" onClick={() => navigate('/join')}>
                  Join with a code
                </SecondaryButton>
              </EmptyActions>
            </EmptyCard>
          )}
        </Section>

        {/* Public Rooms Section */}
        <Section>
          <SectionHead>
            <SectionLabel>Public rooms</SectionLabel>
            <FilterRow>
              <FilterPill
                type="button"
                active={publicFilter === 'all'}
                onClick={() => setPublicFilter('all')}
              >
                All
              </FilterPill>
              <FilterPill
                type="button"
                active={publicFilter === 'movies'}
                onClick={() => setPublicFilter('movies')}
              >
                Movies
              </FilterPill>
              <FilterPill
                type="button"
                active={publicFilter === 'tv'}
                onClick={() => setPublicFilter('tv')}
              >
                TV
              </FilterPill>
              <FilterPill
                type="button"
                active={publicFilter === 'education'}
                onClick={() => setPublicFilter('education')}
              >
                Education
              </FilterPill>
              <FilterPill
                type="button"
                active={publicFilter === 'music'}
                onClick={() => setPublicFilter('music')}
              >
                Music
              </FilterPill>
            </FilterRow>
          </SectionHead>

          {publicRoomsLoading ? (
            <Loading>
              <div className="spinner"></div>
              <span>Loading rooms…</span>
            </Loading>
          ) : publicRooms?.length > 0 ? (
            <RoomsGrid>
              {publicRooms.map((room: any) => (
                <RoomCard key={room.id} onClick={() => handleJoinRoom(room.code)}>
                  <RoomCardHead>
                    <RoomName>
                      <RoomNameButton
                        type="button"
                        onClick={(e) => handleRoomNameClick(e, room.code)}
                      >
                        <RoomNameText>{room.name}</RoomNameText>
                      </RoomNameButton>
                    </RoomName>
                    <LiveBadge isPlaying={room.isPlaying}>
                      {room.isPlaying ? 'LIVE' : 'PAUSED'}
                    </LiveBadge>
                  </RoomCardHead>

                  {room.description && (
                    <RoomDescription>{room.description}</RoomDescription>
                  )}

                  {room.tags?.length > 0 && (
                    <ChipRow>
                      {room.tags?.map((tag: string) => (
                        <Tag key={tag}>{tag}</Tag>
                      ))}
                    </ChipRow>
                  )}

                  <MetaRow>
                    <Meta title="Participants">
                      <IconUsers size={13} />
                      {room._count.participants}
                      <SrOnly>{' '}participants</SrOnly>
                    </Meta>
                    {room.videoUrl && (
                      <Meta title="Has a video">
                        <IconFilm size={13} />
                        <SrOnly>Has a video</SrOnly>
                      </Meta>
                    )}
                    <MetaMono>{getTimeSince(room.createdAt)}</MetaMono>
                    <Meta>by {room.creator.username}</Meta>
                  </MetaRow>
                </RoomCard>
              ))}
            </RoomsGrid>
          ) : (
            <EmptyCard>
              <IconFilm size={26} />
              <EmptyTitle>Nothing public right now.</EmptyTitle>
              <EmptyText>Public rooms show up here when someone starts one.</EmptyText>
            </EmptyCard>
          )}
        </Section>
      </Content>

      {claimOpen && <ClaimAccountDialog onClose={closeClaim} />}
      {accountOpen && <AccountDialog onClose={closeAccount} />}

      {/* Delete Confirmation Modal */}
      {deleteModal.show && deleteModal.room && (
        <Overlay onClick={hideDeleteModal}>
          <ModalCard
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-room-title"
            onClick={(e) => e.stopPropagation()}
          >
            <ModalTitle id="delete-room-title">Delete this room?</ModalTitle>
            <ModalText>
              This permanently removes &ldquo;{deleteModal.room.name}&rdquo; — participants,
              chat, and sync state.
            </ModalText>
            <ModalButtons>
              <SecondaryButton type="button" ref={cancelDeleteRef} onClick={hideDeleteModal}>
                Cancel
              </SecondaryButton>
              <DangerFilledButton
                type="button"
                onClick={() => handleDeleteRoom(deleteModal.room)}
              >
                Delete room
              </DangerFilledButton>
            </ModalButtons>
          </ModalCard>
        </Overlay>
      )}
    </Page>
  );
};
