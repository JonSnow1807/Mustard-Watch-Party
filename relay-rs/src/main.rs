//! relay-rs — a THIRD conformance implementation of the mustard sync plane.
//!
//! The point of this binary is not to be faster (relay-go already tied the
//! Node plane, because sync drift is bounded by the protocol and the network,
//! not the runtime). It is a study, and a third independent implementation of
//! the TLA+-checked protocol: it speaks the SAME binary frames as relay-go,
//! runs the SAME Redis Lua scripts against the same Redis, and enforces the
//! same JWT and revocation rules. Three codebases that must agree on every
//! byte of state is a stronger conformance check than two, and being written
//! in a GC-free language stresses the spec differently than either GC'd plane.
//!
//! Faithfulness to relay-go is deliberate down to the comments: where the Go
//! version made a decision (strict frame lengths, close-the-socket-not-the-
//! channel eviction, room-name charset), this one makes the identical one, so
//! a divergence in a conformance run means a real bug, not a design choice
//! taken two different ways.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, RwLock as StdRwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use redis::aio::ConnectionManager;
use redis::AsyncCommands;
use serde::Deserialize;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Mutex, Notify, RwLock};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::Message;

// ---- constants, mirrored from relay-go ----

/// Mirror of CMD_DEDUP_TTL_MS: a correctness parameter
/// (formal/SyncExactlyOnce.tla earlyevict), far above every redelivery window.
const CMD_DEDUP_TTL_MS: i64 = 15 * 60 * 1000;
const SWEEP_DEDUP_PERIOD_MS: i64 = 10_000;
const SWEEP_INTERVAL: Duration = Duration::from_secs(10);

/// How often the revocation sweep re-checks live connections and closes ones
/// whose token expired — matches relay-go and the backend's staleness bound.
const REVOCATION_SWEEP_INTERVAL: Duration = Duration::from_secs(30);

const REVOKED_JTI_KEY: &str = "revoked:jti";
const REVOKED_USERVER_KEY: &str = "revoked:userver";
const REVOCATION_CHANNEL: &str = "mustard:revocations";

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1000.0
}

/// Reason string -> wire code, mirroring relay-go's reasonCodes.
fn reason_code(reason: &str) -> u8 {
    match reason {
        "play" => 0,
        "pause" => 1,
        "seek" => 2,
        "join" => 3,
        "snapshot" => 4,
        "succession" => 5,
        // relay-go does `reasonCodes[t.Reason]`, and a Go map returns the
        // uint8 ZERO for a missing key - which is 0, not 3. A real reason like
        // "set-video" is absent from the map on BOTH planes, so both must emit
        // 0 for it or the wire byte at offset 30 diverges on identical state.
        _ => 0,
    }
}

/// cmdId AND room charset: bounded, separator-free, so the derived Redis key
/// `room:<room>:cmd:<cmdId>` cannot alias another keyspace. Same rule as the
/// Node gateway and relay-go.
fn is_valid_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

// ---- the timeline the Lua scripts return, and its wire form ----

#[derive(Deserialize)]
struct LuaTimeline {
    seq: i64,
    #[serde(rename = "storeEpoch")]
    store_epoch: String,
    #[serde(rename = "isPlaying")]
    is_playing: bool,
    #[serde(rename = "mediaTime")]
    media_time: f64,
    #[serde(rename = "stampedAt")]
    stamped_at: f64,
    reason: String,
    /// set by apply_control.lua when the cmdId was already applied: answer the
    /// sender only, never rebroadcast.
    #[serde(default)]
    dup: bool,
}

/// Encode a timeline into the 31-byte 0x04/0x06 frame, byte-for-byte identical
/// to relay-go's encodeTimeline. Little-endian throughout.
fn encode_timeline(msg_type: u8, tl: &LuaTimeline) -> Vec<u8> {
    let mut buf = vec![0u8; 1 + 4 + 8 + 1 + 8 + 8 + 1];
    buf[0] = msg_type;
    let epoch: f64 = tl.store_epoch.parse().unwrap_or(0.0);
    buf[1..5].copy_from_slice(&(tl.seq as u32).to_le_bytes());
    buf[5..13].copy_from_slice(&epoch.to_bits().to_le_bytes());
    if tl.is_playing {
        buf[13] = 1;
    }
    buf[14..22].copy_from_slice(&tl.media_time.to_bits().to_le_bytes());
    buf[22..30].copy_from_slice(&tl.stamped_at.to_bits().to_le_bytes());
    buf[30] = reason_code(&tl.reason);
    buf
}

