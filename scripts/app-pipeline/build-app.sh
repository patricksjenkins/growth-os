#!/usr/bin/env bash
#
# build-app.sh — one-command branded iOS build → archive (ready for TestFlight upload).
#
# Builds ANY per-customer branded app from the single shared FGA codebase by
# overlaying that tenant's app.json + assets, prebuilding, archiving, and
# exporting. FGA's own config/assets are backed up and restored afterward, so
# the FGA app stays pristine.
#
# Usage:
#   build-app.sh <tenant-slug>          # e.g. build-app.sh 923a-coins
#   build-app.sh                        # defaults to 923a-coins
#
# Prework that must already exist on this Mac / Apple account (one-time):
#   - App ID for the tenant bundle id (Push + Associated Domains)
#   - App Store distribution provisioning profile for that bundle id, installed
#   - The app created in App Store Connect with that bundle id
#   - Distribution cert + private key in the login keychain (Team 6Y8873V85M)
#
# The final TestFlight upload is the SAME manual Xcode Organizer step used for
# the FGA app (Distribute App → App Store Connect → Distribute). This script
# opens the archive for you at the end.
#
set -uo pipefail

# ─── Inputs ──────────────────────────────────────────────────────────────────
TENANT="${1:-923a-coins}"
APP_DIR="$HOME/Desktop/FGA/mobile-app"
TENANT_DIR="$HOME/growth-os/tenants/$TENANT/mobile"
TEAM_ID="6Y8873V85M"

# ─── Environment (PATH + locale, required for npx/pod/CocoaPods encoding) ─────
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node/" 2>/dev/null | tail -1)/bin:$PATH"
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8

red()  { printf "\033[31m%s\033[0m\n" "$*"; }
grn()  { printf "\033[32m%s\033[0m\n" "$*"; }
ylw()  { printf "\033[33m%s\033[0m\n" "$*"; }
step() { printf "\n\033[1;36m▶ %s\033[0m\n" "$*"; }
die()  { red "✗ $*"; exit 1; }

[ -d "$APP_DIR" ]    || die "App dir not found: $APP_DIR"
[ -d "$TENANT_DIR" ] || die "Tenant dir not found: $TENANT_DIR"
[ -f "$TENANT_DIR/app.json" ] || die "Tenant app.json not found: $TENANT_DIR/app.json"

# ─── Read identity from the tenant app.json ──────────────────────────────────
read_json() { node -e "const c=require('$TENANT_DIR/app.json').expo; console.log($1 || '')"; }
BUNDLE_ID="$(read_json 'c.ios && c.ios.bundleIdentifier')"
APP_NAME="$(read_json 'c.name')"
BUILD_NUM="$(read_json 'c.ios && c.ios.buildNumber')"
APP_VER="$(read_json 'c.version')"
[ -n "$BUNDLE_ID" ] || die "Could not read ios.bundleIdentifier from tenant app.json"

grn "Building: $APP_NAME  ($BUNDLE_ID)  v$APP_VER build $BUILD_NUM"
echo "Team: $TEAM_ID   Tenant dir: $TENANT_DIR"

# ─── Backup FGA config + assets, set restore trap ────────────────────────────
BACKUP="$(mktemp -d)"
cp "$APP_DIR/app.json" "$BACKUP/app.json"
cp -R "$APP_DIR/assets" "$BACKUP/assets"

restore() {
  step "Restoring FGA config + assets"
  cp "$BACKUP/app.json" "$APP_DIR/app.json"
  rm -rf "$APP_DIR/assets" && cp -R "$BACKUP/assets" "$APP_DIR/assets"
  rm -rf "$BACKUP"
  grn "FGA config restored."
}
trap restore EXIT

