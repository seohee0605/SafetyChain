"""보호구 판정 기본 성능 평가 (4회차 멘토링 준비).

지금 게이트가 쓰는 판정(A)과 보호구 통합 모델(B)을 같은 공개 테스트 사진으로 비교한다.
  A. 현재: 사람 찾기(yolov8n) → 안전모 모델(keremberke/yolov8m-hard-hat-detection) + 안전화는 발 영역 색상 규칙
  B. 보호구 통합 모델: keremberke/yolov8m-protective-equipment-detection (helmet·shoes 클래스 직접 탐지)
  C. 조합: 안전모는 A, 안전화는 B

    cd gate && source ../backend/.venv/bin/activate
    python eval_ppe.py              # 테스트셋에서 500장 (약 10~15분, 첫 실행은 다운로드 약 300MB 포함)
    python eval_ppe.py --limit 0    # 테스트셋 전체 1,935장

결과: gate/eval_out/ (report.txt, report.json, per_image.csv). 데이터·가중치는 gate/eval_data/, gate/models/ (git 제외)
데이터셋: keremberke/protective-equipment-detection (CC BY 4.0, 해외 공개 사진. 국내 현장 사진이 아니다)
"""
import argparse
import csv
import json
import os
import random
import statistics
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

os.environ.setdefault("ULTRALYTICS_SAFE_LOAD", "1")

HERE = Path(__file__).parent
DATA = HERE / "eval_data"
OUT = HERE / "eval_out"
PPE_FULL = HERE / "models" / "ppe_full.pt"
PPE_FULL_URL = "https://huggingface.co/keremberke/yolov8m-protective-equipment-detection/resolve/main/best.pt"
TEST_ZIP_URL = "https://huggingface.co/datasets/keremberke/protective-equipment-detection/resolve/main/data/test.zip"


def download(url: str, dest: Path):
    if dest.exists() and dest.stat().st_size > 0:
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"다운로드: {url}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    try:
        with urllib.request.urlopen(url, timeout=60) as r, open(tmp, "wb") as f:
            total = int(r.headers.get("Content-Length") or 0)
            got = 0
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
                got += len(chunk)
                if total:
                    print(f"\r  {got >> 20}/{total >> 20} MB", end="", flush=True)
        print()
        tmp.rename(dest)
    except Exception as e:  # noqa: BLE001
        print(f"\n다운로드 실패: {e}\n터미널에서 직접 받은 뒤 다시 실행:\n  curl -L -o {dest} {url}")
        sys.exit(1)


def load_test_set():
    zpath = DATA / "test.zip"
    download(TEST_ZIP_URL, zpath)
    root = DATA / "test"
    if not root.exists():
        print("압축 푸는 중...")
        with zipfile.ZipFile(zpath) as z:
            z.extractall(root)
    anns = list(root.rglob("*.json"))
    if not anns:
        print("COCO 주석(json)을 찾지 못했다")
        sys.exit(1)
    images = []
    for ann in anns:
        coco = json.loads(ann.read_text())
        names = {c["id"]: c["name"].lower().replace("-", "_").replace(" ", "_") for c in coco["categories"]}
        labels, boxes = {}, {}
        for a in coco["annotations"]:
            n = names[a["category_id"]]
            labels.setdefault(a["image_id"], set()).add(n)
            x, y, w, h = a["bbox"]
            boxes.setdefault(a["image_id"], []).append((n, (x, y, x + w, y + h)))
        for im in coco["images"]:
            p = ann.parent / im["file_name"]
            if not p.exists():
                found = list(root.rglob(im["file_name"]))
                p = found[0] if found else p
            if p.exists():
                images.append((p, labels.get(im["id"], set()), boxes.get(im["id"], [])))
    return images


def iou(a, b):
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / u if u > 0 else 0.0


def truth(labels: set, item: str):
    """사진 단위 정답. 미착용 표시가 하나라도 있으면 '불합격', 착용 표시만 있으면 '합격', 둘 다 없으면 판단 제외."""
    if f"no_{item}" in labels:
        return False
    if item in labels:
        return True
    return None


