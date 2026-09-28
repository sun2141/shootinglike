"""영상 읽기 도구: 메타데이터, 축소 스캔, 구간 원본 프레임."""
import json
import subprocess

import cv2
import numpy as np


def probe(path):
    """해상도·fps·길이·회전. ffprobe 가 없으면 OpenCV 값으로 대신한다."""
    info = {"width": None, "height": None, "fps": None, "duration": None, "rotate": 0}
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
             "stream=width,height,avg_frame_rate,duration:stream_tags=rotate:stream_side_data=rotation",
             "-of", "json", str(path)], capture_output=True, text=True, timeout=60).stdout
        s = json.loads(out)["streams"][0]
        info["width"], info["height"] = s["width"], s["height"]
        n, d = s["avg_frame_rate"].split("/")
        info["fps"] = float(n) / float(d) if float(d) else None
        info["duration"] = float(s.get("duration", 0)) or None
        rot = s.get("tags", {}).get("rotate")
        for sd in s.get("side_data_list", []) or []:
            if "rotation" in sd:
                rot = sd["rotation"]
        info["rotate"] = int(float(rot)) % 360 if rot else 0
    except Exception:
        cap = cv2.VideoCapture(str(path))
        info["width"] = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        info["height"] = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        info["fps"] = cap.get(cv2.CAP_PROP_FPS) or None
        n = cap.get(cv2.CAP_PROP_FRAME_COUNT)
        info["duration"] = n / info["fps"] if info["fps"] else None
    return info


class Reader:
    """프레임을 처음부터 순서대로 읽는다. 시각은 영상 자체의 타임스탬프(초)."""

    def __init__(self, path, max_width=1920):
        self.path = str(path)
        cap = cv2.VideoCapture(self.path)
        w = cap.get(cv2.CAP_PROP_FRAME_WIDTH)
        cap.release()
        self.scale = min(1.0, max_width / w) if w else 1.0

    def frames(self, start=0, stop=None, scale=None):
        sc = self.scale if scale is None else scale
        cap = cv2.VideoCapture(self.path)
        if start:
            cap.set(cv2.CAP_PROP_POS_FRAMES, start)
        i = start
        while stop is None or i < stop:
            ok, f = cap.read()
            if not ok:
                break
            t = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
            if sc != 1.0:
                f = cv2.resize(f, None, fx=sc, fy=sc, interpolation=cv2.INTER_AREA)
            yield i, t, f
            i += 1
        cap.release()

    def frame(self, idx):
        for _, _, f in self.frames(idx, idx + 1):
            return f
        return None