# ─── Overlay tenant config + assets ──────────────────────────────────────────
step "Overlaying $TENANT config + assets onto the codebase"
cp "$TENANT_DIR/app.json" "$APP_DIR/app.json"
# copy tenant asset files individually so FGA-only files (e.g. favicon) survive
for f in "$TENANT_DIR/assets/"*; do
  [ -e "$f" ] && cp "$f" "$APP_DIR/assets/"
done
grn "Overlay applied."

cd "$APP_DIR" || die "cd failed"

# ─── Prebuild (regenerates ios/) ─────────────────────────────────────────────
step "expo prebuild --clean"
npx expo prebuild --clean --platform ios >/tmp/build-$TENANT-prebuild.log 2>&1 \
  || { tail -30 /tmp/build-$TENANT-prebuild.log; die "prebuild failed (see /tmp/build-$TENANT-prebuild.log)"; }
grn "prebuild ok"

# ─── Detect generated workspace + scheme + xcodeproj ─────────────────────────
WORKSPACE="$(ls -1d ios/*.xcworkspace 2>/dev/null | head -1)"
[ -n "$WORKSPACE" ] || die "No .xcworkspace generated under ios/"
PROJ_NAME="$(basename "$WORKSPACE" .xcworkspace)"
XCODEPROJ="ios/$PROJ_NAME.xcodeproj"
grn "Workspace: $WORKSPACE   Project: $PROJ_NAME"

# Confirm scheme exists (fall back to project name)
SCHEME="$PROJ_NAME"
if ! xcodebuild -workspace "$WORKSPACE" -list 2>/dev/null | grep -q "^[[:space:]]*$SCHEME$"; then
  SCHEME="$(xcodebuild -workspace "$WORKSPACE" -list 2>/dev/null | awk '/Schemes:/{f=1;next} f&&NF{print $1; exit}')"
fi
[ -n "$SCHEME" ] || die "Could not determine a build scheme"
grn "Scheme: $SCHEME"

# ─── Pod install ─────────────────────────────────────────────────────────────
step "pod install"
( cd ios && pod install >/tmp/build-$TENANT-pod.log 2>&1 ) \
  || { tail -30 /tmp/build-$TENANT-pod.log; die "pod install failed (see /tmp/build-$TENANT-pod.log)"; }
grn "pods ok"

# ─── fmt consteval fix (Xcode 26 clang rejects consteval in bundled fmt) ──────
step "Patching fmt FMT_USE_CONSTEVAL"
FMT_HEADER="ios/Pods/fmt/include/fmt/base.h"
if [ -f "$FMT_HEADER" ]; then
  sed -i '' 's/#  define FMT_USE_CONSTEVAL 1/#  define FMT_USE_CONSTEVAL 0/g' "$FMT_HEADER"
  if grep -q "FMT_USE_CONSTEVAL 1" "$FMT_HEADER"; then
    die "fmt patch incomplete — still has FMT_USE_CONSTEVAL 1"
  fi
  grn "fmt patched"
else
  ylw "fmt header not found ($FMT_HEADER) — skipping (may be fine)"
fi

# ─── Verify / fix DEVELOPMENT_TEAM ───────────────────────────────────────────
step "Verifying DEVELOPMENT_TEAM = $TEAM_ID"
if grep -q "DEVELOPMENT_TEAM = " "$XCODEPROJ/project.pbxproj"; then
  sed -i '' "s/DEVELOPMENT_TEAM = [A-Z0-9]*;/DEVELOPMENT_TEAM = $TEAM_ID;/g" "$XCODEPROJ/project.pbxproj"
fi
grn "team set"

# ─── (Re)install any provisioning profile stashed in the tenant dir ──────────
# macOS sometimes prunes ~/Library/MobileDevice/Provisioning Profiles. Keeping a
# copy in the tenant dir makes the build self-healing.
PROFILE_STORE="$HOME/Library/MobileDevice/Provisioning Profiles"
mkdir -p "$PROFILE_STORE"
for p in "$TENANT_DIR/"*.mobileprovision; do
  [ -e "$p" ] || continue
  puuid="$(security cms -D -i "$p" 2>/dev/null | plutil -extract UUID raw -)"
  [ -n "$puuid" ] && cp "$p" "$PROFILE_STORE/$puuid.mobileprovision"
