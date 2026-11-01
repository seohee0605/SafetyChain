"""직접 촬영한 평가셋으로 보호구 판정을 측정한다 (손영성 멘토님 4회차 회신 반영).

평가셋: docs/dataset (labels.csv + jpg_1280/). 측정 방법·채택 기준은 docs/dataset/README.md에 측정 전에 확정했다.
  - 이미지 단위 라벨 (helmet: worn/not_worn, shoes: work/not_work), 제외 행은 해당 항목에서 뺌
  - 판정 3단계: 점수 ≥ 상한 → 통과 / 하한 ≤ 점수 < 상한 → 감독자 확인 / 점수 < 하한 → 차단
  - 임계값: 놓침(미착용 자동 통과) ≤ 5%를 먼저 만족, 그중 차단이 가장 적게, 감독자 구간 ≤ 전체 10%
  - 분할: 세션 하나씩 빼고 돌리기 (뺀 세션은 나머지 세션으로 정한 임계값으로 판정, 8개 세션 결과 합산)
  - 채택 기준: 놓침 ≤ 5%, 차단 ≤ 10%, 감독자 확인 ≤ 10%

비교하는 판정
  current  : 교체 전 게이트 판정 (안전모 = ppe.pt keremberke/yolov8m-hard-hat-detection, 안전화 = 발 영역 어두운 색 비율)
  K        : killuminati1/construction-ppe-yolov8 (Hard_hat/No-Helmet, Boots/No-Boots) = 교체 후 gate/vision.py
             (안전모 점수가 vision.check_ppe()와 같은지 사진마다 대조한다)
  K_crop   : 안전화만. 사람 상자 하단을 원본(1280px) 해상도로 잘라 K에 한 번 더 넣음 (학습 없음, 멘토님 Q2 제안)
점수 = (착용 클래스 최고 신뢰도) − (미착용 클래스 최고 신뢰도), 범위 −1~1. current 안전화는 어두운 색 비율(0~1).
사람이 검출되지 않으면 게이트처럼 fail-closed (점수 −1).

    cd gate && source ../backend/.venv/bin/activate
    python eval_selfset.py                       # 기본 평가셋 경로: ../../docs/dataset
    python eval_selfset.py --dataset /path/to/dataset

결과: gate/eval_out/selfset_report.txt, selfset_report.json, selfset_per_image.csv
"""
import argparse
import csv
import json
import math
import os
import statistics
import sys
import time
from pathlib import Path

os.environ.setdefault("ULTRALYTICS_SAFE_LOAD", "1")

HERE = Path(__file__).parent
OUT = HERE / "eval_out"
K_WEIGHTS = HERE / "models" / "cand_killuminati.pt"
PREV_HELMET_WEIGHTS = HERE / "models" / "ppe.pt"  # 교체 전 안전모 모델

MISS_MAX, BLOCK_MAX, SUPERVISOR_MAX = 0.05, 0.10, 0.10
ALIASES = {"hard_hat": "helmet", "hardhat": "helmet", "no_helmet": "no_helmet", "no_hardhat": "no_helmet",
           "boots": "boots", "no_boots": "no_boots"}
ITEMS = {"helmet": ("helmet", "no_helmet", "worn", "not_worn"), "shoes": ("boots", "no_boots", "work", "not_work")}


def norm(name):
    return ALIASES.get(name.strip().lower().replace("-", "_").replace(" ", "_"))


def detect(model, names, img):
    """클래스별 최고 신뢰도 (conf 0.001까지) + 게이트 고정 규칙(0.4)용 원본."""
    r = model.predict(source=img, verbose=False, conf=0.001)[0]
    best = {}
    if r.boxes is not None:
        for c, sc in zip(r.boxes.cls.cpu().numpy(), r.boxes.conf.cpu().numpy()):
            n = names.get(int(c))
            if n:
                best[n] = max(best.get(n, 0.0), float(sc))
    return best


def score(best, item):
    pos, neg = ITEMS[item][:2]
    return round(best.get(pos, 0.0) - best.get(neg, 0.0), 4)


def gate_rule(best, item, thr):
    """지금 게이트가 쓰는 방식: 착용 ≥ thr 이고 미착용 < thr 이면 통과."""
    pos, neg = ITEMS[item][:2]
    return best.get(pos, 0.0) >= thr and best.get(neg, 0.0) < thr


