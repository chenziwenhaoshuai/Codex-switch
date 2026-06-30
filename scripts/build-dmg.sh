#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_ROOT="$ROOT_DIR/CodexSwitchApp"
APP_NAME="Codex Switch"
APP_DIR="$APP_ROOT/build/${APP_NAME}.app"
CONTENTS="$APP_DIR/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"
DMG_PATH="$APP_ROOT/${APP_NAME}.dmg"

rm -rf "$APP_DIR"
mkdir -p "$MACOS" "$RESOURCES"

cat > "$CONTENTS/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>Codex Switch</string>
  <key>CFBundleExecutable</key>
  <string>Codex Switch</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>com.codexswitch.app</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Codex Switch</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.2</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.utilities</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
</dict>
</plist>
PLIST

swiftc \
  -sdk "$(xcrun --sdk macosx --show-sdk-path)" \
  -target arm64-apple-macos13.0 \
  -O \
  "$APP_ROOT/CodexSwitchApp/AppDelegate.swift" \
  "$APP_ROOT/CodexSwitchApp/CodexSwitchApp.swift" \
  "$APP_ROOT/CodexSwitchApp/CodexConfigManager.swift" \
  "$APP_ROOT/CodexSwitchApp/ContentView.swift" \
  "$APP_ROOT/CodexSwitchApp/ProviderStore.swift" \
  "$APP_ROOT/CodexSwitchApp/ProxyProcessManager.swift" \
  "$APP_ROOT/CodexSwitchApp/ProxyViewModel.swift" \
  -o "$MACOS/$APP_NAME"

cp "$APP_ROOT/CodexSwitchApp/Resources/proxy.py" "$RESOURCES/proxy.py"
cp "$APP_ROOT/CodexSwitchApp/Resources/AppIcon.icns" "$RESOURCES/AppIcon.icns"
chmod +x "$MACOS/$APP_NAME"
codesign --force --deep --sign - "$APP_DIR"

if command -v create-dmg >/dev/null 2>&1; then
  rm -f "$DMG_PATH" "$APP_ROOT"/rw.*."$APP_NAME".dmg
  create-dmg \
    --volname "$APP_NAME" \
    --window-size 600 400 \
    --icon "${APP_NAME}.app" 150 190 \
    --app-drop-link 450 190 \
    "$DMG_PATH" \
    "$APP_DIR"
  echo "Created $DMG_PATH"
else
  echo "create-dmg not found; built app at $APP_DIR"
fi
