#!/bin/bash
# USB 안전하게 빼기 (macOS)
#   bash scripts/refauto/usb_eject.sh                    # 자동 실행에 등록된 영상 폴더의 USB
#   bash scripts/refauto/usb_eject.sh /Volumes/64B/freekick
# 1) 분석 워커에 일시정지를 걸고(지금 영상까지만 마침) 2) 끝날 때까지 기다린 뒤 3) USB 를 꺼낸다.
# USB 를 다시 꽂으면 워커는 알아서 이어서 돈다 (일시정지는 꺼낸 뒤 풀린다).
set -uo pipefail

STATE="${REFAUTO_STATE:-$HOME/.refauto}"
PAUSE="$STATE/pause"
PLIST="$HOME/Library/LaunchAgents/com.shootinglike.refauto.plist"

FOLDER="${1:-}"
if [[ -z "$FOLDER" && -f "$PLIST" ]]; then
  FOLDER="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:2' "$PLIST" 2>/dev/null || true)"
fi
FOLDER="${FOLDER:-/Volumes/64B/freekick}"

# USB 이름이 바뀌어 붙었으면(예: '64B 1') 같은 폴더를 찾는다
if [[ ! -d "$FOLDER" && "$FOLDER" == /Volumes/* ]]; then
  SUB="${FOLDER#/Volumes/*/}"
  for v in /Volumes/*; do
    if [[ -f "$v/$SUB/_refauto/ledger.json" ]]; then FOLDER="$v/$SUB"; break; fi
  done
fi
if [[ "$FOLDER" != /Volumes/* ]]; then
  echo "영상 폴더가 USB(/Volumes/...) 에 있지 않습니다: $FOLDER"; exit 1
fi
VOL="/Volumes/$(echo "${FOLDER#/Volumes/}" | cut -d/ -f1)"
if [[ ! -d "$VOL" ]]; then
  echo "USB($VOL) 가 이미 빠져 있습니다."; exit 0
fi

notify() { osascript -e "display notification \"$1\" with title \"프리킥 레퍼런스\"" >/dev/null 2>&1 || true; }

mkdir -p "$STATE"
date > "$PAUSE"
trap 'rm -f "$PAUSE"; echo; echo "취소했습니다. 분석은 계속됩니다."; exit 130' INT TERM

echo "USB: $VOL"
echo "분석 워커에 일시정지를 걸었습니다. 지금 처리 중인 영상까지만 마치고 멈춥니다..."
# USB 의 영상을 읽는 분석 실행(자동·수동)이 끝날 때까지. 확인 페이지(--review)는 파일을 잡고 있지 않으니 기다리지 않는다
busy() { pgrep -lf "scripts/refauto/refauto.py" 2>/dev/null | grep -v -- "--review" | grep -q .; }
start=$(date +%s)
while busy; do
  printf "\r  기다리는 중 %ds (Ctrl+C 로 취소)" $(( $(date +%s) - start ))
  sleep 3
done
echo
sync
echo "USB 를 꺼냅니다..."
if diskutil eject "$VOL"; then
  rm -f "$PAUSE"
  echo "✅ 이제 USB 를 빼도 됩니다."
  notify "USB 를 안전하게 뺄 수 있습니다"
  exit 0
fi
rm -f "$PAUSE"
echo "❌ 꺼내지 못했습니다. 다른 앱(Finder 미리보기·QuickTime·터미널의 cd 등)이 USB 의 파일을 쓰고 있습니다."
echo "   그 앱을 닫고 다시 실행하세요. 분석 워커는 다시 켜 두었습니다."
notify "USB 를 꺼내지 못했습니다 — 열려 있는 파일을 닫고 다시 시도하세요"
exit 1
