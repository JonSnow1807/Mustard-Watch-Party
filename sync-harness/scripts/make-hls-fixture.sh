#!/bin/sh
# Segment the clicktrack fixture (scripts/make-clicktrack.sh) into a
# same-origin VOD HLS rendition for the source matrix's hls arm. Stream-
# copied, so the rendition is byte-derived from its source; like the
# clicktrack itself, it is generated rather than committed
# (public/media/ is gitignored) and THIS script is the provenance.
# Same-origin keeps the hls arm audio-truth eligible.
set -e
# default input resolved from the script's own location - runnable from any CWD
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="${1:-$HERE/../../video-sync-frontend/public/media/clicktrack.mp4}"
OUT_DIR="$(dirname "$SRC")/hls"
if [ ! -f "$SRC" ]; then
  echo "missing $SRC - run scripts/make-clicktrack.sh first" >&2
  exit 1
fi
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
ffmpeg -y -loglevel error -i "$SRC" \
  -c copy -hls_time 6 -hls_playlist_type vod \
  -hls_segment_filename "$OUT_DIR/clicktrack%03d.ts" \
  "$OUT_DIR/clicktrack.m3u8"
echo "wrote $OUT_DIR ($(du -sh "$OUT_DIR" | cut -f1))"