def fit(train):
    """train: [(정답 착용?, 점수)]. 놓침 ≤ 5% 만족하는 가장 낮은 상한 → 감독자 구간 ≤ 10% 안에서 가장 낮은 하한."""
    neg = [s for ok, s in train if not ok]
    allsc = [s for _, s in train]
    cands = sorted(set(allsc)) + [math.inf]
    hi = math.inf
    for c in cands:
        if not neg or sum(1 for s in neg if s >= c) / len(neg) <= MISS_MAX:
            hi = c
            break
    lo = hi
    for c in cands:
        if c > hi:
            break
        if sum(1 for s in allsc if c <= s < hi) / len(allsc) <= SUPERVISOR_MAX:
            lo = c
            break
    return lo, hi


def decide(s, lo, hi):
    return "pass" if s >= hi else ("supervisor" if s >= lo else "deny")


def upper95(k, n):
    """미착용 n건 중 k건 놓쳤을 때 놓침률의 95% 단측 상한 (Clopper-Pearson)."""
    if n == 0:
        return None
    if k >= n:
        return 1.0
    lo_, hi_ = k / n, 1.0
    for _ in range(60):
        mid = (lo_ + hi_) / 2
        cdf = sum(math.comb(n, i) * mid ** i * (1 - mid) ** (n - i) for i in range(k + 1))
        lo_, hi_ = (mid, hi_) if cdf > 0.05 else (lo_, mid)
    return round(hi_, 4)


def summarize(rows, col):
    """rows: [{ok, decision}] → 놓침·차단·감독자 비율과 기준 통과 여부."""
    neg = [r for r in rows if not r["ok"]]
    pos = [r for r in rows if r["ok"]]
    missed = sum(1 for r in neg if r[col] == "pass")
    blocked = sum(1 for r in pos if r[col] == "deny")
    sup = sum(1 for r in rows if r[col] == "supervisor")
    m = {
        "n": len(rows), "violations": len(neg), "compliant": len(pos),
        "missed": missed, "missRate": round(missed / len(neg), 4) if neg else None,
        "missUpper95": upper95(missed, len(neg)),
        "blocked": blocked, "falseBlockRate": round(blocked / len(pos), 4) if pos else None,
        "supervisor": sup, "supervisorRate": round(sup / len(rows), 4) if rows else None,
        "supervisorViolations": sum(1 for r in neg if r[col] == "supervisor"),
        "supervisorCompliant": sum(1 for r in pos if r[col] == "supervisor"),
    }
    m["meetsCriteria"] = bool(neg and pos and m["missRate"] <= MISS_MAX and m["falseBlockRate"] <= BLOCK_MAX
                              and m["supervisorRate"] <= SUPERVISOR_MAX)
    return m


def binary_summary(rows, col):
    neg = [r for r in rows if not r["ok"]]
    pos = [r for r in rows if r["ok"]]
    missed = sum(1 for r in neg if r[col])
    blocked = sum(1 for r in pos if not r[col])
    return {"n": len(rows), "missed": missed, "missRate": round(missed / len(neg), 4) if neg else None,
            "blocked": blocked, "falseBlockRate": round(blocked / len(pos), 4) if pos else None}


def dark_ratio(region):
    """교체 전 게이트의 안전화 규칙: 발 영역에서 어두운 색 픽셀 비율 (0.15 초과면 통과)."""
    import cv2
    import numpy as np
    if region.size == 0:
        return 0.0
    hsv = cv2.cvtColor(region, cv2.COLOR_BGR2HSV)
    dark = cv2.inRange(hsv, (0, 0, 0), (180, 255, 70))
    return float(np.count_nonzero(dark)) / dark.size