/// Decode a 0x03 Control frame. STRICT on length exactly as relay-go's
/// parseControl: a legacy frame ends at the room, a suffixed frame ends at the
/// cmdId, and trailing bytes are a malformed frame rather than padding.
///
///   [0]=0x03 [1]=intent u8 [2..10]=mediaTime f64 [10]=roomLen [11..11+n]=room
///   optionally [11+n]=cmdLen [12+n..]=cmdId
fn parse_control(data: &[u8]) -> Option<(&'static str, f64, String, String)> {
    if data.len() < 11 {
        return None;
    }
    // validate rather than coerce: a garbage intent byte or a NaN/Inf/negative
    // mediaTime would poison the timeline.
    let intent = match data[1] {
        0 => "play",
        1 => "pause",
        2 => "seek",
        _ => return None,
    };
    let media_time = f64::from_le_bytes(data[2..10].try_into().ok()?);
    if !media_time.is_finite() || media_time < 0.0 {
        return None;
    }
    let n = data[10] as usize;
    if data.len() < 11 + n {
        return None;
    }
    let room = String::from_utf8(data[11..11 + n].to_vec()).ok()?;
    if data.len() == 11 + n {
        return Some((intent, media_time, room, String::new())); // legacy: ends at room
    }
    let cl = data[11 + n] as usize;
    if cl == 0 || cl > 64 || data.len() != 12 + n + cl {
        return None;
    }
    let cmd_id = String::from_utf8(data[12 + n..12 + n + cl].to_vec()).ok()?;
    if !is_valid_id(&cmd_id) {
        return None;
    }
    Some((intent, media_time, room, cmd_id))
}

// ---- identity & revocation ----

#[derive(Clone)]
struct Identity {
    sub: String,
    jti: Option<String>,
    ver: i64,
    /// unix seconds
    exp: i64,
}

#[derive(Deserialize)]
struct Claims {
    sub: Option<String>,
    jti: Option<String>,
    // `ver` may be absent (version 0) or a non-negative integer; anything else
    // is malformed and refused, matching relay-go/identityFromClaims.
    ver: Option<serde_json::Value>,
    exp: Option<i64>,
}

/// Extract identity with the same tolerances as the Node and Go planes: a
/// subject is REQUIRED (a valid signature is not an identity), jti is optional
/// (no jti -> not individually revocable), ver absent -> 0, and a fractional or
/// negative ver is a refusal, not a zero.
fn identity_from_claims(c: Claims) -> Option<Identity> {
    let sub = c.sub.filter(|s| !s.is_empty())?;
    let exp = c.exp?;
    let ver = match c.ver {
        None => 0,
        Some(serde_json::Value::Number(n)) => {
            let f = n.as_f64()?;
            if f.fract() != 0.0 || f < 0.0 {
                return None;
            }
            f as i64
        }
        Some(_) => return None,
    };
    Some(Identity {
        sub,
        jti: c.jti,
        ver,
        exp,
    })
}

#[derive(Deserialize)]
struct RevocationEvent {
    kind: String,
    #[serde(default)]
    jti: Option<String>,
    #[serde(default, rename = "userId")]
    user_id: Option<String>,
    #[serde(default)]
    version: Option<i64>,
}

// ---- server state ----

/// Bounded, like relay-go's 256-slot channel: a slow or dead reader must
/// not let the room's traffic pile up without limit in this connection's
/// queue. A full queue drops (broadcast) or disconnects (direct replies),
/// never grows.
const SEND_BUFFER: usize = 256;
type Tx = mpsc::Sender<Message>;

/// One connected client. `tx` is the write half; the read task owns the socket.
struct Conn {
    id: u64,
    tx: Tx,
    room: Mutex<Option<String>>,
    identity: Identity,
    /// Fired by eviction to end the READ loop. relay-go's evict closes the
    /// socket, which stops the reader; enqueuing a Close frame does not, so a
    /// revoked client that ignores the Close could keep sending Control frames
    /// and mutating Redis. This signal makes the read loop break deterministically.
    close_signal: Arc<Notify>,
}

