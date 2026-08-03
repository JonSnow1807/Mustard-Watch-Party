---- MODULE SyncTimeline_TTrace_1785773284 ----
EXTENDS Sequences, TLCExt, SyncTimeline, SyncTimeline_TEConstants, Toolbox, Naturals, TLC

_expression ==
    LET SyncTimeline_TEExpression == INSTANCE SyncTimeline_TEExpression
    IN SyncTimeline_TEExpression!expression
----

_trace ==
    LET SyncTimeline_TETrace == INSTANCE SyncTimeline_TETrace
    IN SyncTimeline_TETrace!trace
----

_inv ==
    ~(
        TLCGet("level") = Len(_TETrace)
        /\
        deadEpochs = ((c1 :> {0, 2} @@ c2 :> {}))
        /\
        applied = ((c1 :> [epoch |-> 1, seq |-> 1] @@ c2 :> [epoch |-> 0, seq |-> 0]))
        /\
        storeSeq = (1)
        /\
        storeEpoch = (2)
        /\
        network = ({[epoch |-> 1, seq |-> 1, dst |-> c2], [epoch |-> 2, seq |-> 1, dst |-> c2]})
    )
----

_init ==
    /\ storeSeq = _TETrace[1].storeSeq
    /\ network = _TETrace[1].network
    /\ applied = _TETrace[1].applied
    /\ deadEpochs = _TETrace[1].deadEpochs
    /\ storeEpoch = _TETrace[1].storeEpoch
----

_next ==
    /\ \E i,j \in DOMAIN _TETrace:
        /\ \/ /\ j = i + 1
              /\ i = TLCGet("level")
        /\ storeSeq  = _TETrace[i].storeSeq
        /\ storeSeq' = _TETrace[j].storeSeq
        /\ network  = _TETrace[i].network
        /\ network' = _TETrace[j].network
        /\ applied  = _TETrace[i].applied
        /\ applied' = _TETrace[j].applied
        /\ deadEpochs  = _TETrace[i].deadEpochs
        /\ deadEpochs' = _TETrace[j].deadEpochs
        /\ storeEpoch  = _TETrace[i].storeEpoch
        /\ storeEpoch' = _TETrace[j].storeEpoch

\* Uncomment the ASSUME below to write the states of the error trace
\* to the given file in Json format. Note that you can pass any tuple
\* to `JsonSerialize`. For example, a sub-sequence of _TETrace.
    \* ASSUME
    \*     LET J == INSTANCE Json
    \*         IN J!JsonSerialize("SyncTimeline_TTrace_1785773284.json", _TETrace)

=============================================================================

 Note that you can extract this module `SyncTimeline_TEExpression`
  to a dedicated file to reuse `expression` (the module in the 
  dedicated `SyncTimeline_TEExpression.tla` file takes precedence 
  over the module `SyncTimeline_TEExpression` below).

---- MODULE SyncTimeline_TEExpression ----
EXTENDS Sequences, TLCExt, SyncTimeline, SyncTimeline_TEConstants, Toolbox, Naturals, TLC

expression == 
    [
        \* To hide variables of the `SyncTimeline` spec from the error trace,
        \* remove the variables below.  The trace will be written in the order
        \* of the fields of this record.
        storeSeq |-> storeSeq
        ,network |-> network
        ,applied |-> applied
        ,deadEpochs |-> deadEpochs
        ,storeEpoch |-> storeEpoch
        
        \* Put additional constant-, state-, and action-level expressions here:
        \* ,_stateNumber |-> _TEPosition
        \* ,_storeSeqUnchanged |-> storeSeq = storeSeq'
        
        \* Format the `storeSeq` variable as Json value.
        \* ,_storeSeqJson |->
        \*     LET J == INSTANCE Json
        \*     IN J!ToJson(storeSeq)
        
        \* Lastly, you may build expressions over arbitrary sets of states by
        \* leveraging the _TETrace operator.  For example, this is how to
        \* count the number of times a spec variable changed up to the current
        \* state in the trace.
        \* ,_storeSeqModCount |->
        \*     LET F[s \in DOMAIN _TETrace] ==
        \*         IF s = 1 THEN 0
        \*         ELSE IF _TETrace[s].storeSeq # _TETrace[s-1].storeSeq
        \*             THEN 1 + F[s-1] ELSE F[s-1]
        \*     IN F[_TEPosition - 1]
    ]

