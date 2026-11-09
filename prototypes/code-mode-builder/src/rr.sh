#!/bin/bash
# PROTOTYPE: rerender screens by snippet name: ./rr.sh A1 B1 ...
cd "$(dirname "$0")"; args=(); for s in "$@"; do rm -rf ../png/$s; args+=(gen/$s.js); done
node run.mjs "${args[@]}" | grep -E "Exported|Error|error" ; for s in "$@"; do f=$(ls ../png/$s/*.png 2>/dev/null|head -1); [ -n "$f" ] && mv "$f" ../png/$s.png && rmdir ../png/$s; done; ls ../png
