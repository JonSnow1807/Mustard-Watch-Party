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
  None            \* model value: "no owner"

VARIABLES
  lease,          \* [owner: Instance \cup {None}, epoch: Nat] - the store's lease
  ownerView,      \* per instance: the epoch it BELIEVES it owns (0 = none)
  committed,      \* the store's committed state: [epoch, seq]
  network,        \* in-flight broadcasts to clients: set of [dst, epoch, seq]
  applied,        \* per client: last applied [epoch, seq]
  crashed         \* set of crashed instances (may revive as zombies)

vars == <<lease, ownerView, committed, network, applied, crashed>>

Init ==
  /\ lease = [owner |-> None, epoch |-> 0]
  /\ ownerView = [i \in Instances |-> 0]
  /\ committed = [epoch |-> 0, seq |-> 0]
  /\ network = {}
  /\ applied = [c \in Clients |-> [epoch |-> 0, seq |-> 0]]
  /\ crashed = {}

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
  /\ UNCHANGED <<committed, network, applied, crashed>>

(***************************************************************************)
(* Commit: an instance that BELIEVES it owns the room serializes a control *)
(* in memory and commits under its fence. The store accepts iff the fence  *)
(* matches the current lease epoch - this is the guard a zombie fails.     *)
(* Accepted commits fan out to every client.                               *)
(***************************************************************************)
Commit(i) ==
  /\ i \notin crashed
  /\ ownerView[i] > 0
  /\ committed.seq < MaxSeq
  /\ IF ownerView[i] = lease.epoch /\ lease.owner = i
     THEN /\ committed' = [epoch |-> ownerView[i],
                           seq |-> IF committed.epoch = ownerView[i]
                                   THEN committed.seq + 1 ELSE 1]
          /\ network' = network \cup
               { [dst |-> c, epoch |-> committed'.epoch, seq |-> committed'.seq]
                 : c \in Clients }
          /\ UNCHANGED <<lease, ownerView, applied, crashed>>
     ELSE \* fenced out: the store rejects; the instance learns it lost
          /\ ownerView' = [ownerView EXCEPT ![i] = 0]
          /\ UNCHANGED <<lease, committed, network, applied, crashed>>

(* Crash: the owner (or any instance) dies; its lease will expire (modeled *)
(* by LeaseFree). Revive: it comes back as a ZOMBIE still holding its old  *)
(* ownerView - the dangerous state Commit's fence must neutralize.         *)
Crash(i) ==
  /\ i \notin crashed
  /\ crashed' = crashed \cup {i}
  /\ UNCHANGED <<lease, ownerView, committed, network, applied>>

Revive(i) ==
  /\ i \in crashed
  /\ crashed' = crashed \ {i}
  /\ UNCHANGED <<lease, ownerView, committed, network, applied>>

(* Clients apply by the ordered rule proven in SyncTimeline.tla. *)
Deliver(m) ==
  /\ m \in network
  /\ network' = network \ {m}
  /\ IF \/ m.epoch > applied[m.dst].epoch
        \/ m.epoch = applied[m.dst].epoch /\ m.seq > applied[m.dst].seq
     THEN applied' = [applied EXCEPT ![m.dst] = [epoch |-> m.epoch, seq |-> m.seq]]
     ELSE UNCHANGED applied
  /\ UNCHANGED <<lease, ownerView, committed, crashed>>

Drop(m) ==
  /\ m \in network
  /\ network' = network \ {m}
  /\ UNCHANGED <<lease, ownerView, committed, applied, crashed>>

(* The sweep re-fans the committed state - run by the CURRENT owner only.  *)
Sweep ==
  /\ lease.owner /= None
  /\ lease.owner \notin crashed
  /\ committed.epoch > 0
  /\ network' = network \cup
       { [dst |-> c, epoch |-> committed.epoch, seq |-> committed.seq] : c \in Clients }
  /\ UNCHANGED <<lease, ownerView, committed, applied, crashed>>

Next ==
  \/ \E i \in Instances : Claim(i) \/ Commit(i) \/ Crash(i) \/ Revive(i)
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

Spec == Init /\ [][Next]_vars /\ Fairness

----------------------------------------------------------------------------
(* Safety *)

(* At most one instance believes it holds the CURRENT fence. A zombie may  *)
(* believe it owns an OLD epoch - harmless, because commits are fenced.    *)
AtMostOneCurrentOwner ==
  Cardinality({ i \in Instances : ownerView[i] = lease.epoch /\ lease.epoch > 0 }) <= 1

(* The store never accepts a write under a stale fence: committed.epoch    *)
(* only ever equals the lease epoch at commit time, hence never decreases. *)
NoStaleFenceWrite ==
  [][committed'.epoch >= committed.epoch]_vars

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
  /\ committed.epoch \in 0..MaxEpoch
  /\ committed.seq \in 0..MaxSeq

(* TLC state constraint: bound in-flight messages - the sweep's re-fanning *)
(* otherwise makes the network powerset explode. Four in flight suffices  *)
(* to exhibit every interesting interleaving at the small constants.       *)
NetworkBound == Cardinality(network) <= 4

----------------------------------------------------------------------------
(* Liveness: whatever crashes and revives, clients eventually apply the    *)
(* latest committed state.                                                 *)
Convergence ==
  <>[](\A c \in Clients :
        applied[c].epoch = committed.epoch /\ applied[c].seq = committed.seq)

=============================================================================