def metrics(pairs):
    """pairs: (정답, 예측) — True=합격(착용), False=불합격(미착용)."""
    pairs = [(t, p) for t, p in pairs if t is not None]
    tp_fail = sum(1 for t, p in pairs if t is False and p is False)  # 미착용을 잡음
    fn_fail = sum(1 for t, p in pairs if t is False and p is True)  # 미착용을 놓침 (미탐 → 위험)
    tn_ok = sum(1 for t, p in pairs if t is True and p is True)  # 착용자를 통과시킴
    fp_block = sum(1 for t, p in pairs if t is True and p is False)  # 착용자를 막음 (오탐 → 불편·override 남용)
    n = len(pairs)
    f = tp_fail + fn_fail
    o = tn_ok + fp_block
    return {
        "n": n, "violations": f, "compliant": o,
        "accuracy": round((tp_fail + tn_ok) / n, 3) if n else None,
        "missRate": round(fn_fail / f, 3) if f else None,  # 미착용인데 통과
        "violationRecall": round(tp_fail / f, 3) if f else None,
        "falseBlockRate": round(fp_block / o, 3) if o else None,  # 착용했는데 막힘
        "balancedAccuracy": round(((tp_fail / f) + (tn_ok / o)) / 2, 3) if f and o else None,
        "confusion": {"missedViolation": fn_fail, "caughtViolation": tp_fail, "passedCompliant": tn_ok,
                      "blockedCompliant": fp_block},
    }


