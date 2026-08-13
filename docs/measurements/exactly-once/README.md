# Exactly-once: duplicate- and reorder-injection proof runs

The idempotency-key design (SYNC_DESIGN §2a, `formal/SyncExactlyOnce.tla`)
proven end-to-end by **app-level injection**, two modes composable in one
run:

- `--dup-controls`: every scripted control sent **twice with the same
  `cmdId`**.
- `--reorder-controls`: a seek pair minted **(A=500, B=520)** and emitted
  **(B, A)**. The store serializes by arrival, so A must commit LAST — and
  every bot's `lastSeekMediaTime` is gated to sit at A's position,
  fleet-wide. The witness doubles as the injection's own liveness check:
  if the swap is ever "fixed" upstream, the witness lands on B and the
  gate names the injection as dead instead of silently measuring nothing.

Injection is the only honest way to test either — netem's `duplicate` and
`reorder` toxics operate on TCP segments, which TCP itself dedupes and
re-sequences, so no transport toxic can ever produce an application-level
duplicate or reordering.

| run | plane | bots | injected dups | seq gaps | dups absorbed |
|---|---|---|---|---|---|
| `node-25bots-dup-injection.json` | node / 3-instance lab / nginx | 25 | 4 | **0** | 4 |
| `relay-5bots-dup-injection.json` | relay-go / raw-WS binary | 5 | 4 | **0** | 4 |
| `node-10bots-dup-reorder-chaos.json` | node / single instance | 10 | 6 | **0** | 6 + 1 swapped pair |

What "absorbed" means, per plane:

- **node**: the servers' `control_dedup_hits_total` advanced by exactly 4
  during the run, and the **commit-count invariant** held:
  `controlCommitsObserved == scriptedControls` (4 == 4). That equality is
  the proof of deduplication — a duplicate that committed would mint the
  *next contiguous* seq, so `seqGaps: 0` alone can never show it; the gap
  counter is kept as a separate delivery-ordering check, not as dedup
  evidence.
- **relay**: each duplicate was answered as a targeted re-anchor carrying
  the already-committed seq (`seqDuplicates: 4` on a single-instance plane
  that otherwise produces none), through the extended binary control frame
  — same Lua, same dedup, cross-language.

The chaos run composes both modes: every control's same-`cmdId` twin AND a
swapped seek pair in one fleet. Its gates: exact commit-count equality both
directions (6 commands, 6 commits - the pair's members each committed once,
their twins never), and the fleet-wide witness that the FIRST-minted seek
committed last (every bot's `lastSeekMediaTime` at 500). `replay-check`
ran immediately after and PASSED: with duplicates and reordering injected,
every room's log still replays exactly to live state. Nightly now runs this
same chaos fleet and post-chaos reconciliation on every build.

All summaries carry `gitSha` (clean — the stamp appends `-dirty` when the
tree does not match) and hardware. A failed double-apply would surface as a
phantom seq: a commit consumed by the duplicate that the room's clients
observe as a gap. Before this design, the ioredis resend path produced
exactly those (see SYNC_DESIGN §2a).

## Replay reconciliation (`replay-reconciliation.json`)

The same injection scenario re-run against a fresh keyspace on the
command-log build (`node-25bots-dup-injection-with-log.json`, clean SHA),
then `replay-check.ts` over the append-only logs that traffic produced:
**12 retained entries, 11 transitions checked, 0 contract violations, 0
drift rooms — drift rate 0**. Every retained transition satisfies its
intent's contract (a spec-derived double-entry check), the deduplicated
deliveries appear nowhere in the log (commits, not deliveries), and the
newest entry is field-for-field identical to the live state. The nightly
runs this same reconciliation, gated, over the 50-bot fleet's traffic.
