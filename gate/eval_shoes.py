"""안전화(+안전모) 공개 모델 평가: 우리 게이트와 다른 출처의 공개 데이터로 잰다 (4회차 멘토링 준비).

데이터: Ultralytics Construction-PPE (boots / no_boots 라벨, AGPL-3.0) test+val 분할
비교:
  현재   : gate/vision.py 그대로 (안전모 = keremberke/yolov8m-hard-hat-detection, 안전화 = 발 영역 색상 규칙)
  후보 K : killuminati1/construction-ppe-yolov8 (Boots / No-Boots 포함 19클래스, Apache-2.0)
  후보 N : Nexus3/yolov8n-ppe-detection-6classes (safety_shoe 포함 6클래스, MIT)

    cd gate && source ../backend/.venv/bin/activate
    python eval_shoes.py           # 처음엔 내려받기 약 200MB 포함 5~10분

결과: gate/eval_out/shoes_report.txt, shoes_report.json, shoes_per_image.csv
"""
import argparse
import csv
import json
import os
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
DATA_URL = "https://github.com/ultralytics/assets/releases/download/v0.0.0/construction-ppe.zip"
GT_NAMES = ["helmet", "gloves", "vest", "boots", "goggles", "none", "person", "no_helmet", "no_goggle", "no_gloves", "no_boots"]
CANDIDATES = {
    "K_killuminati": ("https://huggingface.co/killuminati1/construction-ppe-yolov8/resolve/main/best.pt",
                      HERE / "models" / "cand_killuminati.pt"),
    "N_nexus3": ("https://huggingface.co/Nexus3/yolov8n-ppe-detection-6classes/resolve/main/best.pt",
                 HERE / "models" / "cand_nexus3.pt"),
}
# 모델마다 다른 클래스 이름을 공통 이름으로 맞춘다
ALIASES = {
    "boots": "boots", "boot": "boots", "safety_shoe": "boots", "safety_shoes": "boots", "shoes": "boots",
    "no_boots": "no_boots", "no_boot": "no_boots", "no_shoes": "no_boots", "no_safety_shoe": "no_boots",
    "helmet": "helmet", "hardhat": "helmet", "hard_hat": "helmet",
    "no_helmet": "no_helmet", "no_hardhat": "no_helmet", "no_hard_hat": "no_helmet",
}
ITEMS = {"helmet": ("helmet", "no_helmet"), "shoes": ("boots", "no_boots")}


def norm(name: str):
    return ALIASES.get(name.strip().lower().replace("-", "_").replace(" ", "_"))


def download(url: str, dest: Path):
    if dest.exists() and dest.stat().st_size > 1000:
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"다운로드: {url}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    try:
        with urllib.request.urlopen(url, timeout=120) as r, open(tmp, "wb") as f:
            while chunk := r.read(1 << 20):
                f.write(chunk)
        tmp.rename(dest)
    except Exception as e:  # noqa: BLE001
        print(f"다운로드 실패: {e}\n터미널에서 직접 받은 뒤 다시 실행:\n  curl -L -o {dest} {url}")
        sys.exit(1)


def load_images(splits):
    z = DATA / "construction-ppe.zip"
    download(DATA_URL, z)
    root = DATA / "construction-ppe"
    if not root.exists():
        print("압축 푸는 중...")
        with zipfile.ZipFile(z) as f:
            f.extractall(DATA)
    out = []
    for split in splits:
        imgs = [p for p in root.rglob("*") if p.suffix.lower() in (".jpg", ".jpeg", ".png")
                and (f"/images/{split}/" in str(p) or f"/{split}/images/" in str(p))]
        if not imgs:
            print(f"  '{split}' 분할 사진을 못 찾았다 (폴더 구조 확인 필요)")
        for p in sorted(imgs):
            sp = str(p)
            sp = sp.replace(f"/images/{split}/", f"/labels/{split}/") if f"/images/{split}/" in sp else sp.replace(f"/{split}/images/", f"/{split}/labels/")
            lab = Path(sp).with_suffix(".txt")
            boxes = []
            if lab.exists():
                from PIL import Image
                w, h = Image.open(p).size
                for line in lab.read_text().split("\n"):
                    parts = line.split()
                    if len(parts) >= 5:
                        c, cx, cy, bw, bh = int(parts[0]), *map(float, parts[1:5])
                        n = norm(GT_NAMES[c]) if c < len(GT_NAMES) else None
                        if n:
                            boxes.append((n, ((cx - bw / 2) * w, (cy - bh / 2) * h, (cx + bw / 2) * w, (cy + bh / 2) * h)))
            out.append((p, boxes))
    return out