def summ(xs):
    xs = sorted(xs)
    if not xs:
        return None
    return {"n": len(xs), "mean": round(statistics.mean(xs), 1), "p50": round(xs[len(xs) // 2], 1),
            "p95": round(xs[min(len(xs) - 1, int(len(xs) * 0.95))], 1), "max": round(xs[-1], 1)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=500, help="평가할 사진 수 (0이면 전체)")
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()

    download(PPE_FULL_URL, PPE_FULL)
    images = load_test_set()
    random.Random(a.seed).shuffle(images)
    if a.limit:
        images = images[: a.limit]
    print(f"평가 사진 {len(images)}장")

    sys.path.insert(0, str(HERE))
    import vision  # 게이트가 실제로 쓰는 판정 코드 그대로
    from ultralytics import YOLO

    full = YOLO(str(PPE_FULL))
    full_names = {i: n.lower().replace("-", "_") for i, n in full.names.items()}
    thr = vision.CONF_THRESHOLD

    # 예열 (모델 로딩 시간은 게이트를 켤 때 한 번만 드므로 사진별 시간에서 뺀다)
    vision.check_ppe(str(images[0][0]))  # noqa
    full.predict(source=str(images[0][0]), verbose=False)

    rows = []
    t_a, t_b = [], []
    overlap = {}  # 정답 상자(helmet·no_helmet·shoes·no_shoes) 위에 B 모델이 붙인 이름 → 라벨 매핑 점검
    for i, (path, labels, gtb) in enumerate(images, 1):
        s = time.perf_counter()
        a_res = vision.check_ppe(str(path))  # 게이트와 똑같이 (사람이 없으면 둘 다 불합격)
        t_a.append((time.perf_counter() - s) * 1000)
        gen = vision.get_generic_model().predict(source=str(path), verbose=False)[0]  # 시간 측정 밖
        person = vision._largest_person_box(gen) is not None

        s = time.perf_counter()
        r = full.predict(source=str(path), verbose=False)[0]
        t_b.append((time.perf_counter() - s) * 1000)
        found = set()
        if r.boxes is not None:
            for b, c, conf in zip(r.boxes.xyxy.cpu().numpy(), r.boxes.cls.cpu().numpy(), r.boxes.conf.cpu().numpy()):
                if conf >= thr:
                    pname = full_names[int(c)]
                    found.add(pname)
                    for gname, gbox in gtb:
                        if gname in ("helmet", "no_helmet", "shoes", "no_shoes") and iou(tuple(map(float, b)), gbox) >= 0.5:
                            key = f"{gname} -> {pname}"
                            overlap[key] = overlap.get(key, 0) + 1
        b_res = {"helmetPass": "helmet" in found and "no_helmet" not in found,
                 "shoesPass": "shoes" in found and "no_shoes" not in found}

        rows.append({
            "file": path.name, "labels": "|".join(sorted(labels)), "personDetected": person,
            "gtHelmet": truth(labels, "helmet"), "gtShoes": truth(labels, "shoes"),
            "A_helmet": a_res["helmetPass"], "A_shoes": a_res["shoesPass"],
            "B_helmet": b_res["helmetPass"], "B_shoes": b_res["shoesPass"],
            "B_found": "|".join(sorted(found)),
        })
        if i % 50 == 0:
            print(f"  {i}/{len(images)}")

    def block(subset):
        return {
            "A_current": {"helmet": metrics([(x["gtHelmet"], x["A_helmet"]) for x in subset]),
                          "shoes": metrics([(x["gtShoes"], x["A_shoes"]) for x in subset])},
            "B_ppeModel": {"helmet": metrics([(x["gtHelmet"], x["B_helmet"]) for x in subset]),
                           "shoes": metrics([(x["gtShoes"], x["B_shoes"]) for x in subset])},
            "C_combo": {"helmet": metrics([(x["gtHelmet"], x["A_helmet"]) for x in subset]),
                        "shoes": metrics([(x["gtShoes"], x["B_shoes"]) for x in subset])},
        }

    person_rows = [x for x in rows if x["personDetected"]]
    report = {
        "images": len(rows),
        "personDetected": len(person_rows),
        "confThreshold": thr,
        "all": block(rows),
        "personOnly": block(person_rows),  # 게이트처럼 사람이 찍힌 사진만
        "latencyMs": {"A_current": summ(t_a), "B_ppeModel": summ(t_b)},
        "models": {"A": ["yolov8n.pt (COCO person)", "ppe.pt = keremberke/yolov8m-hard-hat-detection", "안전화: 발 영역 어두운 색 15% 규칙"],
                   "B": ["ppe_full.pt = keremberke/yolov8m-protective-equipment-detection"]},
        "dataset": "keremberke/protective-equipment-detection test split (CC BY 4.0)",
        "B_labelOnGtBoxes": dict(sorted(overlap.items(), key=lambda kv: -kv[1])),
        "B_names": full_names,
    }
    OUT.mkdir(exist_ok=True)
    (OUT / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    with (OUT / "per_image.csv").open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    lines = [f"평가 사진 {len(rows)}장 (사람 검출 {len(person_rows)}장), 신뢰도 기준 {thr}", ""]
    for title, key in (("전체 사진", "all"), ("사람이 검출된 사진만 (게이트 조건)", "personOnly")):
        lines.append(f"[{title}]")
        for pipe, label in (("A_current", "A 현재"), ("B_ppeModel", "B 보호구 모델"), ("C_combo", "C 조합")):
            for item, kor in (("helmet", "안전모"), ("shoes", "안전화")):
                m = report[key][pipe][item]
                lines.append(
                    f"  {label:<10} {kor}  n={m['n']:<4} 정확도 {m['accuracy']}  균형정확도 {m['balancedAccuracy']}"
                    f"  미착용 놓침 {m['missRate']}  착용자 막음 {m['falseBlockRate']}  (미착용 {m['violations']} / 착용 {m['compliant']})")
        lines.append("")
    lines.append(f"[사진 1장 처리 시간] A 현재 {report['latencyMs']['A_current']}  B 보호구 모델 {report['latencyMs']['B_ppeModel']}")
    lines.append("")
    lines.append(f"[B 모델 클래스 순서] {full_names}")
    lines.append("[정답 상자 위에 B 모델이 붙인 이름 (IoU 0.5 이상)] " + ", ".join(f"{k}: {v}" for k, v in report["B_labelOnGtBoxes"].items()))
    text = "\n".join(lines)
    (OUT / "report.txt").write_text(text, encoding="utf-8")
    print("\n" + text)


if __name__ == "__main__":
    main()
