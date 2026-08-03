# Demo script (90 seconds)

Two devices side by side (laptop + phone works best on camera).

1. **Create & join** (0:00–0:20): log in on device A, create a room with a
   YouTube URL, open the shared link on device B. B lands paused at the
   room's position.
2. **Sync** (0:20–0:50): press play on A — both start together
   (wait-for-broadcast: A doesn't start early). Scrub the progress bar;
   both land on the target within a second. Add `?debug=1` on one device:
   the HUD shows live drift (double-digit ms), clock offset ±uncertainty,
   RTT, controller state.
3. **Resilience** (0:50–1:20): toggle wifi off on B for ~20s — playback
   free-runs; toggle it back — B reconnects, re-bursts its clock, and
   converges with a single catch-up seek (watch the HUD state go
   SEEKING → LOCKED). Kill nothing on A; the room never stalls (P2).
4. **Close** (1:20–1:30): pause on A — B freezes on the same frame (P4).

Record with QuickTime/Kap → `assets/demo.gif` (<10MB, README hero).
The same flow against the local lab: `docs/DEVELOPMENT.md`.
