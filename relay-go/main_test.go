package main

import (
	"encoding/binary"
	"math"
	"testing"
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