def iou(a, b):
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / u if u > 0 else 0.0


def ap50(scored, n_gt):
    if not n_gt:
        return None
    scored = sorted(scored, key=lambda x: -x[0])
    tp = fp = 0
    prec, rec = [], []
    for _, ok in scored:
        tp += ok
        fp += not ok
        prec.append(tp / (tp + fp))
        rec.append(tp / n_gt)
    for i in range(len(prec) - 2, -1, -1):
        prec[i] = max(prec[i], prec[i + 1])
    ap, prev = 0.0, 0.0
    for p, r in zip(prec, rec):
        ap += (r - prev) * p
        prev = r
    return round(ap, 3)


def truth(boxes, item):
    pos, neg = ITEMS[item]
    names = {n for n, _ in boxes}
    if neg in names:
        return False
    if pos in names:
        return True
    return None


def gate_metrics(pairs):
    pairs = [(t, p) for t, p in pairs if t is not None]
    f = [p for t, p in pairs if t is False]
    o = [p for t, p in pairs if t is True]
    return {
        "n": len(pairs), "violations": len(f), "compliant": len(o),
        "accuracy": round(sum(1 for t, p in pairs if t == p) / len(pairs), 3) if pairs else None,
        "missRate": round(sum(1 for p in f if p) / len(f), 3) if f else None,  # 미착용인데 통과
        "falseBlockRate": round(sum(1 for p in o if not p) / len(o), 3) if o else None,  # 착용했는데 막힘
        "missed": sum(1 for p in f if p), "blocked": sum(1 for p in o if not p),
    }


