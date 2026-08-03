---------------------------- MODULE SyncTimeline ----------------------------
(***************************************************************************)
(* The Mustard Watch Party sync coordination protocol (plane A):           *)
(*   - a single authoritative store (Redis; one Lua script per mutation    *)
(*     modeled as one atomic action)                                       *)
(*   - N gateway instances that commit control events and broadcast the    *)
(*     committed state over a lossy, reordering fanout channel (pub/sub)   *)
(*   - M clients that apply received timelines by an ordering rule, plus   *)
(*     a periodic snapshot sweep as the repair channel                     *)
(*   - store loss (flush/restart) rehydrates under a FRESH epoch           *)
(*                                                                         *)
(* Media position is abstracted away: this spec is about *state            *)
(* distribution* (which committed timeline each client ends up applying),  *)
(* not about playback drift. Real time is abstracted to action ordering.  *)
(*                                                                         *)
(* The client ordering rule is a parameter (CLIENT_RULE):                  *)
(*   "naive": same epoch -> higher seq wins; different epoch -> accept     *)
(*            (the rule as first implemented in shared/sync-core)          *)
(*   "dead-epochs": as above, but an epoch a client has abandoned is dead  *)
(*            forever - stale pre-flush broadcasts cannot regress it       *)
(*   "ordered": epochs are totally ordered (minted from the store clock   *)
(*            domain), so staleness is decidable for never-seen epochs     *)
(* TLC rejects "naive" AND "deadepochs" (a client cannot classify an epoch *)
(* it has never visited) and proves "ordered" safe and live. FORMAL.md has *)
(* the traces - both findings changed the implementation.                  *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets, TLC

CONSTANTS
  Clients,        \* e.g. {c1, c2, c3}
  MaxSeq,         \* bound on seq per epoch (e.g. 4)
  MaxEpoch,       \* bound on store epochs (e.g. 2 => one flush)
  ClientRule      \* "naive" or "deadepochs"

ASSUME ClientRule \in {"naive", "deadepochs", "ordered"}

VARIABLES
  storeEpoch,     \* current store epoch (0 = never initialized)
  storeSeq,       \* current committed seq within storeEpoch
  network,        \* set of in-flight broadcasts: [dst, epoch, seq]
  applied,        \* per client: the [epoch, seq] it currently applies
  deadEpochs      \* per client: epochs it has abandoned (deadepochs rule)

vars == <<storeEpoch, storeSeq, network, applied, deadEpochs>>

NoTimeline == [epoch |-> 0, seq |-> 0]

Init ==
  /\ storeEpoch = 1
  /\ storeSeq = 0
  /\ network = {}
  /\ applied = [c \in Clients |-> NoTimeline]
  /\ deadEpochs = [c \in Clients |-> {}]

(***************************************************************************)
(* An instance commits a mutation (control event or sweep snapshot): the   *)
(* store atomically assigns the next seq; the committed state is fanned    *)
(* out to every client. Which instance did it is irrelevant - the store    *)
(* serializes them all, so instances need not be modeled individually.     *)
(***************************************************************************)
Commit ==
  /\ storeSeq < MaxSeq
  /\ storeSeq' = storeSeq + 1
  /\ network' = network \cup
       { [dst |-> c, epoch |-> storeEpoch, seq |-> storeSeq + 1] : c \in Clients }
  /\ UNCHANGED <<storeEpoch, applied, deadEpochs>>

(***************************************************************************)
(* Store loss: flush/restart rehydrates under a fresh epoch, seq resets.   *)
(* Old-epoch messages may still be in flight - that is the point.          *)
(***************************************************************************)
Flush ==
  /\ storeEpoch < MaxEpoch
  /\ storeEpoch' = storeEpoch + 1
  /\ storeSeq' = 1   \* rehydration commit (reason 'join') fans out too
  /\ network' = network \cup
       { [dst |-> c, epoch |-> storeEpoch + 1, seq |-> 1] : c \in Clients }
  /\ UNCHANGED <<applied, deadEpochs>>

AcceptNaive(c, m) ==
  \/ m.epoch = applied[c].epoch /\ m.seq > applied[c].seq
  \/ m.epoch /= applied[c].epoch

AcceptDead(c, m) ==
  /\ m.epoch \notin deadEpochs[c]
  /\ \/ m.epoch = applied[c].epoch /\ m.seq > applied[c].seq
     \/ m.epoch /= applied[c].epoch

(***************************************************************************)
(* The fix TLC drove us to: epochs are ORDERED (minted from the store's    *)
(* clock domain at rehydration), so staleness is decidable without memory. *)
(* Dead-epoch tracking is insufficient - a client cannot classify an epoch *)
(* it has never visited; ordering classifies every message.                *)
(***************************************************************************)
AcceptOrdered(c, m) ==
  \/ m.epoch > applied[c].epoch
  \/ m.epoch = applied[c].epoch /\ m.seq > applied[c].seq

(***************************************************************************)
(* Delivery: any in-flight message may arrive (reordering = free choice    *)
(* of which element to deliver). Applying moves the client's state and,    *)
(* under the dead-epochs rule, kills the abandoned epoch forever.          *)
(***************************************************************************)
Deliver(m) ==
  /\ m \in network
  /\ network' = network \ {m}
  /\ IF (CASE ClientRule = "naive" -> AcceptNaive(m.dst, m)
            [] ClientRule = "deadepochs" -> AcceptDead(m.dst, m)
            [] ClientRule = "ordered" -> AcceptOrdered(m.dst, m))
     THEN /\ applied' = [applied EXCEPT ![m.dst] = [epoch |-> m.epoch, seq |-> m.seq]]
          /\ deadEpochs' =
               IF ClientRule = "deadepochs" /\ m.epoch /= applied[m.dst].epoch
               THEN [deadEpochs EXCEPT ![m.dst] = @ \cup {applied[m.dst].epoch}]
               ELSE deadEpochs
     ELSE UNCHANGED <<applied, deadEpochs>>
  /\ UNCHANGED <<storeEpoch, storeSeq>>

(* Pub/sub loss: any in-flight message may be dropped. *)
Drop(m) ==
  /\ m \in network
  /\ network' = network \ {m}
  /\ UNCHANGED <<storeEpoch, storeSeq, applied, deadEpochs>>

(***************************************************************************)
(* The 10s snapshot sweep: re-broadcasts the current committed state.      *)
(* Modeled as a Commit when at the seq bound it re-fans the same state so  *)
(* liveness does not depend on unbounded seq growth.                       *)
(***************************************************************************)
Sweep ==
  /\ network' = network \cup
       { [dst |-> c, epoch |-> storeEpoch, seq |-> storeSeq] : c \in Clients }
  /\ UNCHANGED <<storeEpoch, storeSeq, applied, deadEpochs>>

Next ==
  \/ Commit
  \/ Flush
  \/ \E m \in network : Deliver(m)
  \/ \E m \in network : Drop(m)
  \/ Sweep

(* Sweeps are weakly fair. Deliveries are STRONGLY fair: an adversarial   *)
(* schedule may drop any individual message, but a channel that is offered *)
(* messages infinitely often delivers infinitely often - i.e. pub/sub can  *)
(* be lossy, not dead. Weak fairness would be vacuously satisfied by a     *)
(* drop-everything schedule (Deliver keeps getting disabled), masking the  *)
(* repair channel entirely.                                                *)
Fairness ==
  /\ WF_vars(Sweep)
  /\ \A c \in Clients :
       SF_vars(\E m \in network : m.dst = c /\ Deliver(m))

Spec == Init /\ [][Next]_vars /\ Fairness

----------------------------------------------------------------------------
(* Safety *)

(* A client never applies a seq regression within one epoch. *)
NoSeqRegression ==
  [][\A c \in Clients :
       applied'[c].epoch = applied[c].epoch => applied'[c].seq >= applied[c].seq]_vars

(* A client that reached the store's current epoch never leaves it for an  *)
(* older one. VIOLATED under "naive": a stale pre-flush broadcast          *)
(* delivered after the post-flush one drags the client back.               *)
NoEpochRegression ==
  [][\A c \in Clients :
       applied[c].epoch = storeEpoch => applied'[c].epoch >= applied[c].epoch]_vars

(* Type sanity. *)
TypeOK ==
  /\ storeEpoch \in 1..MaxEpoch
  /\ storeSeq \in 0..MaxSeq
  /\ \A c \in Clients : applied[c].epoch \in 0..MaxEpoch /\ applied[c].seq \in 0..MaxSeq

----------------------------------------------------------------------------
(* Liveness: every client eventually applies the latest committed state    *)
(* (the sweep repairs lost/dropped broadcasts).                            *)
Convergence ==
  <>[](\A c \in Clients :
        applied[c].epoch = storeEpoch /\ applied[c].seq = storeSeq)

=============================================================================
