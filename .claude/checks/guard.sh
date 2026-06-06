#!/usr/bin/env bash
# PreToolUse(Bash) guard — block clearly dangerous commands. Exit 2 = block + tell Claude why.
cmd="$(python3 -c 'import sys,json; print(json.load(sys.stdin).get("tool_input",{}).get("command",""))' 2>/dev/null)"
[ -z "$cmd" ] && exit 0

# Patterns we never run unattended. Tune as needed.
deny='rm -rf /|rm -rf ~|rm -rf \*|:\(\)\s*\{|mkfs|dd if=|git push +--?f(orce)?\b.*\b(main|master)\b|DROP +DATABASE|DROP +TABLE|TRUNCATE +'
if printf '%s' "$cmd" | grep -Eiq "$deny"; then
  echo "BLOCKED dangerous command: $cmd" >&2
  echo "This looks destructive/irreversible. Park it and ask the user to run it manually if truly intended." >&2
  exit 2
fi
exit 0
