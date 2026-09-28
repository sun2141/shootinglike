#!/bin/bash
# refauto 자동 실행 설치 (macOS).
#   bash scripts/refauto/install_launchd.sh /Volumes/64B/freekick
# 5분마다, 그리고 영상 폴더에 파일이 들어오면 `refauto.py <폴더> --cloud` 를 실행한다.
# 끄기:  bash scripts/refauto/install_launchd.sh --uninstall
set -euo pipefail

LABEL="com.shootinglike.refauto"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/refauto.log"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "자동 실행을 껐습니다."
  exit 0
fi

FOLDER="${1:?영상 폴더 경로를 주세요. 예: /Volumes/64B/freekick}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PY="$(command -v python3)"
FFDIR="$(dirname "$(command -v ffprobe 2>/dev/null || echo /opt/homebrew/bin/ffprobe)")"

"$PY" -c "import numpy, scipy, cv2" || { echo "먼저: pip3 install -r scripts/refauto/requirements.txt"; exit 1; }
grep -q "^ADMIN_REFERENCE_TOKEN=" "$REPO/.env.local" 2>/dev/null || echo "주의: $REPO/.env.local 에 ADMIN_REFERENCE_TOKEN 이 없습니다 (동기화가 안 됩니다)."

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string>
    <string>$REPO/scripts/refauto/refauto.py</string>
    <string>$FOLDER</string>
    <string>--cloud</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>StartInterval</key><integer>300</integer>
  <key>WatchPaths</key><array><string>$FOLDER</string></array>
  <key>RunAtLoad</key><true/>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$FFDIR:/usr/local/bin:/usr/bin:/bin</string>
    <key>PYTHONUNBUFFERED</key><string>1</string>
  </dict>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "설치했습니다. 기록: $LOG"
echo "처음 한 번 macOS 가 '$PY 가 외장 볼륨에 접근' 허용을 물으면 허용하세요."
echo "(안 물었는데 로그에 Operation not permitted 가 보이면: 시스템 설정 > 개인정보 보호 및 보안 > 전체 디스크 접근 권한에 python3 추가)"
