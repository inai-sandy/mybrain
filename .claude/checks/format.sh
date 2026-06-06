#!/usr/bin/env bash
# PostToolUse(Edit|Write) — auto-format the edited file. Never blocks (always exit 0).
f="$(python3 -c 'import sys,json; print(json.load(sys.stdin).get("tool_input",{}).get("file_path",""))' 2>/dev/null)"
{ [ -z "$f" ] || [ ! -f "$f" ]; } && exit 0
case "$f" in
  *.js|*.jsx|*.ts|*.tsx|*.json|*.css|*.scss|*.html|*.md|*.yaml|*.yml)
    command -v prettier >/dev/null 2>&1 && prettier --write "$f" >/dev/null 2>&1 ;;
  *.py)
    command -v black >/dev/null 2>&1 && black -q "$f" >/dev/null 2>&1
    command -v ruff  >/dev/null 2>&1 && ruff format "$f" >/dev/null 2>&1 ;;
  *.go)
    command -v gofmt >/dev/null 2>&1 && gofmt -w "$f" >/dev/null 2>&1 ;;
esac
exit 0
