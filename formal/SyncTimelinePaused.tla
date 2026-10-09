------------------------- MODULE SyncTimelinePaused -------------------------
(***************************************************************************)
(* Variant of formal/SyncTimeline.tla (ClientRule = "ordered" fixed) that  *)
(* adds the one bit the repo spec abstracts away: whether the room is      *)
(* PLAYING. Before the paused-room re-send, the sweep in relay-rs, relay-go *)
(* and the Node timeline service re-fanned state only while playing.       *)
(* SweepPlayingOnly = TRUE models that pre-change behavior (still the Go   *)
(* and Node planes); FALSE models the repo spec and the current relay-rs   *)
(* sweep. Convergence is expected to FAIL under TRUE: a dropped final      *)
(* "pause" broadcast is never repaired. Model assumptions are not          *)
(* implementation evidence.                                                *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Clients, MaxSeq, SweepPlayingOnly

VARIABLES storeSeq, playing, network, applied

vars == <<storeSeq, playing, network, applied>>

NoTimeline == [seq |-> 0, playing |-> FALSE]

Init ==
  /\ storeSeq = 0
  /\ playing = FALSE
  /\ network = {}
  /\ applied = [c \in Clients |-> NoTimeline]

Fan(seq, p) == { [dst |-> c, seq |-> seq, playing |-> p] : c \in Clients }

\* a control commit: play or pause (seek keeps playing as-is; omitted, same shape)
CommitPlay ==
  /\ storeSeq < MaxSeq
  /\ storeSeq' = storeSeq + 1
  /\ playing' = TRUE
  /\ network' = network \cup Fan(storeSeq + 1, TRUE)
  /\ UNCHANGED applied

CommitPause ==
  /\ storeSeq < MaxSeq
  /\ storeSeq' = storeSeq + 1
  /\ playing' = FALSE
  /\ network' = network \cup Fan(storeSeq + 1, FALSE)
  /\ UNCHANGED applied

Deliver(m) ==
  /\ m \in network
  /\ network' = network \ {m}
  /\ applied' = IF m.seq > applied[m.dst].seq
                THEN [applied EXCEPT ![m.dst] = [seq |-> m.seq, playing |-> m.playing]]
                ELSE applied
  /\ UNCHANGED <<storeSeq, playing>>

Drop(m) ==
  /\ m \in network
  /\ network' = network \ {m}
  /\ UNCHANGED <<storeSeq, playing, applied>>

\* the 10 s repair sweep: re-fans the current committed state (as the repo
\* spec does at the seq bound). Gated on `playing` when SweepPlayingOnly.
Sweep ==
  /\ (SweepPlayingOnly => playing)
  /\ network' = network \cup Fan(storeSeq, playing)
  /\ UNCHANGED <<storeSeq, playing, applied>>

Next ==
  \/ CommitPlay
  \/ CommitPause
  \/ \E m \in network : Deliver(m)
  \/ \E m \in network : Drop(m)
  \/ Sweep

Fairness ==
  /\ WF_vars(Sweep)
  /\ \A c \in Clients :
       SF_vars(\E m \in network : m.dst = c /\ Deliver(m))

Spec == Init /\ [][Next]_vars /\ Fairness

TypeOK ==
  /\ storeSeq \in 0..MaxSeq
  /\ playing \in BOOLEAN
  /\ \A c \in Clients : applied[c].seq \in 0..MaxSeq

NoSeqRegression ==
  [][\A c \in Clients : applied'[c].seq >= applied[c].seq]_vars

\* every client eventually holds the latest committed (seq, playing)
Convergence ==
  <>[](\A c \in Clients : applied[c].seq = storeSeq /\ applied[c].playing = playing)

=============================================================================
