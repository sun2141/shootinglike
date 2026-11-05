#!/bin/bash
# Finder 에서 두 번 클릭: 프리킥 영상 USB 를 안전하게 꺼낸다 (분석 중이면 지금 영상까지만 마치고 멈춘 뒤)
cd "$(dirname "$0")" || exit 1
bash ./usb_eject.sh
echo
read -n 1 -s -r -p "아무 키나 누르면 창을 닫습니다."
