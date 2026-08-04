----------------------------- MODULE SyncActor -----------------------------
(***************************************************************************)
(* Plane B — single-owner room actors with lease fencing (M13), specified  *)
(* BEFORE implementation. One room; N instances; ownership via a lease in  *)
(* the shared store; the owner serializes control events in memory and     *)
(* commits them under its fence (epoch); non-owners forward controls to    *)
(* the owner (fire-and-forget - the broadcast is the reply). Owner crash   *)
(* leads to lease expiry; any instance may then claim with a FRESH, HIGHER *)
(* epoch minted from the store clock domain (modeled as a monotone         *)
(* counter). A crashed-then-revived instance (the zombie) may still try to *)
(* commit under its old fence: the store MUST reject it.                   *)
(*                                                                         *)
(* Epochs double as fences AND as the client ordering rule proven in       *)
(* SyncTimeline.tla ("ordered"): one mechanism, two guarantees.            *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
  Instances,      \* e.g. {i1, i2}
  Clients,        \* e.g. {c1, c2}
  MaxSeq,         \* bound on committed writes per epoch
  MaxEpoch,       \* bound on ownership generations
  MaxCtl,         \* bound on distinct in-flight forwarded controls
  None            \* model value: "no owner"

VARIABLES
  lease,          \* [owner: Instance \cup {None}, epoch: Nat] - the store's lease
  ownerView,      \* per instance: the epoch it BELIEVES it owns (0 = none)
  committed,      \* the store's committed state: [epoch, seq]
  network,        \* in-flight broadcasts to clients: set of [dst, epoch, seq]
  applied,        \* per client: last applied [epoch, seq]
  crashed,        \* set of crashed instances (may revive as zombies)
  admitted,       \* controls admitted into the system (the INPUT bound)
  pending         \* forwarded controls: set of [to: Instance, id: 1..MaxCtl]

vars ==
  <<lease, ownerView, committed, network, applied, crashed, admitted, pending>>

Init ==
  /\ lease = [owner |-> None, epoch |-> 0]
  /\ ownerView = [i \in Instances |-> 0]
  /\ committed = [epoch |-> 0, seq |-> 0]
  /\ network = {}
  /\ applied = [c \in Clients |-> [epoch |-> 0, seq |-> 0]]
  /\ crashed = {}
  /\ admitted = 0
  /\ pending = {}

(***************************************************************************)
(* Claim: when no valid lease exists (never granted, expired - modeled as  *)
(* the owner being crashed - or explicitly released), a live instance may  *)
(* claim ownership under a fresh higher epoch. The mint is atomic in the   *)
(* store (a Lua script against the shared clock domain).                   *)
(***************************************************************************)
LeaseFree ==
  \/ lease.owner = None
  \/ lease.owner \in crashed

Claim(i) ==
  /\ i \notin crashed
  /\ LeaseFree
  /\ lease.epoch < MaxEpoch
  /\ lease' = [owner |-> i, epoch |-> lease.epoch + 1]
  /\ ownerView' = [ownerView EXCEPT ![i] = lease.epoch + 1]
  /\ UNCHANGED <<committed, network, applied, crashed, admitted, pending>>

(***************************************************************************)
(* Commit: an instance that BELIEVES it owns the room serializes a control *)
(* in memory and commits under its fence. The store accepts iff the fence  *)
(* matches the current lease epoch - this is the guard a zombie fails.     *)
(* Accepted commits fan out to every client.                               *)
(***************************************************************************)
Commit(i) ==
  /\ i \notin crashed
  /\ ownerView[i] > 0
  \* MaxSeq is an INPUT bound: it caps how many controls ever ENTER the
  \* system (local commits + forwards alike), not how many may be written.
  \* Capping writes instead let direct commits exhaust the budget and strand
  \* an already-forwarded control forever - a modelling artifact that looked
  \* exactly like a lost control.
  /\ admitted < MaxSeq
  /\ IF ownerView[i] = lease.epoch /\ lease.owner = i
     THEN /\ committed' = [epoch |-> ownerView[i],
                           seq |-> IF committed.epoch = ownerView[i]
                                   THEN committed.seq + 1 ELSE 1]
          /\ admitted' = admitted + 1
          /\ network' = network \cup
               { [dst |-> c, epoch |-> committed'.epoch, seq |-> committed'.seq]
                 : c \in Clients }
          /\ UNCHANGED <<lease, ownerView, applied, crashed, pending>>
     ELSE \* fenced out: the store rejects; the instance learns it lost
          /\ ownerView' = [ownerView EXCEPT ![i] = 0]
          /\ UNCHANGED <<lease, committed, network, applied, crashed, admitted,
                          pending>>

