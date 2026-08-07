---------------------------- MODULE SyncSetVideo ----------------------------
(***************************************************************************)
(* set-video as a synced control: switching the room's video must not let  *)
(* position-carrying commands (play/pause/seek) minted against the OLD     *)
(* video mutate the NEW one.                                               *)
(*                                                                         *)
(* The failure this models is concrete: a controller drags the scrubber    *)
(* to minute 37 of video A; while that seek is in flight another           *)
(* controller switches the room to video B; the seek arrives and yanks     *)
(* everyone to minute 37 of a video they just started. The command was     *)
(* well-formed, authorized, delivered exactly once - and still wrong,      *)
(* because its PRECONDITION (which video it was about) silently changed.   *)
(*                                                                         *)
(* The mechanism: every position command carries the videoId its minter    *)
(* last observed (forVideoId); the store's apply script rejects a command  *)
(* whose observed video is not the current one, atomically with the        *)
(* commit. set-video itself is NOT fenced - it carries no position, and a  *)
(* "stale" switch is still exactly what its sender meant (last-writer-     *)
(* wins is the right semantic for changing videos).                        *)
(*                                                                         *)
(* Two switches keep the spec's teeth - each OFF position is a committed   *)
(* config whose named failure pins a real design constraint:               *)
(*                                                                         *)
(*   FencingOn = FALSE  ->  NoCrossVideoApply fails: the in-flight seek    *)
(*                          applies to the switched video.                 *)
(*                          (SyncSetVideo_nofence.cfg)                     *)
(*   EarlyRecord = TRUE ->  DupAnswerImpliesApplied fails: recording the   *)
(*                          idempotency id BEFORE the fence check burns    *)
(*                          the id of a command that was never applied;    *)
(*                          when the room switches back and the client     *)
(*                          retries, the store answers "duplicate" -       *)
(*                          claiming an apply that never happened. The     *)
(*                          apply script must order: dedup lookup, THEN    *)
(*                          fence check, THEN commit+record - all still    *)
(*                          inside one atomic script.                      *)
(*                          (SyncSetVideo_earlyrecord.cfg)                 *)
(*                                                                         *)
(* Abstractions: media position is dropped entirely - the property is      *)
(* about WHICH video a command mutates, not where it lands. Dedup TTL and  *)
(* eviction are NOT modeled: SyncExactlyOnce.tla owns the TTL-vs-retry     *)
(* relation, and it is unchanged by fencing because a fenced command       *)
(* records nothing. Store epochs / instance fencing live in SyncActor.    *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  SeekCmds,      \* position-carrying command identities, e.g. {s1}
  SetVideoCmds,  \* set-video command identities, e.g. {sv1, sv2}
  Videos,        \* video identities, e.g. {v1, v2}
  InitVideo,     \* the room's video at Init
  MaxSends,      \* per-command bound on channel insertions (issue+retry)
  FencingOn,     \* the store rejects a position command whose observed
                 \* video is not the current one
  EarlyRecord,   \* WRONG ordering under test: record the dedup id before
                 \* the fence check instead of after it
  NoVideo        \* model value: "not yet issued" marker, outside Videos

ASSUME NoVideo \notin Videos

Cmds == SeekCmds \cup SetVideoCmds

VARIABLES
  roomVideo,     \* the room's current video
  seq,           \* commit counter (every apply bumps it)
  fenceOf,       \* [SeekCmds -> Videos \cup {NoVideo}]: the video the
                 \* command's minter observed, fixed at issue
  targetOf,      \* [SetVideoCmds -> Videos \cup {NoVideo}]: the commanded
                 \* new video, fixed at issue
  sends,         \* [Cmds -> Nat]: channel insertions so far
  chan,          \* [Cmds -> Nat]: copies in flight (a bag: delivery picks
                 \* any pending command, so reordering is inherent)
  dedup,         \* ids the store remembers (SET NX record)
  applyCount,    \* [Cmds -> Nat]: ground truth applications
  dupAnswered,   \* commands the store has answered "duplicate" to
  fencedAnswered,\* commands the store has answered "stale-video" to
  misapplied,    \* seeks that applied while the room showed a different
                 \* video than their minter observed - THE bad event
  acked          \* commands whose definitive answer the client observed

vars == <<roomVideo, seq, fenceOf, targetOf, sends, chan, dedup, applyCount,
          dupAnswered, fencedAnswered, misapplied, acked>>

Init ==
  /\ roomVideo = InitVideo
  /\ seq = 0
  /\ fenceOf = [c \in SeekCmds |-> NoVideo]
  /\ targetOf = [c \in SetVideoCmds |-> NoVideo]
  /\ sends = [c \in Cmds |-> 0]
  /\ chan = [c \in Cmds |-> 0]
  /\ dedup = {}
  /\ applyCount = [c \in Cmds |-> 0]
  /\ dupAnswered = {}
  /\ fencedAnswered = {}
  /\ misapplied = {}
  /\ acked = {}

Issued(c) ==
  IF c \in SeekCmds THEN fenceOf[c] # NoVideo ELSE targetOf[c] # NoVideo

(* Mint a position command: it carries the video its minter observes NOW.
   Staleness needs no separate observe action - it arises whenever a
   set-video applies between this mint and this command's delivery. *)
IssueSeek(c) ==
  /\ c \in SeekCmds
  /\ ~Issued(c)
  /\ sends[c] < MaxSends
  /\ fenceOf' = [fenceOf EXCEPT ![c] = roomVideo]
  /\ sends' = [sends EXCEPT ![c] = @ + 1]
  /\ chan' = [chan EXCEPT ![c] = @ + 1]
  /\ UNCHANGED <<roomVideo, seq, targetOf, dedup, applyCount, dupAnswered,
                 fencedAnswered, misapplied, acked>>

(* Mint a set-video: any target, including the current video - a redundant
   switch is still a legal user intent. *)
IssueSetVideo(c) ==
  /\ c \in SetVideoCmds
  /\ ~Issued(c)
  /\ sends[c] < MaxSends
  /\ \E v \in Videos :
       targetOf' = [targetOf EXCEPT ![c] = v]
  /\ sends' = [sends EXCEPT ![c] = @ + 1]
  /\ chan' = [chan EXCEPT ![c] = @ + 1]
  /\ UNCHANGED <<roomVideo, seq, fenceOf, dedup, applyCount, dupAnswered,
                 fencedAnswered, misapplied, acked>>

(* Unanswered command, client sends the same id again (reconnect flush or
   deliberate retry - at-least-once delivery, the origin of duplicates). *)
Retry(c) ==
  /\ Issued(c)
  /\ c \notin acked
  /\ sends[c] < MaxSends
  /\ sends' = [sends EXCEPT ![c] = @ + 1]
  /\ chan' = [chan EXCEPT ![c] = @ + 1]
  /\ UNCHANGED <<roomVideo, seq, fenceOf, targetOf, dedup, applyCount,
                 dupAnswered, fencedAnswered, misapplied, acked>>

(* The store's apply script - ONE atomic step, mirroring apply_control.lua.
   The ORDER inside the step is the design decision under test:
     1. dedup lookup: an already-applied id is answered "duplicate"
     2. fence check (position commands only): a stale observed video is
        answered "stale-video"; with EarlyRecord the id is (wrongly)
        recorded on this path
     3. commit + record
   set-video always passes 2: it has no position to misapply and switching
   is last-writer-wins by design. *)
Deliver(c) ==
  /\ chan[c] >= 1
  /\ chan' = [chan EXCEPT ![c] = @ - 1]
  /\ IF c \in dedup
     THEN /\ dupAnswered' = dupAnswered \cup {c}
          /\ UNCHANGED <<roomVideo, seq, fenceOf, targetOf, dedup,
                         applyCount, fencedAnswered, misapplied>>
     ELSE IF c \in SeekCmds /\ FencingOn /\ fenceOf[c] # roomVideo
     THEN /\ fencedAnswered' = fencedAnswered \cup {c}
          /\ dedup' = IF EarlyRecord THEN dedup \cup {c} ELSE dedup
          /\ UNCHANGED <<roomVideo, seq, fenceOf, targetOf, applyCount,
                         dupAnswered, misapplied>>
     ELSE /\ roomVideo' = IF c \in SetVideoCmds THEN targetOf[c]
                          ELSE roomVideo
          /\ seq' = seq + 1
          /\ applyCount' = [applyCount EXCEPT ![c] = @ + 1]
          /\ dedup' = dedup \cup {c}
          /\ misapplied' = IF c \in SeekCmds /\ fenceOf[c] # roomVideo
                           THEN misapplied \cup {c}
                           ELSE misapplied
          /\ UNCHANGED <<fenceOf, targetOf, dupAnswered, fencedAnswered>>
  /\ UNCHANGED <<sends, acked>>

(* The client observes a definitive answer - the committed broadcast, the
   duplicate re-anchor, or the stale-video re-anchor - and stops retrying. *)
Ack(c) ==
  /\ c \notin acked
  /\ applyCount[c] >= 1 \/ c \in dupAnswered \/ c \in fencedAnswered
  /\ acked' = acked \cup {c}
  /\ UNCHANGED <<roomVideo, seq, fenceOf, targetOf, sends, chan, dedup,
                 applyCount, dupAnswered, fencedAnswered, misapplied>>

Next ==
  \E c \in Cmds :
    IssueSeek(c) \/ IssueSetVideo(c) \/ Retry(c) \/ Deliver(c) \/ Ack(c)

Spec == Init /\ [][Next]_vars
             /\ \A c \in Cmds : WF_vars(Deliver(c)) /\ WF_vars(Ack(c))

(***************************************************************************)
(* Invariants                                                              *)
(***************************************************************************)

TypeOK ==
  /\ roomVideo \in Videos
  /\ seq \in Nat
  /\ fenceOf \in [SeekCmds -> Videos \cup {NoVideo}]
  /\ targetOf \in [SetVideoCmds -> Videos \cup {NoVideo}]
  /\ sends \in [Cmds -> 0..MaxSends]
  /\ chan \in [Cmds -> 0..MaxSends]
  /\ dedup \subseteq Cmds
  /\ applyCount \in [Cmds -> 0..MaxSends]
  /\ dupAnswered \subseteq Cmds
  /\ fencedAnswered \subseteq Cmds
  /\ misapplied \subseteq SeekCmds
  /\ acked \subseteq Cmds

(* THE property: no position command ever mutates a video its minter was
   not looking at. *)
NoCrossVideoApply == misapplied = {}

(* Idempotency stays exactly-once with fencing composed in. *)
AtMostOnce == \A c \in Cmds : applyCount[c] <= 1

(* A "duplicate" answer is a claim that the command was applied; it must
   never be a lie. The earlyrecord config is the counterexample: a fenced
   command's burned id turns its retry into a false duplicate.
   (Note the property that is deliberately ABSENT here: "a fenced command
   never applies later" is NOT an invariant of the design - a retry already
   in flight when the stale-video answer lands may legally apply after a
   switch back to the observed video. The fence matches again, so it is
   not a cross-video apply, and NoCrossVideoApply is the property that
   matters.) *)
DupAnswerImpliesApplied == \A c \in dupAnswered : applyCount[c] >= 1

(***************************************************************************)
(* Liveness: every issued command eventually gets a definitive answer -    *)
(* applied, duplicate, or stale-video - and the client stops retrying.     *)
(* Fencing must reject, never strand.                                      *)
(***************************************************************************)
EventuallyAnswered ==
  \A c \in Cmds : Issued(c) ~> (c \in acked)

===============================================================================
