# Exactly-once: duplicate-injection proof runs

The idempotency-key design (SYNC_DESIGN §2a, `formal/SyncExactlyOnce.tla`)
proven end-to-end by **app-level injection**: the bot fleet's
`--dup-controls` mode sends every scripted control **twice with the same
`cmdId`**. Injection is the only honest way to test this — netem's
`duplicate` toxic copies TCP segments, which TCP itself dedupes, so no
transport toxic can ever produce an application-level duplicate.

| run | plane | bots | injected dups | seq gaps | dups absorbed |
|---|---|---|---|---|---|
| `node-25bots-dup-injection.json` | node / 3-instance lab / nginx | 25 | 4 | **0** | 4 |
| `relay-5bots-dup-injection.json` | relay-go / raw-WS binary | 5 | 4 | **0** | 4 |

What "absorbed" means, per plane:

- **node**: the servers' `control_dedup_hits_total` advanced by exactly 4
  during the run (scraped from the instance that held the commanding
  sockets), and no phantom seq appeared — `seqGaps: 0` with the reorder and
  duplicate counters showing only the expected local re-anchor traffic.
- **relay**: each duplicate was answered as a targeted re-anchor carrying
  the already-committed seq (`seqDuplicates: 4` on a single-instance plane
  that otherwise produces none), through the extended binary control frame
  — same Lua, same dedup, cross-language.

Both summaries carry `gitSha` (clean — the stamp appends `-dirty` when the
tree does not match) and hardware. A failed double-apply would surface as a
phantom seq: a commit consumed by the duplicate that the room's clients
observe as a gap. Before this design, the ioredis resend path produced
exactly those (see SYNC_DESIGN §2a).
