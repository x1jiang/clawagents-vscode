#!/usr/bin/env bash
# Rebuild VSIX-bundled mic helper (developers with Xcode CLT only).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/scripts/mac_audio_input.swift"
mkdir -p "$root/bin/darwin-arm64" "$root/bin/darwin-x64" "$root/bin/darwin-universal"
swiftc -O -target arm64-apple-macos12.0 "$src" -o "$root/bin/darwin-arm64/mac_audio_input"
swiftc -O -target x86_64-apple-macos12.0 "$src" -o "$root/bin/darwin-x64/mac_audio_input"
lipo -create \
  "$root/bin/darwin-arm64/mac_audio_input" \
  "$root/bin/darwin-x64/mac_audio_input" \
  -output "$root/bin/darwin-universal/mac_audio_input"
chmod +x \
  "$root/bin/darwin-arm64/mac_audio_input" \
  "$root/bin/darwin-x64/mac_audio_input" \
  "$root/bin/darwin-universal/mac_audio_input"
file "$root/bin/darwin-universal/mac_audio_input"
echo "OK: bundled mac_audio_input ready"