struct Server {
    redis: ConnectionManager,
    jwt_secret: Vec<u8>,
    lua_dir: String,
    apply_control: redis::Script,
    init_room: redis::Script,
    apply_snapshot: redis::Script,
    /// rooms -> the conns in them, for broadcast.
    rooms: RwLock<HashMap<String, HashMap<u64, Arc<Conn>>>>,
    /// EVERY authenticated connection, joined or not — a connection that never
    /// joined is exactly the one a revocation sweep must still be able to find.
    conns: RwLock<HashMap<u64, Arc<Conn>>>,
    /// In-memory revocation snapshot, so the accept path (and the sweep) can
    /// decide with NO Redis round-trip - checked from the synchronous
    /// handshake callback, which cannot await. Same design as the Node
    /// backend's RevocationService: Postgres/Redis is the truth, this is the
    /// hot-path cache, refreshed on a timer and updated by pub/sub.
    revoked_jti: StdRwLock<HashSet<String>>,
    user_versions: StdRwLock<HashMap<String, i64>>,
    /// Revocations that pub/sub delivered WHILE a refresh was in flight. A
    /// refresh reads Redis then replaces the snapshot; anything revoked
    /// between the read and the replace would be lost. This is the identical
    /// bug the Node RevocationService had and fixed - carried here by porting
    /// the pre-fix design, and now fixed the same way.
    refreshing: AtomicBool,
    pending_jti: StdRwLock<HashSet<String>>,
    pending_versions: StdRwLock<HashMap<String, i64>>,
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

impl Server {
    /// Is this identity refused by the in-memory snapshot? Synchronous and
    /// lock-only, so it can run inside the handshake callback that decides
    /// accept-or-401 before a single frame is exchanged.
    fn revoked(&self, id: &Identity) -> bool {
        if let Some(jti) = &id.jti {
            if self.revoked_jti.read().unwrap().contains(jti) {
                return true;
            }
        }
        if let Some(&v) = self.user_versions.read().unwrap().get(&id.sub) {
            if id.ver < v {
                return true;
            }
        }
        false
    }

    /// Rebuild the snapshot from Redis - the periodic floor under pub/sub, and
    /// the recovery path for an instance that started while a message was in
    /// flight. Fails soft: on a Redis error the previous snapshot stands,
    /// which is stale rather than wrong.
    async fn refresh_snapshot(&self) {
        // Mark a refresh in flight so the pub/sub handler tees concurrent
        // revocations into the pending buffers; merge them at the end so a
        // revocation that landed mid-refresh is not overwritten by the stale
        // read. Exactly the Node RevocationService fix, ported.
        self.refreshing.store(true, Ordering::SeqCst);
        self.pending_jti.write().unwrap().clear();
        self.pending_versions.write().unwrap().clear();

        let mut r = self.redis.clone();
        let jtis = r.smembers::<_, Vec<String>>(REVOKED_JTI_KEY).await;
        let pairs = r
            .hgetall::<_, HashMap<String, String>>(REVOKED_USERVER_KEY)
            .await;

        // Merge + replace UNDER the live write lock. That lock is the
        // serialization point against remember_*, which also holds it across
        // its live-and-pending writes. A first version pending-buffered but
        // still lost a revocation to one interleaving: remember wrote live,
        // then refresh replaced live wholesale, and remember's pending insert
        // arrived after the merge had already read pending. Holding the live
        // lock across (read pending -> replace) here, and across (insert live
        // -> insert pending) there, closes it in both orders. The async Redis
        // reads above already happened without any lock held.
        if let Ok(jtis) = jtis {
            let mut live = self.revoked_jti.write().unwrap();
            let mut next: HashSet<String> = jtis.into_iter().collect();
            for j in self.pending_jti.read().unwrap().iter() {
                next.insert(j.clone()); // union: never drop a mid-refresh revoke
            }
            *live = next;
        }
        if let Ok(pairs) = pairs {
            let mut live = self.user_versions.write().unwrap();
            let mut next: HashMap<String, i64> = pairs
                .into_iter()
                .filter_map(|(k, v)| v.parse::<i64>().ok().map(|n| (k, n)))
                .collect();
            for (id, &v) in self.pending_versions.read().unwrap().iter() {
                // the HIGHER: a version must never move backwards.
                let cur = next.get(id).copied().unwrap_or(0);
                next.insert(id.clone(), cur.max(v));
            }
            *live = next;
        }

        self.refreshing.store(false, Ordering::SeqCst);
        self.pending_jti.write().unwrap().clear();
        self.pending_versions.write().unwrap().clear();
    }

    /// Record a revoked jti. The pending insert happens WHILE the live lock is
    /// held, so it cannot land between refresh's read-of-pending and its
    /// replacement: either remember runs first (refresh then sees jti in
    /// pending and merges it) or refresh runs first (remember's live insert
    /// survives the replacement, since it is already done).
    fn remember_jti(&self, jti: &str) {
        let mut live = self.revoked_jti.write().unwrap();
        live.insert(jti.to_string());
        if self.refreshing.load(Ordering::SeqCst) {
            self.pending_jti.write().unwrap().insert(jti.to_string());
        }
    }

