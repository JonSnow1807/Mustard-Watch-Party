package main

import (
	"encoding/binary"
	"math"
	"testing"

	"github.com/golang-jwt/jwt/v5"
)

func frame(intent byte, mediaTime float64, room string, tail []byte) []byte {
	f := make([]byte, 0, 32)
	f = append(f, 0x03, intent)
	var mt [8]byte
	binary.LittleEndian.PutUint64(mt[:], math.Float64bits(mediaTime))
	f = append(f, mt[:]...)
	f = append(f, byte(len(room)))
	f = append(f, []byte(room)...)
	return append(f, tail...)
}

func cmdTail(cmd string) []byte {
	return append([]byte{byte(len(cmd))}, []byte(cmd)...)
}

func TestParseControlBoundaries(t *testing.T) {
	cases := []struct {
		name    string
		data    []byte
		ok      bool
		wantCmd string
	}{
		{"legacy ends at room", frame(2, 42, "r1", nil), true, ""},
		{"suffixed ends at cmdId", frame(2, 42, "r1", cmdTail("abc_DEF-123")), true, "abc_DEF-123"},
		{"zero-length cmdId", frame(2, 42, "r1", []byte{0}), false, ""},
		{"truncated cmdId", frame(2, 42, "r1", []byte{5, 'a', 'b'}), false, ""},
		{"oversized cmdId", frame(2, 42, "r1", cmdTail(string(make([]byte, 65)))), false, ""},
		{"separator in cmdId aliases keyspaces", frame(2, 42, "r1", cmdTail("b:tl")), false, ""},
		{"trailing bytes after cmdId", frame(2, 42, "r1", append(cmdTail("abc"), 0xFF)), false, ""},
		{"trailing byte after room is a cmdLen and must be complete", frame(2, 42, "r1", []byte{3, 'a'}), false, ""},
		{"bad intent", frame(9, 42, "r1", nil), false, ""},
		{"negative mediaTime", frame(0, -1, "r1", nil), false, ""},
		{"NaN mediaTime", frame(0, math.NaN(), "r1", nil), false, ""},
		{"+Inf mediaTime", frame(0, math.Inf(1), "r1", nil), false, ""},
		{"short frame", []byte{0x03, 0}, false, ""},
	}
	for _, c := range cases {
		_, _, _, cmd, ok := parseControl(c.data)
		if ok != c.ok {
			t.Errorf("%s: ok=%v want %v", c.name, ok, c.ok)
		}
		if ok && cmd != c.wantCmd {
			t.Errorf("%s: cmd=%q want %q", c.name, cmd, c.wantCmd)
		}
	}
}

// ---- revocation ----

func TestIdentityFromClaims(t *testing.T) {
	exp := float64(4102444800) // far future, in seconds as JWT carries it
	cases := []struct {
		name   string
		claims jwt.MapClaims
		ok     bool
		jti    string
		ver    int
	}{
		{"full modern token", jwt.MapClaims{"sub": "u1", "jti": "j1", "ver": float64(3), "exp": exp}, true, "j1", 3},
		// tokens from before jti/ver existed stay valid: old is not suspicious
		{"pre-revocation token", jwt.MapClaims{"sub": "u1", "exp": exp}, true, "", 0},
		// a valid signature is not an identity - matches the Node socket plane
		{"no subject", jwt.MapClaims{"jti": "j1", "exp": exp}, false, "", 0},
		{"empty subject", jwt.MapClaims{"sub": "", "exp": exp}, false, "", 0},
		// exp is required: without it a connection would never age out here
		{"no expiry", jwt.MapClaims{"sub": "u1", "jti": "j1"}, false, "", 0},
		// malformed ver is a refusal, not a zero - zero is where every
		// account starts, and a token must not argue its way back to it
		{"fractional ver", jwt.MapClaims{"sub": "u1", "ver": 1.5, "exp": exp}, false, "", 0},
		{"negative ver", jwt.MapClaims{"sub": "u1", "ver": float64(-1), "exp": exp}, false, "", 0},
		{"string ver", jwt.MapClaims{"sub": "u1", "ver": "2", "exp": exp}, false, "", 0},
	}
	for _, c := range cases {
		id, ok := identityFromClaims(c.claims)
		if ok != c.ok {
			t.Errorf("%s: ok=%v want %v", c.name, ok, c.ok)
			continue
		}
		if ok && (id.jti != c.jti || id.ver != c.ver) {
			t.Errorf("%s: jti=%q ver=%d want %q %d", c.name, id.jti, id.ver, c.jti, c.ver)
		}
	}
}

func TestEvictRevokedMatching(t *testing.T) {
	// The matching rules, on a real registry with no network anywhere:
	// token events match by jti alone; user events match sub AND only
	// versions BELOW the event's - the session that did the signing-out
	// holds a token AT the new version and must not evict itself.
	mk := func(sub, jti string, ver int) *conn {
		return &conn{id: identity{sub: sub, jti: jti, ver: ver}}
	}
	phone := mk("u1", "j1", 0)
	laptop := mk("u1", "j2", 0)
	fresh := mk("u1", "j9", 1) // the post-logout-all session
	other := mk("u2", "j3", 0)

	// Calls the REAL predicate. The first version of this test copied the
	// switch out of evictRevoked and verified the copy - a drift in the
	// real selection would have passed unnoticed, which is the exact
	// instrument-that-cannot-say-no failure the eviction design exists to
	// avoid. selectRevoked is pure, so no ws teardown is involved.
	conns := map[*conn]struct{}{phone: {}, laptop: {}, fresh: {}, other: {}}
	victims := func(ev revocationEvent) int {
		return len(selectRevoked(conns, ev))
	}

	if n := victims(revocationEvent{Kind: "token", Jti: "j1"}); n != 1 {
		t.Errorf("token event: %d victims, want exactly the one holding j1", n)
	}
	if n := victims(revocationEvent{Kind: "user", UserId: "u1", Version: 1}); n != 2 {
		t.Errorf("user event: %d victims, want phone+laptop but not the fresh session", n)
	}
	// a malformed user event with no version must select nobody - version 0
	// would otherwise read as "evict everyone below the start state"
	if n := victims(revocationEvent{Kind: "user", UserId: "u1"}); n != 0 {
		t.Errorf("versionless user event selected %d conns, want 0", n)
	}
	if n := victims(revocationEvent{Kind: "token"}); n != 0 {
		t.Errorf("jti-less token event selected %d conns, want 0", n)
	}
}

func TestRoomValidation(t *testing.T) {
	// cmdId got the separator-free charset precisely so the derived Redis
	// key could not alias another keyspace; room is spliced into THREE key
	// shapes and was accepted raw. Same pattern, same reason.
	for room, want := range map[string]bool{
		"cmsp2erh50005y28nktozbqrp": true,
		"room-1_A":                  true,
		"":                          false,
		"a:b":                       false, // the aliasing case
		"a b":                       false,
		"room\x00":                  false,
	} {
		if got := roomPattern.MatchString(room); got != want {
			t.Errorf("room %q: %v want %v", room, got, want)
		}
	}
	long := make([]byte, 65)
	for i := range long {
		long[i] = 'a'
	}
	if roomPattern.MatchString(string(long)) {
		t.Error("65-char room accepted; the bound is 64")
	}
}
