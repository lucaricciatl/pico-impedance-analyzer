#!/usr/bin/env bash
# Build the macOS .app, then wrap it as a zip and a dmg for release.
set -euo pipefail
cd "$(dirname "$0")/.."

NAME="PicoScope Impedance Analyzer"
SLUG="PicoScope-Impedance-Analyzer"
VERSION="${VERSION:-1.0.0}"
ARCH="$(uname -m)"          # arm64 on Apple Silicon, x86_64 on Intel

if [ ! -f frontend/dist/index.html ]; then
  ( cd frontend && npm install --no-audit --no-fund && npm run build )
fi

.venv/bin/pyinstaller --noconfirm --windowed --name "$NAME" \
  --paths . --collect-submodules backend --collect-submodules picosdk \
  --add-data "frontend/dist:frontend_dist" \
  --hidden-import uvicorn.logging --hidden-import uvicorn.loops.auto \
  --hidden-import uvicorn.protocols.http.auto \
  --hidden-import uvicorn.protocols.websockets.auto \
  --hidden-import uvicorn.lifespan.on \
  packaging/entry.py

codesign --force --deep --sign - "dist/$NAME.app"
codesign --verify --deep --strict "dist/$NAME.app"
echo "signed ad-hoc: $(codesign -dv "dist/$NAME.app" 2>&1 | grep -m1 Identifier)"

mkdir -p release
ASSET="$SLUG-$VERSION-macos-$ARCH"
# ditto, not zip: a plain zip flattens the symlinks inside the bundle and the
# signature no longer matches, so the download dies as "damaged"
ditto -c -k --sequesterRsrc --keepParent "dist/$NAME.app" "release/$ASSET.zip"
rm -f "release/$ASSET.dmg"
hdiutil create -quiet -volname "$NAME" -srcfolder "dist/$NAME.app" \
  -ov -format UDZO "release/$ASSET.dmg"

ls -lh release/