    /// Same for a user version, and never downward. Both writes under the live
    /// lock, same reason as remember_jti.
    fn remember_version(&self, user: &str, v: i64) {
        let mut live = self.user_versions.write().unwrap();
        if v > live.get(user).copied().unwrap_or(0) {
            live.insert(user.to_string(), v);
        }
        if self.refreshing.load(Ordering::SeqCst) {
            let mut p = self.pending_versions.write().unwrap();
            if v > p.get(user).copied().unwrap_or(0) {
                p.insert(user.to_string(), v);
            }
        }
    }

    async fn join_room(&self, c: &Arc<Conn>, room: &str) {
        let mut rooms = self.rooms.write().await;
        let mut cur = c.room.lock().await;
        if let Some(prev) = cur.take() {
            if let Some(m) = rooms.get_mut(&prev) {
                m.remove(&c.id);
                if m.is_empty() {
                    rooms.remove(&prev);
                }
            }
        }
        rooms
            .entry(room.to_string())
            .or_default()
            .insert(c.id, c.clone());
        *cur = Some(room.to_string());
    }

    async fn leave(&self, c: &Arc<Conn>) {
        let mut rooms = self.rooms.write().await;
        let mut cur = c.room.lock().await;
        if let Some(prev) = cur.take() {
            if let Some(m) = rooms.get_mut(&prev) {
                m.remove(&c.id);
                if m.is_empty() {
                    rooms.remove(&prev);
                }
            }
        }
    }

    async fn broadcast(&self, room: &str, frame: Vec<u8>) {
        let rooms = self.rooms.read().await;
        if let Some(m) = rooms.get(room) {
            for peer in m.values() {
                // try_send: a full buffer (slow reader) or gone receiver drops
                // the frame rather than blocking or growing - the 10s sweep
                // repairs it, exactly as relay-go's trySend does on broadcast.
                let _ = peer.tx.try_send(Message::Binary(frame.clone()));
            }
        }
    }

    /// Close a connection and ONLY the connection. The write task owns the
    /// channel and the socket; dropping the tx (by removing every Arc<Conn>)
    /// or sending Close makes the write half finish, which ends the read task.
    /// This mirrors relay-go's "close the ws, never the send channel" rule.
    fn evict(conn: &Conn) {
        // Two half-measures that together are whole: the Close frame is the
        // graceful goodbye the client sees, and the notify ends the READ loop
        // even if the client ignores the Close - so a revoked client cannot
        // keep sending frames, and the Conn is removed from the maps
        // deterministically rather than leaking until the client chooses to go.
        let _ = conn.tx.try_send(Message::Close(None));
        conn.close_signal.notify_one();
    }
}

// ---- eviction: pub/sub + periodic sweep ----

/// Close every live connection a revocation event names. Strictly-less on
/// version, so the session that did the signing-out (a token AT the new
/// version) does not evict itself. A user event with no version selects
/// nobody — zero is where every account starts.
async fn evict_revoked(server: &Arc<Server>, ev: &RevocationEvent) -> usize {
    let conns = server.conns.read().await;
    let mut closed = 0;
    for c in conns.values() {
        let hit = match ev.kind.as_str() {
            "token" => ev
                .jti
                .as_ref()
                .zip(c.identity.jti.as_ref())
                .map(|(a, b)| a == b)
                .unwrap_or(false),
            "user" => {
                ev.version.unwrap_or(0) > 0
                    && ev.user_id.as_deref() == Some(c.identity.sub.as_str())
                    && c.identity.ver < ev.version.unwrap_or(0)
            }
            _ => false,
        };
        if hit {
            Server::evict(c);
            closed += 1;
        }
    }
    closed
}

/// Apply one revocation message to the snapshot and evict matching sockets.
async fn apply_revocation_message(server: &Arc<Server>, payload: &str) {
    let ev = match serde_json::from_str::<RevocationEvent>(payload) {
        Ok(ev) => ev,
        Err(_) => return,
    };
    // snapshot first, so a token revoked a moment ago is refused at accept
    // before the next timed refresh; then close live connections.
    match ev.kind.as_str() {
        "token" => {
            if let Some(jti) = &ev.jti {
                server.remember_jti(jti);
            }
        }
        "user" => {
            if let (Some(uid), Some(v)) = (&ev.user_id, ev.version) {
                if v > 0 {
                    server.remember_version(uid, v);
                }
            }
        }
        _ => {}
    }
    let n = evict_revoked(server, &ev).await;
    if n > 0 {
        println!("revocation: closed {n} connection(s)");
    }
}

/// Subscribe to the revocation channel and consume it until the stream ends,
/// which redis-rs signals on a dropped connection. Returns so the caller can
/// reconnect. Failures are LOGGED rather than silently swallowed - a dead
/// pub/sub subscription degrades revocation to the 30s snapshot refresh, which
/// is a real latency change worth a log line.
async fn consume_revocations(server: &Arc<Server>, redis_url: &str) {
    let client = match redis::Client::open(redis_url) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("revocation pub/sub: client open failed: {e}");
            return;
        }
    };
    let mut pubsub = match client.get_async_pubsub().await {
        Ok(p) => p,
        Err(e) => {
            eprintln!("revocation pub/sub: connect failed: {e}");
            return;
        }
    };
    if let Err(e) = pubsub.subscribe(REVOCATION_CHANNEL).await {
        eprintln!("revocation pub/sub: subscribe failed: {e}");
        return;
    }
    let mut stream = pubsub.on_message();
    while let Some(msg) = stream.next().await {
        if let Ok(payload) = msg.get_payload::<String>() {
            apply_revocation_message(server, &payload).await;
        }
    }
    eprintln!("revocation pub/sub: stream ended (connection dropped)");
}