def summ(xs):
    xs = sorted(xs)
    return {"p50": round(xs[len(xs) // 2], 1), "p95": round(xs[min(len(xs) - 1, int(len(xs) * 0.95))], 1)} if xs else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default=str(HERE.parent.parent / "docs" / "dataset"))
    a = ap.parse_args()
    ds = Path(a.dataset)
    labels = list(csv.DictReader(open(ds / "labels.csv", encoding="utf-8-sig")))
    print(f"평가셋 {len(labels)}장 ({ds})")

    sys.path.insert(0, str(HERE))
    import cv2
    import vision  # 교체 후 게이트 판정 코드
    from ultralytics import YOLO

    generic = vision.get_generic_model()
    hard = YOLO(str(PREV_HELMET_WEIGHTS))
    k = YOLO(str(K_WEIGHTS))
    hard_names = {i: norm(n) for i, n in hard.names.items()}
    k_names = {i: norm(n) for i, n in k.names.items()}
    thr = vision.CONF_THRESHOLD

    first = str(ds / labels[0]["jpg_path"])
    vision.check_ppe(first)
    hard.predict(source=first, verbose=False)
    k.predict(source=first, verbose=False)

    per, times = [], {"current": [], "K": [], "K_crop": []}
    for i, lab in enumerate(labels, 1):
        path = str(ds / lab["jpg_path"])
        img = cv2.imread(path)
        t0 = time.perf_counter()
        gen = generic.predict(source=img, verbose=False)[0]
        box = vision._largest_person_box(gen)
        t_person = time.perf_counter() - t0
        row = {"file": lab["file"], "session": lab["session"], "trap": lab["trap"], "person": box is not None}

        s = time.perf_counter()
        hb = detect(hard, hard_names, img)
        times["current"].append((time.perf_counter() - s + t_person) * 1000)
        if box is not None:
            x1, y1, x2, y2 = box.astype(int)
            h = y2 - y1
            dark = dark_ratio(img[y2 - int(h * 0.15): y2, x1:x2])
        else:
            dark = 0.0
        row["current_helmet_score"] = score(hb, "helmet") if box is not None else -1.0
        row["current_shoes_score"] = round(dark, 4) if box is not None else -1.0
        row["current_helmet_gate"] = gate_rule(hb, "helmet", thr) if box is not None else False
        row["current_shoes_gate"] = dark > 0.15 if box is not None else False

        s = time.perf_counter()
        kb = detect(k, k_names, img)
        times["K"].append((time.perf_counter() - s + t_person) * 1000)
        for item in ("helmet", "shoes"):
            row[f"K_{item}_score"] = score(kb, item) if box is not None else -1.0
            row[f"K_{item}_gate"] = gate_rule(kb, item, thr) if box is not None else False
        gate_now = vision.check_ppe(path)  # 교체 후 게이트가 실제로 내는 값과 대조
        row["gate_helmetScore"], row["gate_helmetDecision"] = gate_now["helmetScore"], gate_now["helmetDecision"]
        row["gate_matches_K"] = abs(gate_now["helmetScore"] - row["K_helmet_score"]) < 1e-3

        if box is not None:
            x1, y1, x2, y2 = box.astype(int)
            h, w = y2 - y1, x2 - x1
            H, W = img.shape[:2]
            cy1 = max(0, y2 - int(h * 0.35))
            cy2 = min(H, y2 + int(h * 0.05))
            cx1, cx2 = max(0, x1 - int(w * 0.15)), min(W, x2 + int(w * 0.15))
            s = time.perf_counter()
            cb = detect(k, k_names, img[cy1:cy2, cx1:cx2])
            times["K_crop"].append((time.perf_counter() - s) * 1000 + times["K"][-1])
            row["K_crop_shoes_score"] = score(cb, "shoes")
            row["K_crop_shoes_gate"] = gate_rule(cb, "shoes", thr)
        else:
            row["K_crop_shoes_score"], row["K_crop_shoes_gate"] = -1.0, False

        for item, (_, _, yes, no) in ITEMS.items():
            excluded = lab[f"exclude_{item}"] == "Y" or lab[item] not in (yes, no)
            row[f"gt_{item}"] = None if excluded else (lab[item] == yes)
        per.append(row)
        if i % 25 == 0:
            print(f"  {i}/{len(labels)}")

    pipes = {"helmet": ["current", "K"], "shoes": ["current", "K", "K_crop"]}
    sessions = sorted({r["session"] for r in per})
    report = {"images": len(per), "dataset": str(ds), "criteria": {"miss": MISS_MAX, "block": BLOCK_MAX, "supervisor": SUPERVISOR_MAX},
              "gateConfThreshold": thr, "results": {}, "latencyMs": {k_: summ(v) for k_, v in times.items()}}
    for item, plist in pipes.items():
        report["results"][item] = {}
        rows_item = [r for r in per if r[f"gt_{item}"] is not None]
        for p in plist:
            sc = f"{p}_{item}_score"
            dec = f"{p}_{item}_dec"
            folds = {}
            for s_ in sessions:
                train = [(r[f"gt_{item}"], r[sc]) for r in rows_item if r["session"] != s_]
                lo, hi = fit(train)
                folds[s_] = {"lo": lo, "hi": hi}
                for r in rows_item:
                    if r["session"] == s_:
                        r[dec] = decide(r[sc], lo, hi)
            ev = [{"ok": r[f"gt_{item}"], "d": r[dec], "session": r["session"], "trap": r["trap"]} for r in rows_item]
            lo_f, hi_f = fit([(r[f"gt_{item}"], r[sc]) for r in rows_item])
            res = {
                "loso": summarize(ev, "d"),
                "perSession": {s_: summarize([e for e in ev if e["session"] == s_], "d") for s_ in sessions},
                "trapMissed": {},
                "foldThresholds": {s_: {"lo": round(v["lo"], 4) if v["lo"] != math.inf else "inf",
                                        "hi": round(v["hi"], 4) if v["hi"] != math.inf else "inf"} for s_, v in folds.items()},
                "finalThresholds": {"lo": round(lo_f, 4) if lo_f != math.inf else "inf",
                                    "hi": round(hi_f, 4) if hi_f != math.inf else "inf"},
                "currentGateRule": binary_summary([{"ok": r[f"gt_{item}"], "g": r[f"{p}_{item}_gate"]} for r in rows_item], "g"),
            }
            for e in ev:
                if not e["ok"]:
                    t = e["trap"] or "(없음)"
                    d = res["trapMissed"].setdefault(t, {"n": 0, "missed": 0, "supervisor": 0})
                    d["n"] += 1
                    d["missed"] += e["d"] == "pass"
                    d["supervisor"] += e["d"] == "supervisor"
            report["results"][item][p] = res

    OUT.mkdir(exist_ok=True)
    (OUT / "selfset_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    with (OUT / "selfset_per_image.csv").open("w", newline="", encoding="utf-8-sig") as f:
        keys = list(per[0].keys()) + sorted({k_ for r in per for k_ in r} - set(per[0].keys()))
        w = csv.DictWriter(f, fieldnames=keys)
        w.writeheader()
        w.writerows(per)

    kor = {"helmet": "안전모", "shoes": "안전화"}
    pct = lambda x: "-" if x is None else f"{x * 100:.1f}%"  # noqa: E731
    L = [f"직접 촬영 평가셋 {len(per)}장 · 세션 {len(sessions)}개 · 세션 하나씩 빼고 돌리기",
         f"채택 기준: 놓침 ≤ {pct(MISS_MAX)}, 차단 ≤ {pct(BLOCK_MAX)}, 감독자 확인 ≤ {pct(SUPERVISOR_MAX)}", ""]
    for item, plist in pipes.items():
        L.append(f"[{kor[item]}]")
        for p in plist:
            r = report["results"][item][p]
            m = r["loso"]
            g = r["currentGateRule"]
            L.append(f"  {p:<8} 놓침 {pct(m['missRate'])} ({m['missed']}/{m['violations']}, 95% 상한 {pct(m['missUpper95'])})"
                     f"  차단 {pct(m['falseBlockRate'])} ({m['blocked']}/{m['compliant']})"
                     f"  감독자 {pct(m['supervisorRate'])} ({m['supervisor']}/{m['n']})"
                     f"  → {'기준 통과' if m['meetsCriteria'] else '기준 미달'}")
            L.append(f"           시연용 임계값(전체로 결정) 하한 {r['finalThresholds']['lo']} / 상한 {r['finalThresholds']['hi']}"
                     f"   | 참고: 지금 게이트 고정 규칙 놓침 {pct(g['missRate'])} ({g['missed']}) 차단 {pct(g['falseBlockRate'])} ({g['blocked']})")
            traps = ", ".join(f"{t} {d['missed']}/{d['n']}" for t, d in sorted(r["trapMissed"].items()))
            L.append(f"           함정별 놓침: {traps}")
            ses = ", ".join(f"{s_[:3]} 놓침{v['missed']}/{v['violations']} 차단{v['blocked']}/{v['compliant']} 감독{v['supervisor']}"
                            for s_, v in r["perSession"].items())
            L.append(f"           세션별: {ses}")
        L.append("")
    mism = sum(1 for r in per if not r["gate_matches_K"])
    report["gateMatchesK"] = {"mismatch": mism, "images": len(per)}
    (OUT / "selfset_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    L.append(f"[교체 후 vision.check_ppe 안전모 점수 = K 측정 점수] 불일치 {mism}/{len(per)}장")
    L.append(f"[처리 시간 ms, 사람 찾기 포함] {report['latencyMs']}")
    text = "\n".join(L)
    (OUT / "selfset_report.txt").write_text(text, encoding="utf-8")
    print("\n" + text)


if __name__ == "__main__":
    main()
