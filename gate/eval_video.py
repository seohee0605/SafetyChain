"""1초 4장(다중 프레임) 판정 효과 측정 — 직접 찍은 영상 20개.

평가셋: docs/dataset/video_labels.csv + raw_video/*.MOV (2026-11-02 촬영, 야외 맑음).
- 각 라벨 구간을 0.25초 간격(1초 4장, 게이트와 같은 간격)으로 프레임을 뽑아 vision.check_ppe로 한 장씩 판정한다.
- '1초 창'을 0.5초마다 하나씩 만든다 (연속 4장). 상태가 바뀌는 구간(벗는 중·쓰는 중)은 라벨에서 이미 뺐다.
- 같은 창에 대해 두 규칙을 비교한다:
    단일 프레임 = 창의 첫 장 판정 (사진 한 장 게이트)
    1초 4장    = vision.check_frames와 같은 규칙: 가장 나쁜 프레임의 판정
- 임계값은 지금 게이트 정책(vision.POLICY) 그대로. 영상으로 임계값을 다시 고르지 않는다.

    python eval_video.py [--dataset ../../docs/dataset]
"""
import argparse
import csv
import json
import subprocess
import tempfile
from collections import Counter, defaultdict
from pathlib import Path

import vision

HERE = Path(__file__).resolve().parent
STEP = 0.25   # 프레임 간격 (게이트 FRAME_INTERVAL_MS = 250)
WIN = 4       # 1초 창의 장수 (게이트 FRAME_COUNT = 4)
STRIDE = 2    # 창을 0.5초마다 하나씩
RANK = {"deny": 0, "supervisor": 1, "pass": 2}


def frames_of(mov: Path, start: float, end: float, out: Path) -> list[tuple[float, Path]]:
    dur = float(json.loads(subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(mov)],
        capture_output=True, text=True).stdout)["format"]["duration"])
    end = min(end, dur - 0.05)
    res, t = [], start
    while t <= end + 1e-6:
        p = out / f"{mov.stem}_{t:06.2f}.jpg"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.2f}", "-i", str(mov), "-frames:v", "1",
                        "-vf", "scale='if(gt(iw,ih),1280,-2)':'if(gt(iw,ih),-2,1280)'", "-q:v", "3", str(p)])
        if p.exists():
            res.append((round(t, 2), p))
        t += STEP
    return res


def rates(rows, key):
    worn = [r for r in rows if r["gt"]]
    notw = [r for r in rows if not r["gt"]]
    miss = sum(r[key] == "pass" for r in notw)
    blk = sum(r[key] == "deny" for r in worn)
    sup = sum(r[key] == "supervisor" for r in rows)
    return {"miss": (miss, len(notw)), "block": (blk, len(worn)), "supervisor": (sup, len(rows))}


def fmt(d):
    f = lambda k: f"{d[k][0]}/{d[k][1]} ({100 * d[k][0] / max(1, d[k][1]):.1f}%)"
    return f"놓침 {f('miss')}  차단 {f('block')}  감독자 {f('supervisor')}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default=str(HERE.parent.parent / "docs" / "dataset"))
    a = ap.parse_args()
    ds = Path(a.dataset)
    segs = list(csv.DictReader(open(ds / "video_labels.csv", encoding="utf-8-sig")))
    out_dir = HERE / "eval_out"
    out_dir.mkdir(exist_ok=True)

    windows, per_frame = [], []
    with tempfile.TemporaryDirectory() as td:
        for s in segs:
            fr = frames_of(ds / "raw_video" / s["file"], float(s["start_s"]), float(s["end_s"]), Path(td))
            dec = []
            for t, p in fr:
                r = vision.check_ppe(str(p))
                dec.append((t, r["helmetDecision"], r["helmetScore"]))
                per_frame.append({"file": s["file"], "t": t, "gt": s["helmet"], "decision": r["helmetDecision"],
                                  "score": r["helmetScore"], "note": s["note"]})
            gt = s["helmet"] == "worn"
            for i in range(0, len(dec) - WIN + 1, STRIDE):
                w = dec[i:i + WIN]
                windows.append({"file": s["file"], "session": s["session"], "note": s["note"], "t0": w[0][0], "gt": gt,
                                "single": w[0][1],
                                "multi": min((x[1] for x in w), key=lambda d: RANK[d]),
                                "flips": len({x[1] for x in w}) > 1})
            print(f"  {s['file']} {s['start_s']}~{s['end_s']}s {s['helmet']}: 프레임 {len(dec)}, 창 {max(0, (len(dec) - WIN) // STRIDE + 1)}")

    lines = [f"영상 {len({s['file'] for s in segs})}개 · 라벨 구간 {len(segs)}개 · 1초 창 {len(windows)}개 (0.25초 간격 4장, 0.5초마다)",
             f"임계값: 지금 게이트 정책 그대로 (안전모 하한 {vision.POLICY['helmet']['low']} / 상한 {vision.POLICY['helmet']['high']})",
             "",
             f"단일 프레임: {fmt(rates(windows, 'single'))}",
             f"1초 4장   : {fmt(rates(windows, 'multi'))}",
             f"창 안에서 판정이 흔들린 비율: {sum(w['flips'] for w in windows)}/{len(windows)}",
             ""]
    by = defaultdict(list)
    for w in windows:
        by[(w["file"], w["note"], w["gt"])].append(w)
    lines.append("영상별 (단일 → 4장, 통과/감독/차단 창 수)")
    for (f, note, gt), ws in sorted(by.items()):
        c1, c2 = Counter(w["single"] for w in ws), Counter(w["multi"] for w in ws)
        g = "착용" if gt else "미착용"
        lines.append(f"  {f} [{g}] {note}: 단일 {c1['pass']}/{c1['supervisor']}/{c1['deny']} → 4장 {c2['pass']}/{c2['supervisor']}/{c2['deny']}")
    rep = "\n".join(lines)
    print("\n" + rep)
    (out_dir / "video_report.txt").write_text(rep, encoding="utf-8")
    with open(out_dir / "video_per_frame.csv", "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=list(per_frame[0].keys()))
        w.writeheader()
        w.writerows(per_frame)
    json.dump({"windows": windows, "single": rates(windows, "single"), "multi": rates(windows, "multi")},
              open(out_dir / "video_report.json", "w"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