async fn revocation_loop(server: Arc<Server>, redis_url: String) {
    // Reconnecting pub/sub: on a dropped connection the stream ends, and this
    // re-subscribes after a short backoff. The 30s snapshot refresh below is
    // the floor if pub/sub is down entirely, so revocation stays correct -
    // just slower - across a Redis blip.
    {
        let srv = server.clone();
        let url = redis_url.clone();
        tokio::spawn(async move {
            loop {
                consume_revocations(&srv, &url).await;
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        });
    }

    // the periodic floor: refreshes the snapshot (catching missed pub/sub
    // events), and closes connections whose token has simply expired — a
    // connection is authenticated once at accept and would otherwise outlive
    // its token.
    server.refresh_snapshot().await;
    let mut ticker = tokio::time::interval(REVOCATION_SWEEP_INTERVAL);
    loop {
        ticker.tick().await;
        server.refresh_snapshot().await;
        let now = (now_ms() / 1000.0) as i64;
        let snapshot: Vec<Arc<Conn>> = server.conns.read().await.values().cloned().collect();
        let mut closed = 0;
        for c in snapshot {
            if c.identity.exp <= now || server.revoked(&c.identity) {
                Server::evict(&c);
                closed += 1;
            }
        }
        if closed > 0 {
            println!("revocation sweep: closed {closed} connection(s)");
        }
    }
}

// ---- the 10s snapshot sweep (the repair channel) ----

async fn snapshot_sweep(server: Arc<Server>) {
    let mut ticker = tokio::time::interval(SWEEP_INTERVAL);
    loop {
        ticker.tick().await;
        let rooms: Vec<String> = server.rooms.read().await.keys().cloned().collect();
        for room in rooms {
            let mut r = server.redis.clone();
            let res: redis::RedisResult<String> = server
                .apply_snapshot
                .key(format!("room:{room}:tl"))
                .key(format!("room:{room}:log"))
                .arg(SWEEP_DEDUP_PERIOD_MS)
                .invoke_async(&mut r)
                .await;
            if let Ok(raw) = res {
                if let Ok(tl) = serde_json::from_str::<LuaTimeline>(&raw) {
                    if tl.is_playing {
                        server.broadcast(&room, encode_timeline(0x04, &tl)).await;
                    }
                }
            }
        }
    }
}

// ---- per-connection handling ----

// The handshake callback must return tungstenite's Result<Response,
// ErrorResponse>; ErrorResponse is an http::Response and is not ours to box.
#[allow(clippy::result_large_err)]
async fn handle(server: Arc<Server>, stream: TcpStream) {
    // Authenticate INSIDE the handshake callback and reject with a real 401
    // there, before the upgrade completes - so a bad or revoked token is
    // refused at accept exactly as relay-go refuses it, never opening a
    // socket the client then has to notice was closed. Everything the check
    // needs is synchronous: JWT verification is CPU-only, and revocation is
    // read from the in-memory snapshot rather than Redis.
    let mut identity: Option<Identity> = None;
    let srv = server.clone();
    let callback = |req: &Request, resp: Response| {
        let token = req.uri().query().and_then(|q| {
            q.split('&')
                .find_map(|pair| pair.strip_prefix("token=").map(urldecode))
        });
        match token.and_then(|t| verify(&srv.jwt_secret, &t)) {
            Some(id) if !srv.revoked(&id) => {
                identity = Some(id);
                Ok(resp)
            }
            _ => Err(unauthorized()),
        }
    };

    let ws = match tokio_tungstenite::accept_hdr_async(stream, callback).await {
        Ok(ws) => ws,
        Err(_) => return,
    };
    // present because the callback set it before returning Ok; a rejected
    // handshake never reaches here.
    let identity = match identity {
        Some(id) => id,
        None => return,
    };

    let (mut write, mut read) = ws.split();
    let (tx, mut rx) = mpsc::channel::<Message>(SEND_BUFFER);

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let close_signal = Arc::new(Notify::new());
    let conn = Arc::new(Conn {
        id,
        tx: tx.clone(),
        room: Mutex::new(None),
        identity,
        close_signal: close_signal.clone(),
    });
    server.conns.write().await.insert(id, conn.clone());

    // write task: drains the channel to the socket. Ends when the channel
    // closes (every tx dropped) or a Close message is sent.
    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let is_close = matches!(msg, Message::Close(_));
            if write.send(msg).await.is_err() {
                break;
            }
            if is_close {
                break;
            }
        }
        let _ = write.close().await;
    });

    // read loop. select! so eviction (close_signal) ends it even when the
    // client ignores the Close frame - egress alone is not revocation.
    loop {
        let msg = tokio::select! {
            biased;
            _ = close_signal.notified() => break,
            m = read.next() => match m {
                Some(Ok(m)) => m,
                _ => break,
            },
        };
        let data = match msg {
            Message::Binary(b) => b,
            Message::Close(_) => break,
            _ => continue,
        };
        if data.is_empty() {
            continue;
        }
        // INGRESS revocation gate: a token revoked or expired since accept must
        // not keep driving the room in the window before the sweep evicts it.
        // The snapshot check is synchronous and cheap.
        let now = (now_ms() / 1000.0) as i64;
        if conn.identity.exp <= now || server.revoked(&conn.identity) {
            break;
        }
        match data[0] {
            0x01 => {
                // ClockPing — the fast path: stamp and reply, no awaits.
                if data.len() < 9 {
                    continue;
                }
                let mut pong = vec![0u8; 25];
                pong[0] = 0x02;
                pong[1..9].copy_from_slice(&data[1..9]);
                pong[9..17].copy_from_slice(&now_ms().to_bits().to_le_bytes());
                pong[17..25].copy_from_slice(&now_ms().to_bits().to_le_bytes());
                // try_send, not await: a full buffer means a slow reader, and
                // relay-go disconnects it here rather than blocking the loop.
                if tx.try_send(Message::Binary(pong)).is_err() {
                    break;
                }
            }
            0x05 => {
                // Join — strict length, room charset validated.
                if data.len() < 2 {
                    continue;
                }
                let n = data[1] as usize;
                if data.len() != 2 + n {
                    continue;
                }
                let room = match String::from_utf8(data[2..2 + n].to_vec()) {
                    Ok(r) if is_valid_id(&r) => r,
                    _ => continue,
                };
                server.join_room(&conn, &room).await;
                let mut r = server.redis.clone();
                let res: redis::RedisResult<String> = server
                    .init_room
                    .key(format!("room:{room}:tl"))
                    .key(format!("room:{room}:log"))
                    .arg("")
                    .arg("0")
                    .invoke_async(&mut r)
                    .await;
                if let Ok(raw) = res {
                    if let Ok(tl) = serde_json::from_str::<LuaTimeline>(&raw) {
                        if tx
                            .try_send(Message::Binary(encode_timeline(0x06, &tl)))
                            .is_err()
                        {
                            break;
                        }
                    }
                }
            }
            0x03 => {
                // Control.
                let (intent, media_time, room, cmd_id) = match parse_control(&data) {
                    Some(v) if is_valid_id(&v.2) => v,
                    _ => continue,
                };
                let mut r = server.redis.clone();
                let res: redis::RedisResult<String> = server
                    .apply_control
                    .key(format!("room:{room}:tl"))
                    .key(format!("room:{room}:cmd:{cmd_id}"))
                    .key(format!("room:{room}:log"))
                    .arg(intent)
                    .arg(format!("{media_time}"))
                    .arg("relay")
                    .arg(&cmd_id)
                    .arg(CMD_DEDUP_TTL_MS)
                    .invoke_async(&mut r)
                    .await;
                match res {
                    Ok(raw) => {
                        if let Ok(tl) = serde_json::from_str::<LuaTimeline>(&raw) {
                            if tl.dup {
                                if tx
                                    .try_send(Message::Binary(encode_timeline(0x04, &tl)))
                                    .is_err()
                                {
                                    break;
                                }
                            } else {
                                server.broadcast(&room, encode_timeline(0x04, &tl)).await;
                            }
                        }
                    }
                    Err(_) => {
                        if tx.try_send(Message::Binary(vec![0x07, 0])).is_err() {
                            break;
                        }
                    }
                }
            }
            _ => {}
        }
    }

    // teardown: leave the room, drop from the registry, end the write task by
    // closing the channel (dropping every tx).
    server.leave(&conn).await;
    server.conns.write().await.remove(&id);
    drop(tx);
    drop(conn);
    let _ = writer.await;
}