done

# ─── Find the installed provisioning profile for this bundle id ───────────────
step "Finding distribution provisioning profile for $BUNDLE_ID"
PROFILE_NAME=""
for f in "$PROFILE_STORE/"*.mobileprovision; do
  [ -e "$f" ] || continue
  appid="$(security cms -D -i "$f" 2>/dev/null | plutil -extract Entitlements.application-identifier raw - 2>/dev/null)"
  if [ "$appid" = "$TEAM_ID.$BUNDLE_ID" ]; then
    PROFILE_NAME="$(security cms -D -i "$f" 2>/dev/null | plutil -extract Name raw - 2>/dev/null)"
    break
  fi
done
[ -n "$PROFILE_NAME" ] || die "No installed provisioning profile found for $TEAM_ID.$BUNDLE_ID. Download + double-click it from developer.apple.com."
grn "Profile: $PROFILE_NAME"

# ─── Archive ─────────────────────────────────────────────────────────────────
step "Archiving (3-5 min)…"
ARCHIVE="ios/build/$PROJ_NAME.xcarchive"
rm -rf "$ARCHIVE"
xcodebuild -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -archivePath "$ARCHIVE" \
  archive \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY="iPhone Distribution" \
  PROVISIONING_PROFILE_SPECIFIER="$PROFILE_NAME" \
  >/tmp/build-$TENANT-archive.log 2>&1 \
  || { tail -40 /tmp/build-$TENANT-archive.log; die "ARCHIVE FAILED (see /tmp/build-$TENANT-archive.log)"; }
grep -q "ARCHIVE SUCCEEDED" /tmp/build-$TENANT-archive.log || { tail -40 /tmp/build-$TENANT-archive.log; die "Archive did not report success"; }
grn "** ARCHIVE SUCCEEDED **"

# ─── Export ──────────────────────────────────────────────────────────────────
step "Exporting archive"
EXPORT_PLIST="ios/build/ExportOptions.plist"
cat > "$EXPORT_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>teamID</key><string>$TEAM_ID</string>
  <key>signingStyle</key><string>manual</string>
  <key>provisioningProfiles</key>
  <dict>
    <key>$BUNDLE_ID</key><string>$PROFILE_NAME</string>
  </dict>
  <key>uploadBitcode</key><false/>
  <key>uploadSymbols</key><true/>
</dict>
</plist>
EOF
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath ios/build/export \
  -exportOptionsPlist "$EXPORT_PLIST" \
  -allowProvisioningUpdates \
  >/tmp/build-$TENANT-export.log 2>&1 \
  || { tail -40 /tmp/build-$TENANT-export.log; die "EXPORT FAILED (see /tmp/build-$TENANT-export.log)"; }
grn "** EXPORT SUCCEEDED **"

# ─── Open archive for the manual Organizer upload (same as FGA) ───────────────
ABS_ARCHIVE="$APP_DIR/$ARCHIVE"
step "Opening archive in Xcode Organizer"
open "$ABS_ARCHIVE"

echo
grn "================ BUILD READY ================"
echo "App:        $APP_NAME ($BUNDLE_ID)"
echo "Version:    $APP_VER build $BUILD_NUM"
echo "Archive:    $ABS_ARCHIVE"
echo "IPA:        $APP_DIR/ios/build/export/"
echo
ylw "Final step (manual, same as FGA): in the Organizer window →"
echo "  1. Select the new build at the top"
echo "  2. Distribute App → App Store Connect → Distribute"
echo "  3. Wait for 'Upload completed' (ignore the hermes dSYM warning)"
echo
echo "Shows up in TestFlight ~10-15 min after Apple finishes processing."
echo "(FGA config + assets are being restored now.)"
