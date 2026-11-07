#!/bin/bash
# refauto 자동 실행 설치 (macOS).
#   bash scripts/refauto/install_launchd.sh /Volumes/64B/freekick
# 5분마다, 그리고 영상 폴더에 파일이 들어오면 `refauto.py <폴더> --cloud` 를 실행한다.
# 6시간마다 `refauto.py <폴더> --collect` (유튜브에서 속도를 아는 킥 영상 수집) 도 실행한다. 수집만 끄기: REFCOLLECT=0 bash …
# 끄기:  bash scripts/refauto/install_launchd.sh --uninstall
set -euo pipefail

LABEL="com.shootinglike.refauto"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/refauto.log"
CLABEL="com.shootinglike.refcollect"
CPLIST="$HOME/Library/LaunchAgents/$CLABEL.plist"
CLOG="$HOME/Library/Logs/refcollect.log"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootout "gui/$(id -u)/$CLABEL" 2>/dev/null || true
  rm -f "$PLIST" "$CPLIST"
  [[ -L "$HOME/Desktop/USB 안전하게 빼기.command" ]] && rm -f "$HOME/Desktop/USB 안전하게 빼기.command"
  echo "자동 실행을 껐습니다."
  exit 0
fi

FOLDER="${1:?영상 폴더 경로를 주세요. 예: /Volumes/64B/freekick}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
VENV_PY="$REPO/scripts/refauto/.venv/bin/python3"
if [[ -n "${REFAUTO_PYTHON:-}" ]]; then PY="$REFAUTO_PYTHON"
elif [[ -x "$VENV_PY" ]]; then PY="$VENV_PY"
else PY="$(command -v python3)"; fi
echo "사용할 python: $PY"
FFDIR="$(dirname "$(command -v ffprobe 2>/dev/null || echo /opt/homebrew/bin/ffprobe)")"

# 전용 가상환경이면 패키지 판을 requirements.txt 에 맞춘다 (OpenCV 판이 다르면 검출 결과가 달라진다)
if [[ "$PY" == "$VENV_PY" ]]; then
  "$PY" -m pip install -q -r "$REPO/scripts/refauto/requirements.txt" || echo "주의: 패키지 설치에 실패했습니다 (인터넷 확인)."
  "$PY" -m pip install -q -U "yt-dlp[default]" || true      # 유튜브가 바뀌면 옛 판은 못 받는다 → 설치할 때마다 최신으로
fi
"$PY" -c "import numpy, scipy, cv2; print('OpenCV', cv2.__version__)" || { echo "numpy/scipy/opencv 를 불러오지 못했습니다. README 의 준비(전용 가상환경) 를 먼저 하세요."; exit 1; }
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

# 유튜브 레퍼런스 수집 (6시간마다, Mac 이 잠들어 있었으면 깨어난 뒤). 받은 영상은 ~/.refauto/collect/inbox 에 두었다가 USB 가 있으면 옮긴다
launchctl bootout "gui/$(id -u)/$CLABEL" 2>/dev/null || true
if [[ "${REFCOLLECT:-1}" != "0" ]]; then
  grep -q "^TYPESAFE_API_KEY=" "$REPO/.env.local" 2>/dev/null || echo "주의: $REPO/.env.local 에 TYPESAFE_API_KEY 가 없습니다 (유튜브 수집이 멈춥니다)."
  "$PY" -m yt_dlp --version >/dev/null 2>&1 || echo "주의: yt-dlp 를 불러오지 못했습니다 (가상환경에 pip install 'yt-dlp[default]')."
  NODEDIR="$(dirname "$(command -v node 2>/dev/null || echo /opt/homebrew/bin/node)")"
  cat > "$CPLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$CLABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string>
    <string>$REPO/scripts/refauto/refauto.py</string>
    <string>$FOLDER</string>
    <string>--collect</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>StartInterval</key><integer>21600</integer>
  <key>RunAtLoad</key><true/>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$FFDIR:$NODEDIR:/usr/local/bin:/usr/bin:/bin</string>
    <key>PYTHONUNBUFFERED</key><string>1</string>
  </dict>
  <key>StandardOutPath</key><string>$CLOG</string>
  <key>StandardErrorPath</key><string>$CLOG</string>
</dict>
</plist>
EOF
  launchctl bootstrap "gui/$(id -u)" "$CPLIST"
  echo "유튜브 수집도 설치했습니다 (6시간마다). 기록: $CLOG"
fi

# USB 안전하게 빼기 바로가기를 바탕화면에 (두 번 클릭하면 분석을 멈추고 USB 를 꺼낸다)
EJ="$REPO/scripts/refauto/USB 안전하게 빼기.command"
chmod +x "$EJ" "$REPO/scripts/refauto/usb_eject.sh" 2>/dev/null || true
if [[ -d "$HOME/Desktop" && ! -e "$HOME/Desktop/USB 안전하게 빼기.command" ]]; then
  ln -s "$EJ" "$HOME/Desktop/USB 안전하게 빼기.command" 2>/dev/null && echo "바탕화면에 'USB 안전하게 빼기' 바로가기를 만들었습니다."
fi
echo "처음 한 번 macOS 가 '$PY 가 외장 볼륨에 접근' 허용을 물으면 허용하세요."
echo "(안 물었는데 로그에 Operation not permitted 가 보이면: 시스템 설정 > 개인정보 보호 및 보안 > 전체 디스크 접근 권한에 python3 추가)"