/// The room charset validated on Join; `is_valid_id` is shared with cmdId
/// because both are spliced into Redis keys and must not carry a separator.
fn verify(secret: &[u8], token: &str) -> Option<Identity> {
    let mut v = Validation::new(Algorithm::HS256);
    // require exp, exactly like relay-go's WithExpirationRequired: golang-jwt
    // and jsonwebtoken both validate exp only when present unless told to
    // demand it, and a token without exp would never age out here.
    v.set_required_spec_claims(&["exp"]);
    // we validate `sub`/`ver` ourselves in identity_from_claims, and there is
    // no audience to check.
    v.validate_aud = false;
    let data = decode::<Claims>(token, &DecodingKey::from_secret(secret), &v).ok()?;
    identity_from_claims(data.claims)
}

/// A 401 handshake rejection, matching relay-go's http.Error(..., 401). The
/// default ErrorResponse carries status 200, which would tell the client the
/// upgrade succeeded.
fn unauthorized() -> ErrorResponse {
    let mut r = ErrorResponse::new(Some("unauthorized".to_string()));
    *r.status_mut() = tokio_tungstenite::tungstenite::http::StatusCode::UNAUTHORIZED;
    r
}

/// Minimal percent-decoding for the token query parameter (JWTs are base64url
/// and contain no reserved chars, but a '+' or '%' from a careless client
/// should still decode rather than corrupt the token).
fn urldecode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                if let (Some(h), Some(l)) = (hi, lo) {
                    out.push((h * 16 + l) as u8);
                    i += 3;
                    continue;
                }
                out.push(bytes[i]);
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8(out).unwrap_or_default()
}

