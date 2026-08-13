// relay-go: a second, minimal implementation of the sync plane — raw
// WebSockets with hand-rolled binary framing, goroutine-per-connection,
// executing the SAME Lua scripts as the Node backend against the same
// Redis. An isolated plane for a measured systems comparison (framing +
// runtime), not a mixed-mode deployment: the identical bot suite must pass
// against both planes (cross-language protocol conformance; the second
// implementation of the TLA+-checked protocol).
//
// Scope honesty: no Postgres — any JWT-authenticated user may control
// (authorization was proven on the Node plane; this plane measures
// transport and runtime). Single instance; fanout is in-process.
//
// Binary frames (little-endian):
//
//	C→S 0x01 ClockPing   [t0 f64]
//	S→C 0x02 ClockPong   [t0 f64][t1 f64][t2 f64]
//	C→S 0x03 Control     [intent u8][mediaTime f64][roomLen u8][room...][cmdLen u8][cmdId...]
//	                       (cmdLen+cmdId optional - old frames end at room)
//	S→C 0x04 Timeline    [seq u32][epoch f64][isPlaying u8][mediaTime f64][stampedAt f64][reason u8]
//	C→S 0x05 Join        [roomLen u8][room...]
//	S→C 0x06 JoinAck     (Timeline payload)
//	S→C 0x07 Rejected    [reason u8]
package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/golang-jwt/jwt/v5"
	"github.com/redis/go-redis/v9"
)

type timeline struct {
	Seq       uint32
	Epoch     float64
	IsPlaying bool
	MediaTime float64
	StampedAt float64
	Reason    uint8
}

var reasonCodes = map[string]uint8{
	"play": 0, "pause": 1, "seek": 2, "join": 3, "snapshot": 4, "succession": 5,
}

// mirror of CMD_DEDUP_TTL_MS in room-state.store.ts: a correctness
// parameter (formal/SyncExactlyOnce.tla earlyevict), far above every
// redelivery window in this system
const cmdDedupTTLMS = 15 * 60 * 1000

// mirror of the Node gateway's cmdId validation: bounded, separator-free,
// so the derived room:<room>:cmd:<cmdId> key cannot alias another keyspace
var cmdIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// Room names get the same treatment, and this was a gap: cmdId was
// validated precisely so the derived Redis key could not alias another
// keyspace, while room - spliced into THREE key shapes (:tl, :cmd:, :log) -
// was accepted raw, so a room containing ':' addressed someone else's keys.
var roomPattern = cmdIDPattern

// The revocation mirror the Node backend maintains (RevocationService):
// a SET of revoked jtis and a HASH of userId -> tokenVersion, rebuilt from
// Postgres on every refresh and updated on every revocation. The relay
// TRUSTS this mirror the way it already trusts the same Redis for every
// byte of timeline state. If Redis flushes, the mirror is empty until the
// backend's next refresh - the relay fails open to signature-only for at
// most that window (30s), which is the same staleness bound a backend
// instance that missed a pub/sub message already lives with.
const (
	revokedJtiKey     = "revoked:jti"
	revokedUserverKey = "revoked:userver"
	revocationChannel = "mustard:revocations"
	// how often the sweep re-checks live connections against the mirror
	// and closes ones whose token expired - matches the backend's bound
	revocationSweepInterval = 30 * time.Second
)

// identity is what the token asserted at accept, kept for the lifetime of
// the connection so revocation and expiry can find it later. Before this
// existed the claims were verified once and thrown away - a connection
// outlived its token indefinitely, which made relay revocation impossible
// by construction.
type identity struct {
	sub string
	jti string // "" for tokens minted before jti existed: not individually revocable
	ver int    // 0 for tokens minted before ver existed
	exp time.Time
}

// revocationEvent mirrors the JSON the backend publishes. Malformed events
// are ignored, and a user event with no version is NOT version 0 - zero is
// the version every account starts at, so defaulting to it would un-revoke.
type revocationEvent struct {
	Kind    string `json:"kind"`
	Jti     string `json:"jti"`
	UserId  string `json:"userId"`
	Version int    `json:"version"`
}