=============================================================================



Parsing and semantic processing can take forever if the trace below is long.
 In this case, it is advised to uncomment the module below to deserialize the
 trace from a generated binary file.

\*
\*---- MODULE SyncTimeline_TETrace ----
\*EXTENDS IOUtils, SyncTimeline, SyncTimeline_TEConstants, TLC
\*
\*trace == IODeserialize("SyncTimeline_TTrace_1785773284.bin", TRUE)
\*
\*=============================================================================
\*

---- MODULE SyncTimeline_TETrace ----
EXTENDS SyncTimeline, SyncTimeline_TEConstants, TLC

trace == 
    <<
    ([deadEpochs |-> (c1 :> {} @@ c2 :> {}),applied |-> (c1 :> [epoch |-> 0, seq |-> 0] @@ c2 :> [epoch |-> 0, seq |-> 0]),storeSeq |-> 0,storeEpoch |-> 1,network |-> {}]),
    ([deadEpochs |-> (c1 :> {} @@ c2 :> {}),applied |-> (c1 :> [epoch |-> 0, seq |-> 0] @@ c2 :> [epoch |-> 0, seq |-> 0]),storeSeq |-> 1,storeEpoch |-> 1,network |-> {[epoch |-> 1, seq |-> 1, dst |-> c1], [epoch |-> 1, seq |-> 1, dst |-> c2]}]),
    ([deadEpochs |-> (c1 :> {} @@ c2 :> {}),applied |-> (c1 :> [epoch |-> 0, seq |-> 0] @@ c2 :> [epoch |-> 0, seq |-> 0]),storeSeq |-> 1,storeEpoch |-> 2,network |-> {[epoch |-> 1, seq |-> 1, dst |-> c1], [epoch |-> 1, seq |-> 1, dst |-> c2], [epoch |-> 2, seq |-> 1, dst |-> c1], [epoch |-> 2, seq |-> 1, dst |-> c2]}]),
    ([deadEpochs |-> (c1 :> {0} @@ c2 :> {}),applied |-> (c1 :> [epoch |-> 2, seq |-> 1] @@ c2 :> [epoch |-> 0, seq |-> 0]),storeSeq |-> 1,storeEpoch |-> 2,network |-> {[epoch |-> 1, seq |-> 1, dst |-> c1], [epoch |-> 1, seq |-> 1, dst |-> c2], [epoch |-> 2, seq |-> 1, dst |-> c2]}]),
    ([deadEpochs |-> (c1 :> {0, 2} @@ c2 :> {}),applied |-> (c1 :> [epoch |-> 1, seq |-> 1] @@ c2 :> [epoch |-> 0, seq |-> 0]),storeSeq |-> 1,storeEpoch |-> 2,network |-> {[epoch |-> 1, seq |-> 1, dst |-> c2], [epoch |-> 2, seq |-> 1, dst |-> c2]}])
    >>
----


=============================================================================

---- MODULE SyncTimeline_TEConstants ----
EXTENDS SyncTimeline

CONSTANTS c1, c2

=============================================================================

---- CONFIG SyncTimeline_TTrace_1785773284 ----
CONSTANTS
    Clients = { c1 , c2 }
    MaxSeq = 3
    MaxEpoch = 2
    ClientRule = "deadepochs"
    c2 = c2
    c1 = c1

INVARIANT
    _inv

CHECK_DEADLOCK
    \* CHECK_DEADLOCK off because of PROPERTY or INVARIANT above.
    FALSE

INIT
    _init

NEXT
    _next

CONSTANT
    _TETrace <- _trace

ALIAS
    _expression
=============================================================================
\* Generated on Mon Aug 03 11:08:05 CDT 2026