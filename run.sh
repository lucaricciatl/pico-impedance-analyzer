#!/usr/bin/env bash
# Start the PicoScope 2204A impedance analyzer (backend + built React UI).
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8765}"
MODE="${PICO_MODE:-auto}"      # auto | hardware | simulated

if [ ! -x .venv/bin/python ]; then
  echo "creating .venv ..."
  python3 -m venv .venv
  .venv/bin/pip install --quiet --upgrade pip
  .venv/bin/pip install --quiet picosdk fastapi uvicorn websockets numpy
fi

if [ ! -f frontend/dist/index.html ]; then
  echo "building frontend ..."
  ( cd frontend && npm install --no-audit --no-fund && npm run build )
fi

URL="http://127.0.0.1:${PORT}"
echo
echo "  Impedance Analyzer   ${URL}"
echo "  device mode: ${MODE}"
echo
( sleep 2; command -v open >/dev/null && open "$URL" ) >/dev/null 2>&1 &

exec .venv/bin/python -m uvicorn backend.main:app --host 127.0.0.1 --port "$PORT"
