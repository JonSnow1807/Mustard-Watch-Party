--------------------------- MODULE SyncExactlyOnce ---------------------------
(***************************************************************************)
(* Exactly-once application of control commands under duplication and      *)
(* reordering, plus log-replay reconstruction.                             *)
(*                                                                         *)
(* The mechanism this models: every control command carries a client-      *)
(* minted id; the store's apply script atomically checks-and-records the   *)
(* id (Redis SET NX semantics, executed inside the same Lua script as the  *)
(* commit, so check+apply+record is one atomic step); commands are         *)
(* RETRIED by the client until it observes the commit - which is exactly   *)
(* how socket.io's send-buffer behaves across a reconnect, and is where    *)
(* duplicates come from in the real system. Exactly-once is therefore     *)
(* at-least-once delivery (retry) composed with at-most-once application   *)
(* (atomic dedup), never a property of the network.                        *)
(*                                                                         *)
(* Three switches make the spec keep its teeth - each OFF position is a    *)
(* committed config whose named failure pins a real design constraint:     *)
(*                                                                         *)
(*   DedupOn = FALSE       ->  AtMostOnce fails: a retried command applies *)
(*                             twice. (SyncExactlyOnce_nodedup.cfg)        *)
(*   Ttl <= RetryWindow    ->  AtMostOnce fails: a dedup entry expires     *)
(*                             while a copy can still arrive, and the      *)
(*                             late duplicate re-applies. The TTL and the  *)
(*                             client's retry deadline are modeled as      *)
(*                             CONCRETE clock bounds, so the proof is the  *)
(*                             time relation itself: Ttl > RetryWindow is  *)
(*                             checked green, Ttl <= RetryWindow is a      *)
(*                             committed counterexample.                   *)
(*                             (SyncExactlyOnce_earlyevict.cfg)            *)
(*   LogSnapshots = FALSE  ->  ReplayReconstructs fails: the repair        *)
(*                             sweep's snapshot commits bump seq and       *)
(*                             re-anchor the projection, so a log that     *)
(*                             only records control commands cannot        *)
(*                             rebuild live state.                         *)
(*                             (SyncExactlyOnce_nosnaplog.cfg)             *)
(*                                                                         *)
(* Abstractions: real time is a bounded counter in the store's clock       *)
(* domain (redis TIME); media position is a small integer; the projection  *)
(* pos + (now - anchor) mirrors projectMediaTime. Store epochs and         *)
(* instance fencing are NOT modeled here - SyncActor.tla owns those; this  *)
(* spec is single-epoch, and the composition note lives in FORMAL.md.      *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  Cmds,          \* command identities (client-minted UUIDs), e.g. {c1, c2}
  Positions,     \* abstract commanded media positions, e.g. 0..1
  MaxTime,       \* bound on the abstract clock
  MaxSends,      \* per-command bound on channel insertions (issue+retry+dup)
  DedupOn,       \* the store atomically checks-and-records command ids
  Ttl,           \* clock units a dedup record lives after the apply
  RetryWindow,   \* clock units after ISSUE during which a copy can still
                 \* be (re)sent or delivered - the client abandons unacked
                 \* commands past this deadline, which is what makes any
                 \* finite TTL sound at all
  LogSnapshots   \* sweep commits are appended to the log

Intents == {"play", "pause", "seek"}

VARIABLES
  now,        \* abstract store-domain clock
  intentOf,   \* [Cmds -> Intents \cup {"unissued"}]: payload, fixed at issue
  posOf,      \* [Cmds -> Positions \cup {0}]: commanded position
  sends,      \* [Cmds -> Nat]: channel insertions so far (bounds the space)
  chan,       \* [Cmds -> Nat]: copies in flight. A bag: delivery picks ANY
              \* command with a copy pending, so reordering is inherent.
  acked,      \* commands whose commit the client has observed (stops retry)
  issuedAt,   \* [Cmds -> 0..MaxTime]: when the command was first sent
  dedup,      \* ids the store remembers (the SET NX record)
  evictAt,    \* [Cmds -> Nat]: when c's dedup record expires (apply + Ttl)
  applyCount, \* [Cmds -> Nat]: ground truth - how often each cmd applied
  store,      \* [seq, playing, pos, anchor]
  log         \* append-only sequence of committed transitions

vars == <<now, intentOf, posOf, sends, chan, acked, issuedAt, dedup, evictAt,
          applyCount, store, log>>

InitStore == [seq |-> 0, playing |-> FALSE, pos |-> 0, anchor |-> 0]

(* projectMediaTime: where playback has advanced to at instant t. *)
Projection(s, t) == IF s.playing THEN s.pos + (t - s.anchor) ELSE s.pos

(* shared/sync-core/timeline.ts applyControl, abstracted. *)
Apply(s, i, p, t) ==
  IF i = "play"       THEN [seq |-> s.seq + 1, playing |-> TRUE,
                            pos |-> p, anchor |-> t]
  ELSE IF i = "pause" THEN [seq |-> s.seq + 1, playing |-> FALSE,
                            pos |-> p, anchor |-> t]
  ELSE                     [seq |-> s.seq + 1, playing |-> s.playing,
                            pos |-> p, anchor |-> t]   \* seek

(* shared/sync-core/timeline.ts snapshot: re-anchor without changing state. *)
Snap(s, t) == [seq |-> s.seq + 1, playing |-> s.playing,
               pos |-> Projection(s, t), anchor |-> t]

CmdEntry(c, t) == [kind |-> "cmd", id |-> c, intent |-> intentOf[c],
                   pos |-> posOf[c], t |-> t]
SnapEntry(t) == [kind |-> "snap", t |-> t]

ApplyEntry(s, e) ==
  IF e.kind = "cmd" THEN Apply(s, e.intent, e.pos, e.t) ELSE Snap(s, e.t)

RECURSIVE ReplayFrom(_, _)
ReplayFrom(s, entries) ==
  IF entries = << >> THEN s
  ELSE ReplayFrom(ApplyEntry(s, Head(entries)), Tail(entries))

(***************************************************************************)
(* Actions                                                                 *)
(***************************************************************************)

Init ==
  /\ now = 0
  /\ intentOf = [c \in Cmds |-> "unissued"]
  /\ posOf = [c \in Cmds |-> 0]
  /\ sends = [c \in Cmds |-> 0]
  /\ chan = [c \in Cmds |-> 0]
  /\ acked = {}
  /\ issuedAt = [c \in Cmds |-> 0]
  /\ dedup = {}
  /\ evictAt = [c \in Cmds |-> 0]
  /\ applyCount = [c \in Cmds |-> 0]
  /\ store = InitStore
  /\ log = << >>

Tick ==
  /\ now < MaxTime
  /\ now' = now + 1
  /\ UNCHANGED <<intentOf, posOf, sends, chan, acked, issuedAt, dedup,
                 evictAt, applyCount, store, log>>

(* The client mints an id and sends: payload chosen once, fixed forever. *)
Issue(c) ==
  /\ intentOf[c] = "unissued"
  /\ sends[c] < MaxSends
  /\ \E i \in Intents, p \in Positions :
       /\ intentOf' = [intentOf EXCEPT ![c] = i]
       /\ posOf' = [posOf EXCEPT ![c] = p]
  /\ issuedAt' = [issuedAt EXCEPT ![c] = now]
  /\ sends' = [sends EXCEPT ![c] = @ + 1]
  /\ chan' = [chan EXCEPT ![c] = @ + 1]
  /\ UNCHANGED <<now, acked, dedup, evictAt, applyCount, store, log>>

(* The client has not observed the commit, so it sends the SAME command
   again. This is the socket.io send-buffer flushing after a reconnect as
   much as it is a deliberate retry - either way, at-least-once delivery,
   and the origin of duplicates. *)
Retry(c) ==
  /\ intentOf[c] # "unissued"
  /\ c \notin acked
  /\ now <= issuedAt[c] + RetryWindow
  /\ sends[c] < MaxSends
  /\ sends' = [sends EXCEPT ![c] = @ + 1]
  /\ chan' = [chan EXCEPT ![c] = @ + 1]
  /\ UNCHANGED <<now, intentOf, posOf, acked, issuedAt, dedup, evictAt,
                 applyCount, store, log>>

(* Infrastructure-level duplication of an in-flight copy. *)
NetworkDup(c) ==
  /\ chan[c] >= 1
  /\ now <= issuedAt[c] + RetryWindow
  /\ sends[c] < MaxSends
  /\ sends' = [sends EXCEPT ![c] = @ + 1]
  /\ chan' = [chan EXCEPT ![c] = @ + 1]
  /\ UNCHANGED <<now, intentOf, posOf, acked, issuedAt, dedup, evictAt,
                 applyCount, store, log>>

(* The store's apply script: ONE atomic step containing the dedup check,
   the commit, the log append, and the dedup record - because in the
   implementation all four live inside the same Lua script.  Delivery picks
   any pending command, so reordering needs no extra machinery. *)
(* Delivery is bounded by the same window: past the client's retry
   deadline nothing carries the command any more - the send buffer died
   with the page, the connection is gone. This is the assumption that
   makes any finite TTL sound; the implementation must ENFORCE it by
   abandoning unacked commands older than the window rather than letting
   an arbitrarily old buffer flush. *)
Deliver(c) ==
  /\ chan[c] >= 1
  /\ now <= issuedAt[c] + RetryWindow
  /\ chan' = [chan EXCEPT ![c] = @ - 1]
  /\ IF DedupOn /\ c \in dedup
     THEN \* duplicate: dropped by the guard, nothing else moves
          UNCHANGED <<store, log, applyCount, dedup, evictAt>>
     ELSE /\ store' = Apply(store, intentOf[c], posOf[c], now)
          /\ log' = Append(log, CmdEntry(c, now))
          /\ applyCount' = [applyCount EXCEPT ![c] = @ + 1]
          /\ dedup' = dedup \cup {c}
          /\ evictAt' = [evictAt EXCEPT ![c] = now + Ttl]
  /\ UNCHANGED <<now, intentOf, posOf, sends, acked, issuedAt>>

(* The client observes the committed broadcast (or the ack) and stops
   retrying. Broadcast loss only delays this - Retry covers the gap. *)
Ack(c) ==
  /\ applyCount[c] >= 1
  /\ c \notin acked
  /\ acked' = acked \cup {c}
  /\ UNCHANGED <<now, intentOf, posOf, sends, chan, issuedAt, dedup,
                 evictAt, applyCount, store, log>>

(* The dedup record expires Ttl units after the apply - a plain clock,
   exactly what SET .. PX gives the implementation, with no oracle about
   in-flight copies. Whether this is safe is precisely the Ttl-vs-
   RetryWindow relation the configs check. *)
Evict(c) ==
  /\ c \in dedup
  /\ now >= evictAt[c]
  /\ dedup' = dedup \ {c}
  /\ UNCHANGED <<now, intentOf, posOf, sends, chan, acked, issuedAt,
                 evictAt, applyCount, store, log>>

(* The repair sweep commits a re-anchored snapshot (seq+1). Whether it is
   LOGGED is the design decision the nosnaplog config exists to test.
   Guarded to at most one sweep per clock unit: the real sweep is periodic,
   and an unguarded action would sweep unboundedly at a fixed instant,
   making the state space infinite without adding any behavior - a
   re-anchor at an unchanged clock is the identity on the projection. *)
Sweep ==
  /\ store.playing = TRUE
  /\ store.anchor # now
  /\ store' = Snap(store, now)
  /\ log' = IF LogSnapshots THEN Append(log, SnapEntry(now)) ELSE log
  /\ UNCHANGED <<now, intentOf, posOf, sends, chan, acked, issuedAt,
                 dedup, evictAt, applyCount>>

Next ==
  \/ Tick
  \/ Sweep
  \/ \E c \in Cmds : Issue(c) \/ Retry(c) \/ NetworkDup(c) \/ Deliver(c)
                     \/ Ack(c) \/ Evict(c)

Spec == Init /\ [][Next]_vars
             /\ \A c \in Cmds : WF_vars(Deliver(c)) /\ WF_vars(Ack(c))

(***************************************************************************)
(* Invariants                                                              *)
(***************************************************************************)

TypeOK ==
  /\ now \in 0..MaxTime
  /\ intentOf \in [Cmds -> Intents \cup {"unissued"}]
  /\ posOf \in [Cmds -> Positions \cup {0}]
  /\ sends \in [Cmds -> 0..MaxSends]
  /\ chan \in [Cmds -> 0..MaxSends]
  /\ acked \subseteq Cmds
  /\ issuedAt \in [Cmds -> 0..MaxTime]
  /\ dedup \subseteq Cmds
  /\ evictAt \in [Cmds -> 0..(MaxTime + Ttl)]
  /\ applyCount \in [Cmds -> 0..MaxSends]
  /\ store \in [seq : Nat, playing : BOOLEAN, pos : Nat, anchor : 0..MaxTime]
  /\ Len(log) <= store.seq

(* THE exactly-once safety property: no command applies twice. *)
AtMostOnce == \A c \in Cmds : applyCount[c] <= 1

(* Every logged transition obeys its intent's contract. Contract is written
   INDEPENDENTLY of Apply/Snap - double-entry bookkeeping: if either side
   drifts (a seek that flips playing, a snapshot that moves the projection),
   TLC reports the disagreement. *)
Contract(pre, e, post) ==
  /\ post.seq = pre.seq + 1
  /\ post.anchor = e.t
  /\ IF e.kind = "snap"
     THEN /\ post.playing = pre.playing
          /\ post.pos = Projection(pre, e.t)   \* re-anchor moves nothing
     ELSE IF e.intent = "play"  THEN post.playing /\ post.pos = e.pos
     ELSE IF e.intent = "pause" THEN ~post.playing /\ post.pos = e.pos
     ELSE (* seek *) post.playing = pre.playing /\ post.pos = e.pos

RECURSIVE ContractHoldsFrom(_, _)
ContractHoldsFrom(s, entries) ==
  IF entries = << >> THEN TRUE
  ELSE /\ Contract(s, Head(entries), ApplyEntry(s, Head(entries)))
       /\ ContractHoldsFrom(ApplyEntry(s, Head(entries)), Tail(entries))

TransitionContract == ContractHoldsFrom(InitStore, log)

(* Folding the log from the initial state reproduces live state exactly. *)
ReplayReconstructs == ReplayFrom(InitStore, log) = store

(* Bookkeeping consistency: an acked command was applied; with the guard on
   and no eviction possible yet, applied commands are remembered. *)
AckedWasApplied == \A c \in acked : applyCount[c] >= 1

(***************************************************************************)
(* Liveness: every issued command is eventually applied exactly once and   *)
(* the client learns it. Holds only with the guard on and safe eviction.   *)
(***************************************************************************)
EventuallyExactlyOnce ==
  \A c \in Cmds :
    (intentOf[c] # "unissued") ~> (applyCount[c] = 1 /\ c \in acked)

===============================================================================
