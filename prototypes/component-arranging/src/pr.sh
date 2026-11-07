#!/bin/bash
f="$1"; cmds="$2"
in=""; [ -f "$f" ] && in="--in $f"
{ cat "$cmds"; printf '\nsave()\nexit()\n'; } | pen interactive $in --out "$f" 2>&1 | grep -v -E 'Update available|npm i -g|╭|╰|│' | sed -E 's/\x1b\[[0-9;]*m//g'
