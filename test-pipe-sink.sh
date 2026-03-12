#!/bin/bash
# Test script for PulseAudio pipe-sink approach

set -e

SINK_NAME="test_openbuilder_pipe"
PIPE_PATH="/tmp/${SINK_NAME}-audio-pipe"

echo "Testing PulseAudio pipe-sink approach..."

# Cleanup function
cleanup() {
    echo "Cleaning up..."
    pactl unload-module module-pipe-sink 2>/dev/null || true
    rm -f "$PIPE_PATH" 2>/dev/null || true
    pkill -f "ffmpeg.*$PIPE_PATH" 2>/dev/null || true
}

# Set trap for cleanup
trap cleanup EXIT

echo "1. Creating FIFO pipe: $PIPE_PATH"
mkfifo "$PIPE_PATH"

echo "2. Loading module-pipe-sink..."
MODULE_ID=$(pactl load-module module-pipe-sink \
    file="$PIPE_PATH" \
    sink_name="$SINK_NAME" \
    format=s16le \
    rate=16000 \
    channels=1 \
    sink_properties=device.description=TestOpenBuilderPipeSink)
echo "   Module loaded with ID: $MODULE_ID"

echo "3. Setting as default sink..."
pactl set-default-sink "$SINK_NAME"

echo "4. Starting ffmpeg to capture from pipe..."
ffmpeg -f s16le -ar 16000 -ac 1 -i "$PIPE_PATH" \
    -f segment -segment_time 5 -reset_timestamps 1 \
    /tmp/test_chunk_%03d.wav &
FFMPEG_PID=$!

echo "5. Playing test sound..."
sleep 2
# Try to play a test sound
if command -v pactl >/dev/null && pactl list samples | grep -q bell; then
    echo "   Playing system bell..."
    pactl play-sample bell
elif command -v speaker-test >/dev/null; then
    echo "   Playing test tone..."
    timeout 3 speaker-test -t sine -f 440 -l 1 -s 1 2>/dev/null || true
else
    echo "   No test sound available, generating silence..."
    timeout 2 dd if=/dev/zero bs=1024 count=32 2>/dev/null | \
        paplay --device="$SINK_NAME" --format=s16le --rate=16000 --channels=1 2>/dev/null || true
fi

echo "6. Waiting for ffmpeg to capture..."
sleep 8

echo "7. Stopping ffmpeg..."
kill $FFMPEG_PID 2>/dev/null || true
wait $FFMPEG_PID 2>/dev/null || true

echo "8. Checking captured files..."
if ls /tmp/test_chunk_*.wav 1> /dev/null 2>&1; then
    for file in /tmp/test_chunk_*.wav; do
        size=$(stat -f%z "$file" 2>/dev/null || stat -c%s "$file" 2>/dev/null || echo "0")
        echo "   Captured: $file (${size} bytes)"
    done
    echo "SUCCESS: Pipe-sink approach works!"
    rm -f /tmp/test_chunk_*.wav
else
    echo "FAILED: No chunks captured"
    exit 1
fi