(* Crash: the owner (or any instance) dies; its lease will expire (modeled *)
(* by LeaseFree). Revive: it comes back as a ZOMBIE still holding its old  *)
(* ownerView - the dangerous state Commit's fence must neutralize.         *)
Crash(i) ==
  /\ i \notin crashed
  /\ crashed' = crashed \cup {i}
  /\ UNCHANGED <<lease, ownerView, committed, network, applied, admitted,
                  pending>>

Revive(i) ==
  /\ i \in crashed
  /\ crashed' = crashed \ {i}
  /\ UNCHANGED <<lease, ownerView, committed, network, applied, admitted,
                  pending>>

(***************************************************************************)
(* A non-owner does not touch state: it forwards the control to the room's  *)
(* owner and lets the owner commit and broadcast (the implementation's      *)
(* pub/sub forward). Modelled WITH a delivery signal, matching the code:    *)
(* if the observed owner is gone the publish reaches nobody and the sender  *)
(* reclaims rather than dropping the user's intent.                         *)
(***************************************************************************)
Forward(i) ==
  /\ i \notin crashed
  /\ lease.owner /= None
  /\ lease.owner /= i
  \* admission is bounded by the remaining write budget: TLC's MaxSeq is an
  \* INPUT bound, and admitting controls that can never commit would make a
  \* progress property fail for a modelling reason rather than a real one
  /\ admitted < MaxSeq
  /\ \E id \in 1..MaxCtl :
       \* identified controls: a plain set collapsed two forwards to the
       \* same owner into one element, silently losing a user's control
       /\ \A m \in pending : m.id /= id
       /\ IF lease.owner \notin crashed
          THEN /\ pending' = pending \cup {[to |-> lease.owner, id |-> id]}
               /\ admitted' = admitted + 1
               /\ UNCHANGED <<lease, ownerView, committed, network, applied,
                               crashed>>
          ELSE /\ lease.epoch < MaxEpoch
               /\ lease' = [owner |-> i, epoch |-> lease.epoch + 1]
               /\ ownerView' = [ownerView EXCEPT ![i] = lease.epoch + 1]
               /\ UNCHANGED <<committed, network, applied, crashed, admitted,
                               pending>>

(* The owner dequeues a forwarded control and commits it under its fence.  *)

(* Dequeue a SPECIFIC control. Aggregate fairness over `\E m \in pending`   *)
(* lets one control starve while others are repeatedly selected; fairness   *)
(* per identity is what actually guarantees each forwarded control moves.   *)
OwnerDequeueCtl(i, id) ==
  /\ i \notin crashed
  /\ \E m \in pending :
       /\ m.id = id
       /\ m.to = i
       /\ IF /\ ownerView[i] = lease.epoch
             /\ lease.owner = i
          THEN \* accepted: only NOW is the control consumed
               /\ pending' = pending \ {m}
               /\ committed' = [epoch |-> ownerView[i],
                                 seq |-> IF committed.epoch = ownerView[i]
                                         THEN committed.seq + 1 ELSE 1]
               /\ network' = network \cup
                    { [dst |-> c, epoch |-> committed'.epoch,
                       seq |-> committed'.seq] : c \in Clients }
               /\ UNCHANGED <<lease, ownerView, applied, crashed, admitted>>
          ELSE \* cannot commit (ownership moved, or the write bound is a
               \* TLC artifact): RE-TARGET to the current owner rather than
               \* consume it - dropping it here modelled a control loss the
               \* implementation does not have
               /\ lease.owner /= None
               /\ lease.owner /= i
               /\ pending' = (pending \ {m}) \cup
                    {[to |-> lease.owner, id |-> m.id]}
               /\ UNCHANGED <<lease, ownerView, committed, network, applied,
                               crashed, admitted>>

OwnerDequeue(i) == \E id \in 1..MaxCtl : OwnerDequeueCtl(i, id)

(* Clients apply by the ordered rule proven in SyncTimeline.tla. *)
Deliver(m) ==
  /\ m \in network
  /\ network' = network \ {m}
  /\ IF \/ m.epoch > applied[m.dst].epoch
        \/ m.epoch = applied[m.dst].epoch /\ m.seq > applied[m.dst].seq
     THEN applied' = [applied EXCEPT ![m.dst] = [epoch |-> m.epoch, seq |-> m.seq]]
     ELSE UNCHANGED applied
  /\ UNCHANGED <<lease, ownerView, committed, crashed, admitted, pending>>

Drop(m) ==
  /\ m \in network
  /\ network' = network \ {m}
  /\ UNCHANGED <<lease, ownerView, committed, applied, crashed, admitted, pending>>

(* The sweep re-fans the committed state - run by the CURRENT owner only.  *)
Sweep ==
  /\ lease.owner /= None
  /\ lease.owner \notin crashed
  /\ committed.epoch > 0
  /\ network' = network \cup
       { [dst |-> c, epoch |-> committed.epoch, seq |-> committed.seq] : c \in Clients }
  /\ UNCHANGED <<lease, ownerView, committed, applied, crashed, admitted, pending>>

Next ==
  \/ \E i \in Instances :
       Claim(i) \/ Commit(i) \/ Crash(i) \/ Revive(i)
         \/ Forward(i) \/ OwnerDequeue(i)
  \/ \E m \in network : Deliver(m) \/ Drop(m)
  \/ Sweep

Fairness ==
  \* SF, not WF: crash/revive churn keeps disabling the sweep, and weak
  \* fairness would let an adversarial scheduler starve the repair channel
  \* forever. Strong fairness states the real assumption: an owner that is
  \* alive infinitely often sweeps infinitely often.
  /\ SF_vars(Sweep)
  /\ \E i \in Instances : WF_vars(Claim(i))
  /\ \A c \in Clients :
       SF_vars(\E m \in network : m.dst = c /\ Deliver(m))
  /\ \A i \in Instances : WF_vars(Revive(i))
  \* a live owner eventually drains what was forwarded to it
  /\ \A i \in Instances, id \in 1..MaxCtl : SF_vars(OwnerDequeueCtl(i, id))

Spec == Init /\ [][Next]_vars /\ Fairness

----------------------------------------------------------------------------
(* Safety *)

(* At most one instance believes it holds the CURRENT fence. A zombie may  *)
(* believe it owns an OLD epoch - harmless, because commits are fenced.    *)
AtMostOneCurrentOwner ==
  Cardinality({ i \in Instances : ownerView[i] = lease.epoch /\ lease.epoch > 0 }) <= 1

(* The store never accepts a write under a stale fence.                    *)
(* The earlier form only required committed.epoch never to DECREASE, which *)
(* a stale write retaining the same epoch satisfies - the property was     *)
(* weaker than its name. This checks the real thing: every transition that *)
(* changes `committed` must write under the CURRENT lease epoch.           *)
NoStaleFenceWrite ==
  [][(committed' /= committed) => committed'.epoch = lease'.epoch]_vars

(* Within an epoch, committed seq never regresses. *)
CommitMonotone ==
  [][committed'.epoch = committed.epoch => committed'.seq >= committed.seq]_vars

(* Clients never regress (the ordered rule, now under ownership churn). *)
ClientNoRegress ==
  [][\A c \in Clients :
       \/ applied'[c].epoch > applied[c].epoch
       \/ (applied'[c].epoch = applied[c].epoch /\ applied'[c].seq >= applied[c].seq)]_vars

TypeOK ==
  /\ lease.epoch \in 0..MaxEpoch
  /\ lease.owner \in Instances \cup {None}
  /\ committed.epoch \in 0..MaxEpoch
  /\ committed.seq \in 0..MaxSeq
  /\ admitted \in 0..MaxSeq
  /\ crashed \subseteq Instances
  /\ \A i \in Instances : ownerView[i] \in 0..MaxEpoch
  /\ \A c \in Clients :
       /\ applied[c].epoch \in 0..MaxEpoch
       /\ applied[c].seq \in 0..MaxSeq
  /\ \A m \in pending : m.to \in Instances /\ m.id \in 1..MaxCtl
  /\ \A m \in network :
       /\ m.dst \in Clients
       /\ m.epoch \in 0..MaxEpoch
       /\ m.seq \in 0..MaxSeq

(* TLC state constraint: bound in-flight messages - the sweep's re-fanning *)
(* otherwise makes the network powerset explode. Four in flight suffices  *)
(* to exhibit every interesting interleaving at the small constants.       *)
NetworkBound == Cardinality(network) <= 4 /\ Cardinality(pending) <= MaxCtl

----------------------------------------------------------------------------
(* Liveness.                                                               *)
(*                                                                         *)
(* HONEST STATEMENT OF WHAT THIS PROVES. MaxSeq and MaxEpoch make commits  *)
(* finite, so `committed` must eventually stop changing; the property below*)
(* therefore verifies that clients converge ONCE COMMITS CEASE - repair     *)
(* after the last write, under arbitrary crash/revive and message loss.    *)
(* It does NOT prove convergence for a room under unbounded, continuing    *)
(* control traffic; TLC cannot exhaust that state space here. The stronger  *)
(* per-version property below is the one to reach for when the model is    *)
(* given an explicit quiescence scenario (see docs/FORMAL.md).             *)
Convergence ==
  <>[](\A c \in Clients :
        applied[c].epoch = committed.epoch /\ applied[c].seq = committed.seq)

(* Stronger and load-independent: a client never gets STUCK behind a       *)
(* committed version - it either applies that version or moves past it.    *)
(* Checked as a safety-style always-eventually per committed state.        *)
Behind(a, b) ==
  \/ a.epoch < b.epoch
  \/ (a.epoch = b.epoch /\ a.seq < b.seq)

(* Per-version progress. The earlier form re-evaluated `committed` in the  *)
(* consequent, so it only said "eventually catches whatever is current" -  *)
(* quantifying over a FIXED version states the documented guarantee: once  *)
(* version v is committed, every client eventually reaches v or passes it. *)
Versions == [epoch : 1..MaxEpoch, seq : 1..MaxSeq]

NoClientStrandedBehind ==
  \A c \in Clients : \A v \in Versions :
    (committed = v) ~> ~Behind(applied[c], v)

(* Every admitted control eventually leaves the queue (i.e. is committed). *)
EveryForwardedControlProgresses ==
  \A id \in 1..MaxCtl :
    (\E m \in pending : m.id = id) ~> (\A m \in pending : m.id /= id)

=============================================================================