// parseControl decodes an 0x03 frame:
//
//	[0]=0x03 [1]=intent u8 [2..9]=mediaTime f64 [10]=roomLen [11..11+n)=room
//	optionally followed by [cmdLen u8][cmdId ASCII [A-Za-z0-9_-]{1,64}]
//
// STRICT on length: a legacy frame must end exactly at room, a suffixed
// frame exactly at cmdId. Trailing bytes are a malformed frame, not
// padding - accepting them would let two encoders disagree about where a
// field ends and still both "work".
func parseControl(data []byte) (intent string, mediaTime float64, room, cmdID string, ok bool) {
	if len(data) < 11 {
		return "", 0, "", "", false
	}
	// validate rather than coerce: %3 turned any garbage byte into a
	// valid intent, and a NaN/Inf mediaTime would poison the timeline
	if data[1] > 2 {
		return "", 0, "", "", false
	}
	intent = []string{"play", "pause", "seek"}[data[1]]
	mediaTime = math.Float64frombits(binary.LittleEndian.Uint64(data[2:10]))
	if math.IsNaN(mediaTime) || math.IsInf(mediaTime, 0) || mediaTime < 0 {
		return "", 0, "", "", false
	}
	n := int(data[10])
	if len(data) < 11+n {
		return "", 0, "", "", false
	}
	room = string(data[11 : 11+n])
	if len(data) == 11+n {
		return intent, mediaTime, room, "", true // legacy: ends at room
	}
	cl := int(data[11+n])
	if cl == 0 || cl > 64 || len(data) != 12+n+cl {
		return "", 0, "", "", false
	}
	cmdID = string(data[12+n : 12+n+cl])
	if !cmdIDPattern.MatchString(cmdID) {
		return "", 0, "", "", false
	}
	return intent, mediaTime, room, cmdID, true
}

type luaTimeline struct {
	Seq        int     `json:"seq"`
	StoreEpoch string  `json:"storeEpoch"`
	IsPlaying  bool    `json:"isPlaying"`
	MediaTime  float64 `json:"mediaTime"`
	StampedAt  float64 `json:"stampedAt"`
	Reason     string  `json:"reason"`
	// set by apply_control.lua when the cmdId was already applied: answer
	// the sender only, never rebroadcast
	Dup bool `json:"dup"`
}

func (t luaTimeline) toWire() timeline {
	epoch, _ := strconv.ParseFloat(t.StoreEpoch, 64)
	return timeline{
		Seq: uint32(t.Seq), Epoch: epoch, IsPlaying: t.IsPlaying,
		MediaTime: t.MediaTime, StampedAt: t.StampedAt,
		Reason: reasonCodes[t.Reason],
	}
}

type server struct {
	rdb          *redis.Client
	applyControl *redis.Script
	initRoom     *redis.Script
	jwtSecret    []byte

	mu    sync.RWMutex
	rooms map[string]map[*conn]struct{}
	// EVERY authenticated connection, not just joined ones. The rooms map
	// only sees a conn after Join, so a sweep built on it would miss a
	// connection that authenticated with a since-revoked token and never
	// joined - exactly the connection a revocation most wants to find.
	conns map[*conn]struct{}
}

type conn struct {
	ws     *websocket.Conn
	send   chan []byte
	room   string
	closed chan struct{}
	id     identity
}

// evict closes the underlying websocket and ONLY the websocket. c.send is
// owned by the handler's defer: closing it from outside races trySend and
// panics the process - and this relay is a single process holding every
// room. Closing the ws makes the read loop return, which runs the defer,
// which tears down the rest in its owner's hands.
func (c *conn) evict(reason string) {
	_ = c.ws.Close(websocket.StatusPolicyViolation, reason)
}

// trySend never blocks the read loop: a dead writer or a full buffer means
// this connection is gone, and blocking here would wedge the goroutine
// forever (the reader would stop draining and the socket would never close).
func (c *conn) trySend(frame []byte) bool {
	select {
	case c.send <- frame:
		return true
	case <-c.closed:
		return false
	default:
		return false // slow consumer: drop, the 10s sweep repairs
	}
}

func loadLua(dir string) (control, init_ *redis.Script, err error) {
	read := func(name string) (string, error) {
		b, err := os.ReadFile(filepath.Join(dir, name))
		return string(b), err
	}
	common, err := read("common.lua")
	if err != nil {
		return nil, nil, err
	}
	c, err := read("apply_control.lua")
	if err != nil {
		return nil, nil, err
	}
	i, err := read("init.lua")
	if err != nil {
		return nil, nil, err
	}
	return redis.NewScript(common + c), redis.NewScript(common + i), nil
}

func nowMs() float64 { return float64(time.Now().UnixNano()) / 1e6 }

