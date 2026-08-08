#!/bin/sh
# Generate the audio ground-truth test asset: a 1kHz click every 2s over a
# black frame. Small, deterministic, same-origin -
# which is what lets the page tap its own audio graph (a cross-origin
# YouTube iframe cannot be tapped, and that is the whole reason this exists).
set -e
# default output resolved from the script's own location - runnable from
# any CWD, same contract as make-hls-fixture.sh
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$HERE/../../video-sync-frontend/public/media/clicktrack.mp4}"
mkdir -p "$(dirname "$OUT")"
ffmpeg -y -loglevel error \
  -f lavfi -i "color=c=black:s=640x360:r=30:d=300" \
  -f lavfi -i "aevalsrc='0.7*sin(2*PI*1000*t)*lt(mod(t,2),0.030)':s=48000:d=300" \
  -c:v libx264 -preset veryfast -tune stillimage -pix_fmt yuv420p \
  -c:a aac -b:a 96k -shortest "$OUT"
echo "wrote $OUT ($(du -h "$OUT" | cut -f1))"
