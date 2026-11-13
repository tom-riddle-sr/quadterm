#!/bin/bash
# QuadTerm 一鍵安裝：裝套件 → 打包成 .app → 放進「應用程式」
set -e
cd "$(dirname "$0")"

if ! command -v npm >/dev/null 2>&1; then
  echo "找不到 Node.js，請先安裝：brew install node（或到 https://nodejs.org 下載）"
  exit 1
fi

echo "▶ 安裝套件…"
npm install

echo "▶ 打包 QuadTerm.app…"
npm run dist

APP="dist/mac-arm64/QuadTerm.app"
[ -d "$APP" ] || APP="$(ls -d dist/mac*/QuadTerm.app | head -1)"

DEST="/Applications"
[ -w "$DEST" ] || DEST="$HOME/Applications"
mkdir -p "$DEST"
rm -rf "$DEST/QuadTerm.app"
cp -R "$APP" "$DEST/"
xattr -cr "$DEST/QuadTerm.app" 2>/dev/null || true

echo ""
echo "✅ 完成！已安裝到 $DEST/QuadTerm.app"
echo "   用 Spotlight 搜尋 QuadTerm 就能開啟。"
open "$DEST/QuadTerm.app"