// luaString converts a Redis reply to a string without panicking. A bare
// res.(string) assertion panics on a number, table or status reply, and the
// sweep goroutine has no http recovery - one odd reply would take the whole
// relay down.
func luaString(res interface{}, err error) (string, bool) {
	if err != nil || res == nil {
		return "", false
	}
	switch v := res.(type) {
	case string:
		return v, true
	case []byte:
		return string(v), true
	default:
		return "", false
	}
}

func encodeTimeline(msgType byte, tl timeline) []byte {
	buf := make([]byte, 1+4+8+1+8+8+1)
	buf[0] = msgType
	binary.LittleEndian.PutUint32(buf[1:], tl.Seq)
	binary.LittleEndian.PutUint64(buf[5:], math.Float64bits(tl.Epoch))
	if tl.IsPlaying {
		buf[13] = 1
	}
	binary.LittleEndian.PutUint64(buf[14:], math.Float64bits(tl.MediaTime))
	binary.LittleEndian.PutUint64(buf[22:], math.Float64bits(tl.StampedAt))
	buf[30] = tl.Reason
	return buf
}

func (s *server) authenticate(r *http.Request) (identity, bool) {
	tokenStr := r.URL.Query().Get("token")
	if tokenStr == "" {
		return identity{}, false
	}
	// WithExpirationRequired: golang-jwt validates exp when PRESENT but does
	// not demand it, so a token minted without one never expired here. The
	// Node backend always sets exp; a token without it is not one of ours.
	claims := jwt.MapClaims{}
	_, err := jwt.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method")
		}
		return s.jwtSecret, nil
	}, jwt.WithExpirationRequired())
	if err != nil {
		return identity{}, false
	}
	return identityFromClaims(claims)
}

// identityFromClaims extracts what revocation needs, with the same
// tolerances as the Node planes: no jti means not individually revocable,
// no ver means version 0 - but a subject is REQUIRED, matching the socket
// plane's refusal of subject-less tokens (a valid signature is not an
// identity). Split from authenticate so the claim handling is testable
// without minting HTTP requests.
func identityFromClaims(claims jwt.MapClaims) (identity, bool) {
	sub, _ := claims["sub"].(string)
	if sub == "" {
		return identity{}, false
	}
	id := identity{sub: sub}
	if jti, ok := claims["jti"].(string); ok {
		id.jti = jti
	}
	// JSON numbers arrive as float64; a fractional or negative ver is
	// malformed, and malformed is a refusal, not a zero - zero is the
	// version every account starts at, and a token must not be able to
	// argue its way back to it.
	if raw, present := claims["ver"]; present {
		f, ok := raw.(float64)
		if !ok || f != math.Trunc(f) || f < 0 {
			return identity{}, false
		}
		id.ver = int(f)
	}
	exp, err := claims.GetExpirationTime()
	if err != nil || exp == nil {
		return identity{}, false
	}
	id.exp = exp.Time
	return id, true
}

// revoked answers whether this identity is refused by the mirror. Fails
// OPEN on Redis errors: the relay cannot serve traffic at all without
// Redis, so a read failure here means the connection is about to die on
// its own - refusing sign-ins for it would add nothing but flakiness.
func (s *server) revoked(ctx context.Context, id identity) bool {
	if id.jti != "" {
		if hit, err := s.rdb.SIsMember(ctx, revokedJtiKey, id.jti).Result(); err == nil && hit {
			return true
		}
	}
	current, err := s.rdb.HGet(ctx, revokedUserverKey, id.sub).Result()
	if err == nil {
		if v, convErr := strconv.Atoi(current); convErr == nil && id.ver < v {
			return true
		}
	}
	return false
}

func (s *server) joinRoom(c *conn, room string) {
	s.mu.Lock()
	if c.room != "" {
		delete(s.rooms[c.room], c)
		// an empty map left behind is swept forever for nobody
		if len(s.rooms[c.room]) == 0 {
			delete(s.rooms, c.room)
		}
	}
	if s.rooms[room] == nil {
		s.rooms[room] = make(map[*conn]struct{})
	}
	s.rooms[room][c] = struct{}{}
	c.room = room
	s.mu.Unlock()
}

func (s *server) leave(c *conn) {
	s.mu.Lock()
	if c.room != "" {
		delete(s.rooms[c.room], c)
		if len(s.rooms[c.room]) == 0 {
			delete(s.rooms, c.room)
		}
	}
	s.mu.Unlock()
}

func (s *server) broadcast(room string, frame []byte) {
	s.mu.RLock()
	for peer := range s.rooms[room] {
		peer.trySend(frame)
	}
	s.mu.RUnlock()
}