def summ(xs):
    xs = sorted(xs)
    return {"p50": round(xs[len(xs) // 2], 1), "p95": round(xs[min(len(xs) - 1, int(len(xs) * 0.95))], 1)} if xs else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--splits", default="test,val")
    a = ap.parse_args()
    for url, dest in CANDIDATES.values():
        download(url, dest)
    images = load_images(a.splits.split(","))
    print(f"평가 사진 {len(images)}장")

    sys.path.insert(0, str(HERE))
    import vision
    from ultralytics import YOLO

    models = {k: YOLO(str(dest)) for k, (_, dest) in CANDIDATES.items()}
    models["A_hardhat(현재 안전모)"] = vision.get_helmet_model()
    thr = vision.CONF_THRESHOLD
    names = {k: {i: norm(n) for i, n in m.names.items()} for k, m in models.items()}

    # 예열
    vision.check_ppe(str(images[0][0]))
    for m in models.values():
        m.predict(source=str(images[0][0]), verbose=False)

    box = {k: {c: {"scored": [], "gt": 0, "tp": 0, "fp": 0} for c in ("helmet", "no_helmet", "boots", "no_boots")} for k in models}
    rows, times = [], {k: [] for k in list(models) + ["current"]}
    for idx, (path, gt) in enumerate(images, 1):
        row = {"file": path.name, "gt": "|".join(sorted({n for n, _ in gt})),
               "gtHelmet": truth(gt, "helmet"), "gtShoes": truth(gt, "shoes")}
        s = time.perf_counter()
        cur = vision.check_ppe(str(path))
        times["current"].append((time.perf_counter() - s) * 1000)
        row["current_helmet"], row["current_shoes"] = cur["helmetPass"], cur["shoesPass"]
        for k, m in models.items():
            s = time.perf_counter()
            r = m.predict(source=str(path), verbose=False, conf=0.001)[0]
            times[k].append((time.perf_counter() - s) * 1000)
            preds = []
            if r.boxes is not None:
                for b, c, sc in zip(r.boxes.xyxy.cpu().numpy(), r.boxes.cls.cpu().numpy(), r.boxes.conf.cpu().numpy()):
                    n = names[k].get(int(c))
                    if n:
                        preds.append((n, tuple(map(float, b)), float(sc)))
            for c, st in box[k].items():
                if c not in names[k].values():
                    continue
                g = [bb for n, bb in gt if n == c]
                st["gt"] += len(g)
                used = [False] * len(g)
                for _, bb, sc in sorted([p for p in preds if p[0] == c], key=lambda p: -p[2]):
                    best, bj = 0.0, -1
                    for j, gb in enumerate(g):
                        if not used[j] and iou(bb, gb) > best:
                            best, bj = iou(bb, gb), j
                    ok = best >= 0.5
                    if ok:
                        used[bj] = True
                    st["scored"].append((sc, ok))
                    if sc >= 0.25:
                        st["tp" if ok else "fp"] += 1
            found = {p[0] for p in preds if p[2] >= thr}
            has = set(names[k].values())
            if "helmet" in has:
                row[f"{k}_helmet"] = "helmet" in found and "no_helmet" not in found
            if "boots" in has:
                row[f"{k}_shoes"] = "boots" in found and "no_boots" not in found
        rows.append(row)
        if idx % 50 == 0:
            print(f"  {idx}/{len(images)}")

    report = {"images": len(images), "dataset": "Ultralytics Construction-PPE (" + a.splits + ")", "confThreshold": thr,
              "box": {}, "gate": {}, "latencyMs": {k: summ(v) for k, v in times.items()},
              "classNames": {k: {i: n for i, n in m.names.items()} for k, m in models.items()}}
    for k, cls in box.items():
        report["box"][k] = {}
        for c, st in cls.items():
            if c not in names[k].values():
                continue
            p = st["tp"] / (st["tp"] + st["fp"]) if st["tp"] + st["fp"] else None
            report["box"][k][c] = {"gt": st["gt"], "precision": round(p, 3) if p is not None else None,
                                   "recall": round(st["tp"] / st["gt"], 3) if st["gt"] else None,
                                   "ap50": ap50(st["scored"], st["gt"])}
    for item in ("helmet", "shoes"):
        report["gate"][item] = {}
        for k in ["current"] + list(models):
            col = f"{k}_{item}"
            if col in rows[0]:
                report["gate"][item][k] = gate_metrics([(r[f"gt{item.capitalize()}"], r[col]) for r in rows])

    OUT.mkdir(exist_ok=True)
    (OUT / "shoes_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    with (OUT / "shoes_per_image.csv").open("w", newline="", encoding="utf-8-sig") as f:
        keys = sorted({k for r in rows for k in r})
        w = csv.DictWriter(f, fieldnames=keys)
        w.writeheader()
        w.writerows(rows)

    lines = [f"평가 사진 {len(images)}장 · {report['dataset']} · 판정 신뢰도 {thr}", "", "[게이트 판정 (사진 단위)]"]
    for item, kor in (("shoes", "안전화"), ("helmet", "안전모")):
        for k, m in report["gate"][item].items():
            lines.append(f"  {kor} {k:<24} n={m['n']:<4} 정확도 {m['accuracy']}  미착용 놓침 {m['missRate']} ({m['missed']}/{m['violations']})"
                         f"  착용자 차단 {m['falseBlockRate']} ({m['blocked']}/{m['compliant']})")
    lines += ["", "[상자 단위 (conf 0.25, IoU 0.5)]"]
    for k, cls in report["box"].items():
        for c, x in cls.items():
            lines.append(f"  {k:<24} {c:<10} GT {x['gt']:<4} P {x['precision']}  R {x['recall']}  AP50 {x['ap50']}")
    lines += ["", f"[처리 시간 ms] {report['latencyMs']}"]
    text = "\n".join(lines)
    (OUT / "shoes_report.txt").write_text(text, encoding="utf-8")
    print("\n" + text)


if __name__ == "__main__":
    main()
