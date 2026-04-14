#!/usr/bin/env bash
set -euo pipefail

# Lesepult build/sign/notarize/dmg pipeline.
#
# Usage:
#   ./scripts/build-app.sh                              # build + sign
#   ./scripts/build-app.sh 0.1.0                        # build + sign with explicit version
#   ./scripts/build-app.sh 0.1.0 --notarize             # + notarize the .app
#   ./scripts/build-app.sh 0.1.0 --notarize --dmg       # + build + notarize DMG
#
# Notarization requires APPLE_ID, APPLE_TEAM_ID, APPLE_APP_SPECIFIC_PASSWORD
# in the environment. For local runs, source them from hort.

VERSION="${1:-$(git describe --tags --abbrev=0 2>/dev/null | sed 's/^v//' || echo '0.0.0-dev')}"
shift || true
APP_NAME="Lesepult"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
APP="$DIST/$APP_NAME.app"
ENT="$ROOT/scripts/entitlements.plist"
TAURI_APP="$ROOT/src-tauri/target/release/bundle/macos/$APP_NAME.app"

DO_NOTARIZE=0
DO_DMG=0
for arg in "$@"; do
    case "$arg" in
        --notarize) DO_NOTARIZE=1 ;;
        --dmg)      DO_DMG=1 ;;
        *) echo "Unknown flag: $arg" >&2; exit 1 ;;
    esac
done

echo "==> Lesepult $VERSION"

# 1. Install dependencies
echo "==> bun install"
cd "$ROOT"
bun install --frozen-lockfile

# 2. Build with Tauri
echo "==> tauri build"
bun run tauri build 2>&1

if [[ ! -d "$TAURI_APP" ]]; then
    echo "ERROR: .app not found at $TAURI_APP" >&2
    exit 1
fi

# 3. Copy to dist/
echo "==> Assembling $APP_NAME.app"
rm -rf "$APP"
mkdir -p "$DIST"
cp -R "$TAURI_APP" "$APP"

# 4. Sign with Developer ID + hardened runtime
IDENTITY=$(security find-identity -v -p codesigning | grep "Developer ID Application" | head -1 | sed 's/.*"\(.*\)"/\1/')
if [[ -z "$IDENTITY" ]]; then
    echo "ERROR: no Developer ID Application certificate found in keychain" >&2
    exit 1
fi
echo "==> Signing as: $IDENTITY"

SIGN_OPTS=(--force --sign "$IDENTITY" --timestamp --options runtime --entitlements "$ENT")

# Sign inside-out: frameworks/dylibs first, then main binary, then bundle
find "$APP/Contents/Frameworks" -type f \( -name "*.dylib" -o -perm +111 \) 2>/dev/null | while read -r lib; do
    codesign "${SIGN_OPTS[@]}" "$lib"
done
find "$APP/Contents/Frameworks" -name "*.framework" -type d 2>/dev/null | while read -r fw; do
    codesign "${SIGN_OPTS[@]}" "$fw"
done
codesign "${SIGN_OPTS[@]}" "$APP/Contents/MacOS/$APP_NAME"
codesign "${SIGN_OPTS[@]}" "$APP"
codesign --verify --verbose=2 --strict "$APP"
echo "==> Signature verified"

# 5. Optional: notarize
if [[ "$DO_NOTARIZE" == "1" ]]; then
    : "${APPLE_ID:?APPLE_ID not set}"
    : "${APPLE_TEAM_ID:?APPLE_TEAM_ID not set}"
    : "${APPLE_APP_SPECIFIC_PASSWORD:?APPLE_APP_SPECIFIC_PASSWORD not set}"

    APP_ZIP="$DIST/$APP_NAME.zip"
    echo "==> Notarizing app..."
    ditto -c -k --keepParent --sequesterRsrc "$APP" "$APP_ZIP"
    xcrun notarytool submit "$APP_ZIP" \
        --apple-id "$APPLE_ID" \
        --team-id "$APPLE_TEAM_ID" \
        --password "$APPLE_APP_SPECIFIC_PASSWORD" \
        --wait --timeout 30m
    rm -f "$APP_ZIP"

    echo "==> Stapling app..."
    xcrun stapler staple "$APP"
    xcrun stapler validate "$APP"
fi

# 6. Optional: build DMG
if [[ "$DO_DMG" == "1" ]]; then
    DMG="$DIST/$APP_NAME-$VERSION-arm64.dmg"
    echo "==> Building DMG: $DMG"
    rm -f "$DMG"
    hdiutil create -volname "$APP_NAME" -srcfolder "$APP" -ov -format UDZO "$DMG"

    if [[ "$DO_NOTARIZE" == "1" ]]; then
        echo "==> Notarizing DMG..."
        xcrun notarytool submit "$DMG" \
            --apple-id "$APPLE_ID" \
            --team-id "$APPLE_TEAM_ID" \
            --password "$APPLE_APP_SPECIFIC_PASSWORD" \
            --wait --timeout 30m
        echo "==> Stapling DMG..."
        xcrun stapler staple "$DMG"
        xcrun stapler validate "$DMG"
    fi
    echo "✓ DMG: $DMG"
fi

echo "✓ App: $APP"