// evictRevoked closes every live connection a revocation event names.
// Strictly-less on version: the bump mints a NEW token at the new version,
// and the session that did the signing-out must not evict itself.
func (s *server) evictRevoked(ev revocationEvent) int {
	s.mu.RLock()
	var victims []*conn
	for c := range s.conns {
		switch {
		case ev.Kind == "token" && ev.Jti != "" && c.id.jti == ev.Jti:
			victims = append(victims, c)
		case ev.Kind == "user" && ev.UserId != "" && ev.Version > 0 &&
			c.id.sub == ev.UserId && c.id.ver < ev.Version:
			victims = append(victims, c)
		}
	}
	s.mu.RUnlock()
	// outside the lock: Close can block on the peer, and the read loop's
	// deferred cleanup needs the write lock this function would be holding
	for _, c := range victims {
		c.evict("session revoked")
	}
	return len(victims)
}

// revocationLoop is the relay's ear: pub/sub for the fast path, a periodic
// sweep as the floor under it. The sweep also closes connections whose
// token has simply expired - a connection is authenticated once at accept,
// and without this it outlives its token for as long as it stays open,
// which is the exact gap the Node plane closed first.
func (s *server) revocationLoop(ctx context.Context) {
	sub := s.rdb.Subscribe(ctx, revocationChannel)
	go func() {
		for msg := range sub.Channel() {
			var ev revocationEvent
			if json.Unmarshal([]byte(msg.Payload), &ev) != nil {
				continue
			}
			if n := s.evictRevoked(ev); n > 0 {
				log.Printf("revocation: closed %d connection(s)", n)
			}
		}
	}()

	for range time.Tick(revocationSweepInterval) {
		now := time.Now()
		s.mu.RLock()
		snapshot := make([]*conn, 0, len(s.conns))
		for c := range s.conns {
			snapshot = append(snapshot, c)
		}
		s.mu.RUnlock()
		closed := 0
		for _, c := range snapshot {
			if !c.id.exp.After(now) {
				c.evict("token expired")
				closed++
				continue
			}
			if s.revoked(ctx, c.id) {
				c.evict("session revoked")
				closed++
			}
		}
		if closed > 0 {
			log.Printf("revocation sweep: closed %d connection(s)", closed)
		}
	}
}

func (s *server) handle(w http.ResponseWriter, r *http.Request) {
	id, ok := s.authenticate(r)
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	// A token revoked a moment ago must not open a NEW connection just
	// because the signature is still good - same rule as the Node planes.
	if s.revoked(r.Context(), id) {
		http.Error(w, "unauthorized: token revoked", http.StatusUnauthorized)
		return
	}
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: []string{"*"}})
	if err != nil {
		return
	}
	c := &conn{ws: ws, send: make(chan []byte, 256), closed: make(chan struct{}), id: id}
	ctx := r.Context()

	// Registered BEFORE the read loop, in the global registry rather than
	// the rooms map: a connection that never joins a room is exactly the
	// one a revocation sweep would otherwise never find.
	s.mu.Lock()
	s.conns[c] = struct{}{}
	s.mu.Unlock()

	go func() { // writer goroutine
		defer close(c.closed) // unblocks trySend once writing is impossible
		for frame := range c.send {
			if err := ws.Write(ctx, websocket.MessageBinary, frame); err != nil {
				return
			}
		}
	}()

	defer func() {
		s.leave(c)
		s.mu.Lock()
		delete(s.conns, c)
		s.mu.Unlock()
		close(c.send)
		ws.Close(websocket.StatusNormalClosure, "")
	}()

	for {
		typ, data, err := ws.Read(ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageBinary || len(data) < 1 {
			continue
		}
		switch data[0] {
		case 0x01: // ClockPing — the fast path: stamp, reply, no awaits
			if len(data) < 9 {
				continue
			}
			t1 := nowMs()
			pong := make([]byte, 25)
			pong[0] = 0x02
			copy(pong[1:9], data[1:9])
			binary.LittleEndian.PutUint64(pong[9:], math.Float64bits(t1))
			binary.LittleEndian.PutUint64(pong[17:], math.Float64bits(nowMs()))
			if !c.trySend(pong) {
				return
			}

		case 0x05: // Join
			if len(data) < 2 {
				continue
			}
			n := int(data[1])
			if len(data) < 2+n {
				continue
			}
			room := string(data[2 : 2+n])
			if !roomPattern.MatchString(room) {
				continue // malformed frame, same treatment as parseControl
			}
			s.joinRoom(c, room)
			raw, ok := luaString(s.initRoom.Run(ctx, s.rdb,
				[]string{"room:" + room + ":tl", "room:" + room + ":log"},
				"", "0").Result())
			if !ok {
				log.Printf("init failed for room %s", room)
				continue
			}
			var tl luaTimeline
			if json.Unmarshal([]byte(raw), &tl) == nil {
				if !c.trySend(encodeTimeline(0x06, tl.toWire())) {
					return
				}
			}

		case 0x03: // Control
			intent, mediaTime, room, cmdId, okc := parseControl(data)
			if !okc || !roomPattern.MatchString(room) {
				continue
			}
			raw, ok := luaString(s.applyControl.Run(ctx, s.rdb,
				[]string{"room:" + room + ":tl", "room:" + room + ":cmd:" + cmdId,
					"room:" + room + ":log"},
				intent, strconv.FormatFloat(mediaTime, 'f', -1, 64), "relay",
				cmdId, strconv.Itoa(cmdDedupTTLMS)).Result())
			if !ok {
				if !c.trySend([]byte{0x07, 0}) {
					return
				}
				continue
			}
			var tl luaTimeline
			if json.Unmarshal([]byte(raw), &tl) == nil {
				if tl.Dup {
					// already applied: the original commit broadcast to the
					// room, so only the sender gets a targeted re-anchor
					if !c.trySend(encodeTimeline(0x04, tl.toWire())) {
						return
					}
				} else {
					s.broadcast(room, encodeTimeline(0x04, tl.toWire()))
				}
			}
		}
	}
}