fn read_lua(dir: &str, name: &str) -> String {
    std::fs::read_to_string(format!("{dir}/{name}"))
        .unwrap_or_else(|e| panic!("lua {name} unreadable: {e}"))
}

#[tokio::main]
async fn main() {
    // flags: --addr, --redis, --lua-dir, --jwt-secret (env JWT_SECRET)
    let args: Vec<String> = std::env::args().collect();
    let flag = |name: &str, default: &str| -> String {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
            .unwrap_or_else(|| default.to_string())
    };
    let addr = flag("-addr", ":3500");
    let addr = addr
        .strip_prefix(':')
        .map(|p| format!("0.0.0.0:{p}"))
        .unwrap_or(addr);
    let redis_url = flag("-redis", "redis://localhost:6380");
    let lua_dir = flag("-lua-dir", "../video-sync-backend/src/sync/lua");
    let secret = {
        let s = flag(
            "-jwt-secret",
            &std::env::var("JWT_SECRET").unwrap_or_default(),
        );
        if s.is_empty() {
            // an empty HMAC key verifies any token forged with the same empty
            // key — refuse to start, exactly like relay-go.
            eprintln!("JWT_SECRET (or -jwt-secret) is required");
            std::process::exit(1);
        }
        s
    };

    let common = read_lua(&lua_dir, "common.lua");
    let apply_control =
        redis::Script::new(&(common.clone() + &read_lua(&lua_dir, "apply_control.lua")));
    let init_room = redis::Script::new(&(common.clone() + &read_lua(&lua_dir, "init.lua")));
    let apply_snapshot = redis::Script::new(&(common + &read_lua(&lua_dir, "apply_snapshot.lua")));

    let client = redis::Client::open(redis_url.clone()).expect("redis url");
    let manager = ConnectionManager::new(client).await.expect("redis connect");

    let server = Arc::new(Server {
        redis: manager,
        jwt_secret: secret.into_bytes(),
        lua_dir,
        apply_control,
        init_room,
        apply_snapshot,
        rooms: RwLock::new(HashMap::new()),
        conns: RwLock::new(HashMap::new()),
        revoked_jti: StdRwLock::new(HashSet::new()),
        user_versions: StdRwLock::new(HashMap::new()),
        refreshing: AtomicBool::new(false),
        pending_jti: StdRwLock::new(HashSet::new()),
        pending_versions: StdRwLock::new(HashMap::new()),
    });

    // load the revocation snapshot before we accept anything, so the very
    // first connection is judged against current state, not an empty set.
    server.refresh_snapshot().await;

    tokio::spawn(snapshot_sweep(server.clone()));
    tokio::spawn(revocation_loop(server.clone(), redis_url));

    let listener = TcpListener::bind(&addr).await.expect("bind");
    println!("relay-rs on {addr}");
    // a tiny health line so a supervisor can tell it is up (relay-go serves
    // /health over HTTP; here the log line plus an accepting socket suffice
    // for the study, which drives it directly).
    let _ = &server.lua_dir; // keep field read; the dir is captured in scripts

    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let _ = stream.set_nodelay(true);
                tokio::spawn(handle(server.clone(), stream));
            }
            Err(_) => continue,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctrl(intent: u8, media: f64, room: &str, cmd: Option<&str>) -> Vec<u8> {
        let mut f = vec![0x03, intent];
        f.extend_from_slice(&media.to_bits().to_le_bytes());
        f.push(room.len() as u8);
        f.extend_from_slice(room.as_bytes());
        if let Some(c) = cmd {
            f.push(c.len() as u8);
            f.extend_from_slice(c.as_bytes());
        }
        f
    }

    #[test]
    fn parse_control_legacy_and_suffixed() {
        let legacy = ctrl(0, 12.5, "room1", None);
        let (i, m, r, c) = parse_control(&legacy).unwrap();
        assert_eq!((i, m, r.as_str(), c.as_str()), ("play", 12.5, "room1", ""));

        let suffixed = ctrl(2, 300.0, "room1", Some("cmd-abc"));
        let (i, _, _, c) = parse_control(&suffixed).unwrap();
        assert_eq!(i, "seek");
        assert_eq!(c, "cmd-abc");
    }

    #[test]
    fn parse_control_rejects_trailing_bytes() {
        let mut f = ctrl(0, 1.0, "r", None);
        f.push(0xff); // one byte past the room
        assert!(parse_control(&f).is_none());
    }

    #[test]
    fn parse_control_rejects_bad_intent_and_nan() {
        assert!(parse_control(&ctrl(9, 1.0, "r", None)).is_none());
        assert!(parse_control(&ctrl(0, f64::NAN, "r", None)).is_none());
        assert!(parse_control(&ctrl(0, -1.0, "r", None)).is_none());
    }

    #[test]
    fn id_charset_matches_the_key_safety_rule() {
        assert!(is_valid_id("cmsp2erh50005y28nktozbqrp"));
        assert!(is_valid_id("a-b_C9"));
        assert!(!is_valid_id(""));
        assert!(!is_valid_id("a:b")); // the aliasing case
        assert!(!is_valid_id(&"a".repeat(65)));
    }

    #[test]
    fn identity_requires_subject_and_exp() {
        let ok = identity_from_claims(Claims {
            sub: Some("u1".into()),
            jti: Some("j1".into()),
            ver: Some(serde_json::json!(3)),
            exp: Some(4102444800),
        });
        assert!(ok.is_some());
        assert_eq!(ok.unwrap().ver, 3);

        // no subject
        assert!(identity_from_claims(Claims {
            sub: None,
            jti: None,
            ver: None,
            exp: Some(4102444800),
        })
        .is_none());
        // no exp
        assert!(identity_from_claims(Claims {
            sub: Some("u1".into()),
            jti: None,
            ver: None,
            exp: None,
        })
        .is_none());
        // fractional ver is malformed, not zero
        assert!(identity_from_claims(Claims {
            sub: Some("u1".into()),
            jti: None,
            ver: Some(serde_json::json!(1.5)),
            exp: Some(4102444800),
        })
        .is_none());
        // absent ver -> 0
        assert_eq!(
            identity_from_claims(Claims {
                sub: Some("u1".into()),
                jti: None,
                ver: None,
                exp: Some(4102444800),
            })
            .unwrap()
            .ver,
            0
        );
    }

    #[test]
    fn unknown_reason_encodes_as_zero_matching_the_go_map_default() {
        // relay-go's reasonCodes[missing] is the Go zero value 0, not 3. A
        // real reason like "set-video" is absent from both maps, so both must
        // emit 0 or byte[30] diverges on identical room state.
        assert_eq!(reason_code("set-video"), 0);
        assert_eq!(reason_code(""), 0);
        assert_eq!(reason_code("play"), 0);
        assert_eq!(reason_code("succession"), 5);
    }

    #[test]
    fn timeline_frame_is_31_bytes_and_little_endian() {
        let tl = LuaTimeline {
            seq: 7,
            store_epoch: "1000".into(),
            is_playing: true,
            media_time: 42.0,
            stamped_at: 1.0,
            reason: "seek".into(),
            dup: false,
        };
        let f = encode_timeline(0x04, &tl);
        assert_eq!(f.len(), 31);
        assert_eq!(f[0], 0x04);
        assert_eq!(u32::from_le_bytes(f[1..5].try_into().unwrap()), 7);
        assert_eq!(f[13], 1); // playing
        assert_eq!(f[30], 2); // seek reason code
    }
}
