#!/usr/bin/env bash
# Build the Electron desktop app: frozen backend -> electron-builder -> dmg + zip.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f frontend/dist/index.html ]; then
  ( cd frontend && npm install --no-audit --no-fund && npm run build )
fi

# 1. freeze the backend as a plain onedir binary (no --windowed: Electron owns
#    the window, this is a console-less child process)
.venv/bin/pyinstaller --noconfirm --name pico-backend --distpath backend-dist \
  --paths . --collect-submodules backend --collect-submodules picosdk \
  --add-data "frontend/dist:frontend_dist" \
  --hidden-import uvicorn.logging --hidden-import uvicorn.loops.auto \
  --hidden-import uvicorn.protocols.http.auto \
  --hidden-import uvicorn.protocols.websockets.auto \
  --hidden-import uvicorn.lifespan.on \
  packaging/entry.py

# 2. package
cd desktop
[ -d node_modules ] || npm install --no-audit --no-fund
npx electron-builder --mac dmg zip

ls -lh dist/*.dmg dist/*.zip