func main() {
	addr := flag.String("addr", ":3400", "listen address")
	redisURL := flag.String("redis", "redis://localhost:6380", "redis url")
	luaDir := flag.String("lua-dir", "../video-sync-backend/src/sync/lua",
		"directory holding the SAME lua scripts the Node backend runs")
	secret := flag.String("jwt-secret", os.Getenv("JWT_SECRET"), "jwt secret")
	flag.Parse()

	opts, err := redis.ParseURL(*redisURL)
	if err != nil {
		log.Fatal(err)
	}
	if *secret == "" {
		// an empty HMAC key verifies any token an attacker signs with the
		// same empty key - refuse to start rather than accept forgeries
		log.Fatal("JWT_SECRET (or -jwt-secret) is required")
	}
	s := &server{
		rdb:       redis.NewClient(opts),
		jwtSecret: []byte(*secret),
		rooms:     map[string]map[*conn]struct{}{},
		conns:     map[*conn]struct{}{},
	}
	s.applyControl, s.initRoom, err = loadLua(*luaDir)
	if err != nil {
		log.Fatalf("lua load: %v", err)
	}

	// 10s snapshot sweep (the repair channel), same semantics as the Node plane
	go func() {
		const sweepDedupPeriodMS = 10000
		common, errC := os.ReadFile(filepath.Join(*luaDir, "common.lua"))
		snap, errS := os.ReadFile(filepath.Join(*luaDir, "apply_snapshot.lua"))
		if errC != nil || errS != nil {
			// ignoring these errors ran an EMPTY script forever: the repair
			// channel would be silently dead while the relay looked healthy
			log.Fatalf("sweep lua unreadable: %v %v", errC, errS)
		}
		snapshotScript := redis.NewScript(string(common) + string(snap))
		for range time.Tick(10 * time.Second) {
			s.mu.RLock()
			rooms := make([]string, 0, len(s.rooms))
			for r := range s.rooms {
				rooms = append(rooms, r)
			}
			s.mu.RUnlock()
			for _, room := range rooms {
				// same dedup contract as the Node plane: the script commits at
				// most one sweep per room per aligned window no matter how
				// many instances call it, and returns nil to the losers
				raw, ok := luaString(snapshotScript.Run(context.Background(), s.rdb,
					[]string{"room:" + room + ":tl", "room:" + room + ":log"},
					sweepDedupPeriodMS).Result())
				if !ok {
					continue
				}
				var tl luaTimeline
				if json.Unmarshal([]byte(raw), &tl) == nil && tl.IsPlaying {
					s.broadcast(room, encodeTimeline(0x04, tl.toWire()))
				}
			}
		}
	}()

	go s.revocationLoop(context.Background())

	http.HandleFunc("/sync", s.handle)
	http.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"status":"ok","plane":"relay-go"}`)
	})
	log.Printf("relay-go on %s (redis %s)", *addr, *redisURL)
	log.Fatal(http.ListenAndServe(*addr, nil))
}
