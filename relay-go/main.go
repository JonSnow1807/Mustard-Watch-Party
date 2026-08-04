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
//   C→S 0x01 ClockPing   [t0 f64]
//   S→C 0x02 ClockPong   [t0 f64][t1 f64][t2 f64]
//   C→S 0x03 Control     [intent u8][mediaTime f64][roomLen u8][room...]
//   S→C 0x04 Timeline    [seq u32][epoch f64][isPlaying u8][mediaTime f64][stampedAt f64][reason u8]
//   C→S 0x05 Join        [roomLen u8][room...]
//   S→C 0x06 JoinAck     (Timeline payload)
//   S→C 0x07 Rejected    [reason u8]
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

type luaTimeline struct {
	Seq        int     `json:"seq"`
	StoreEpoch string  `json:"storeEpoch"`
	IsPlaying  bool    `json:"isPlaying"`
	MediaTime  float64 `json:"mediaTime"`
	StampedAt  float64 `json:"stampedAt"`
	Reason     string  `json:"reason"`
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
}

type conn struct {
	ws   *websocket.Conn
	send chan []byte
	room string
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

func (s *server) authenticate(r *http.Request) bool {
	tokenStr := r.URL.Query().Get("token")
	if tokenStr == "" {
		return false
	}
	_, err := jwt.Parse(tokenStr, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method")
		}
		return s.jwtSecret, nil
	})
	return err == nil
}

func (s *server) joinRoom(c *conn, room string) {
	s.mu.Lock()
	if c.room != "" {
		delete(s.rooms[c.room], c)
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
		select {
		case peer.send <- frame:
		default: // slow consumer: drop; the sweep repairs
		}
	}
	s.mu.RUnlock()
}

func (s *server) handle(w http.ResponseWriter, r *http.Request) {
	if !s.authenticate(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: []string{"*"}})
	if err != nil {
		return
	}
	c := &conn{ws: ws, send: make(chan []byte, 256)}
	ctx := r.Context()

	go func() { // writer goroutine
		for frame := range c.send {
			if err := ws.Write(ctx, websocket.MessageBinary, frame); err != nil {
				return
			}
		}
	}()

	defer func() {
		s.leave(c)
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
			c.send <- pong

		case 0x05: // Join
			if len(data) < 2 {
				continue
			}
			n := int(data[1])
			if len(data) < 2+n {
				continue
			}
			room := string(data[2 : 2+n])
			s.joinRoom(c, room)
			res, err := s.initRoom.Run(ctx, s.rdb,
				[]string{"room:" + room + ":tl"}, "", "0").Result()
			if err != nil {
				log.Printf("init failed: %v", err)
				continue
			}
			var tl luaTimeline
			if json.Unmarshal([]byte(res.(string)), &tl) == nil {
				c.send <- encodeTimeline(0x06, tl.toWire())
			}

		case 0x03: // Control
			if len(data) < 11 {
				continue
			}
			intent := []string{"play", "pause", "seek"}[data[1]%3]
			mediaTime := math.Float64frombits(binary.LittleEndian.Uint64(data[2:10]))
			n := int(data[10])
			if len(data) < 11+n {
				continue
			}
			room := string(data[11 : 11+n])
			res, err := s.applyControl.Run(ctx, s.rdb,
				[]string{"room:" + room + ":tl"}, intent,
				strconv.FormatFloat(mediaTime, 'f', -1, 64), "relay").Result()
			if err != nil || res == nil {
				c.send <- []byte{0x07, 0}
				continue
			}
			var tl luaTimeline
			if json.Unmarshal([]byte(res.(string)), &tl) == nil {
				s.broadcast(room, encodeTimeline(0x04, tl.toWire()))
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
	s := &server{
		rdb:       redis.NewClient(opts),
		jwtSecret: []byte(*secret),
		rooms:     map[string]map[*conn]struct{}{},
	}
	s.applyControl, s.initRoom, err = loadLua(*luaDir)
	if err != nil {
		log.Fatalf("lua load: %v", err)
	}

	// 10s snapshot sweep (the repair channel), same semantics as the Node plane
	go func() {
		snapshotScript := func() *redis.Script {
			common, _ := os.ReadFile(filepath.Join(*luaDir, "common.lua"))
			snap, _ := os.ReadFile(filepath.Join(*luaDir, "apply_snapshot.lua"))
			return redis.NewScript(string(common) + string(snap))
		}()
		for range time.Tick(10 * time.Second) {
			s.mu.RLock()
			rooms := make([]string, 0, len(s.rooms))
			for r := range s.rooms {
				rooms = append(rooms, r)
			}
			s.mu.RUnlock()
			for _, room := range rooms {
				res, err := snapshotScript.Run(context.Background(), s.rdb,
					[]string{"room:" + room + ":tl"}).Result()
				if err != nil || res == nil {
					continue
				}
				var tl luaTimeline
				if json.Unmarshal([]byte(res.(string)), &tl) == nil && tl.IsPlaying {
					s.broadcast(room, encodeTimeline(0x04, tl.toWire()))
				}
			}
		}
	}()

	http.HandleFunc("/sync", s.handle)
	http.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprint(w, `{"status":"ok","plane":"relay-go"}`)
	})
	log.Printf("relay-go on %s (redis %s)", *addr, *redisURL)
	log.Fatal(http.ListenAndServe(*addr, nil))
}
