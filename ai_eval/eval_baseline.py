"""AI 기본 성능 측정: 공개 PPE 테스트셋으로 지금 쓰는 모델과 후보 모델을 같은 기준으로 잰다.

    cd ~/Desktop/safetychain/dev
    source backend/.venv/bin/activate
    python ai_eval/eval_baseline.py                # 테스트셋에서 500장 (약 15~25분)
    python ai_eval/eval_baseline.py --limit 100    # 빠르게 확인 (약 5분)

비교하는 모델
  A. 현재 게이트 모델: gate/models/ppe.pt (keremberke/yolov8m-hard-hat-detection, 안전모 2클래스)
  B. 후보: keremberke/yolov8s-protective-equipment-detection (기획서에 적은 모델, 10클래스 - 안전화 포함)
  C. 후보: keremberke/yolov8m-protective-equipment-detection (B와 같은 데이터, 더 큰 모델)

데이터: keremberke/protective-equipment-detection 의 test 분할 (CC BY 4.0, 공개 데이터라 국내 현장 사진이 아님)
지표: 클래스별 precision / recall (conf 0.25, IoU 0.5), AP50, 사진 한 장 추론 시간
결과: ai_eval/out/ (results.json, summary.txt, 예시 이미지)

새 라이브러리 없이 표준 라이브러리 + 게이트에 이미 있는 ultralytics만 쓴다. 인터넷으로 Hugging Face에서 내려받는다.
"""
import argparse
import json
import random
import shutil
import statistics
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

HERE = Path(__file__).parent
CACHE = HERE / "cache"
OUT = HERE / "out"
DATASET = "keremberke/protective-equipment-detection"
MODELS = {
    "A_current_hardhat_m": None,  # gate/models/ppe.pt
    "B_ppe_v8s": "keremberke/yolov8s-protective-equipment-detection",
    "C_ppe_v8m": "keremberke/yolov8m-protective-equipment-detection",
}
# 모델 A의 클래스를 테스트셋 클래스 이름으로 맞춘다
A_MAP = {"Hardhat": "helmet", "NO-Hardhat": "no_helmet"}
# 우리 서비스가 판정에 쓰는 클래스 (나머지는 참고용)
KEY_CLASSES = ["helmet", "no_helmet", "shoes", "no_shoes"]


# ----------------------------------------------------------------------
# 내려받기 (huggingface.co 공개 파일)
# ----------------------------------------------------------------------


def _get(url: str, dest: Path):
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"  내려받는 중: {url}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url, timeout=600) as r, tmp.open("wb") as f:
        shutil.copyfileobj(r, f)
    tmp.rename(dest)
    return dest


def _files(kind: str, repo: str) -> list[str]:
    with urllib.request.urlopen(f"https://huggingface.co/api/{kind}/{repo}", timeout=60) as r:
        return [s["rfilename"] for s in json.load(r).get("siblings", [])]


def fetch_model(repo: str) -> Path:
    pts = [f for f in _files("models", repo) if f.endswith(".pt")]
    if not pts:
        raise SystemExit(f"{repo}에 .pt 파일이 없다")
    name = "best.pt" if "best.pt" in pts else pts[0]
    return _get(f"https://huggingface.co/{repo}/resolve/main/{name}", CACHE / "models" / repo.replace("/", "__") / name)


def fetch_testset() -> tuple[Path, Path]:
    files = _files("datasets", DATASET)
    zips = [f for f in files if f.endswith(".zip") and "test" in f.lower()]
    if not zips:
        raise SystemExit(f"테스트 분할 zip을 못 찾았다. 파일 목록: {files[:20]}")
    z = _get(f"https://huggingface.co/datasets/{DATASET}/resolve/main/{zips[0]}", CACHE / "data" / Path(zips[0]).name)
    root = CACHE / "data" / "test"
    if not root.exists():
        with zipfile.ZipFile(z) as zf:
            zf.extractall(root)
    ann = next(root.rglob("*.json"))
    return root, ann


# ----------------------------------------------------------------------
# 평가
# ----------------------------------------------------------------------


def iou(a, b):
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / u if u > 0 else 0.0


def ap50(scored: list[tuple[float, bool]], n_gt: int) -> float | None:
    """모든 점 보간 AP (VOC 2010 이후 방식)."""
    if n_gt == 0:
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
    ap, prev_r = 0.0, 0.0
    for p, r in zip(prec, rec):
        ap += (r - prev_r) * p
        prev_r = r
    return ap


def load_gt(root: Path, ann: Path, limit: int, seed: int):
    coco = json.loads(ann.read_text())
    cats = {c["id"]: c["name"] for c in coco["categories"]}
    imgs = {i["id"]: i for i in coco["images"]}
    gt: dict[int, list] = {i: [] for i in imgs}
    for a in coco["annotations"]:
        x, y, w, h = a["bbox"]
        gt[a["image_id"]].append((cats[a["category_id"]], (x, y, x + w, y + h)))
    ids = sorted(i for i in imgs if gt[i])
    random.Random(seed).shuffle(ids)
    if limit:
        ids = ids[:limit]
    paths = {}
    for i in ids:
        cand = list(root.rglob(imgs[i]["file_name"]))
        if cand:
            paths[i] = cand[0]
    classes = sorted({c for c in cats.values() if c and not c.lower().startswith("protective")})
    return [i for i in ids if i in paths], paths, gt, classes


def evaluate(name, weights, ids, paths, gt, classes, class_map=None):
    from ultralytics import YOLO

    model = YOLO(str(weights))
    names = model.names
    print(f"\n[{name}] 클래스: {list(names.values())}")
    # 첫 장은 모델 로딩·워밍업이라 시간에서 뺀다
    model.predict(source=str(paths[ids[0]]), verbose=False, conf=0.001)
    scored = {c: [] for c in classes}
    n_gt = {c: 0 for c in classes}
    tp25 = {c: 0 for c in classes}
    fp25 = {c: 0 for c in classes}
    times = []
    evaluated = set()
    for k, i in enumerate(ids):
        t = time.perf_counter()
        res = model.predict(source=str(paths[i]), verbose=False, conf=0.001)[0]
        times.append((time.perf_counter() - t) * 1000)
        preds = []
        for b, c, s in zip(res.boxes.xyxy.cpu().numpy(), res.boxes.cls.cpu().numpy(), res.boxes.conf.cpu().numpy()):
            cname = names[int(c)]
            if class_map is not None:
                cname = class_map.get(cname)
            if cname in scored:
                preds.append((cname, tuple(map(float, b)), float(s)))
        model_classes = set(class_map.values()) if class_map is not None else set(classes)
        evaluated |= model_classes
        for c in model_classes:
            g = [box for cc, box in gt[i] if cc == c]
            n_gt[c] += len(g)
            used = [False] * len(g)
            for _, box, s in sorted([p for p in preds if p[0] == c], key=lambda p: -p[2]):
                best, bj = 0.0, -1
                for j, gb in enumerate(g):
                    if not used[j]:
                        v = iou(box, gb)
                        if v > best:
                            best, bj = v, j
                ok = best >= 0.5
                if ok:
                    used[bj] = True
                scored[c].append((s, ok))
                if s >= 0.25:
                    tp25[c] += ok
                    fp25[c] += not ok
        if (k + 1) % 50 == 0:
            print(f"  {k + 1}/{len(ids)}장")
    per = {}
    for c in sorted(evaluated):
        p = tp25[c] / (tp25[c] + fp25[c]) if tp25[c] + fp25[c] else None
        r = tp25[c] / n_gt[c] if n_gt[c] else None
        per[c] = {"gt": n_gt[c], "precision": p, "recall": r, "ap50": ap50(scored[c], n_gt[c])}
    return {"weights": str(weights), "images": len(ids), "msPerImage": {
        "mean": statistics.mean(times), "p50": statistics.median(times),
        "p95": sorted(times)[int(len(times) * 0.95) - 1]}, "perClass": per}


def fmt(v):
    return "  -  " if v is None else f"{v:.3f}"


def summary(res: dict, n: int) -> str:
    lines = [f"테스트셋 {DATASET} / test 분할에서 {n}장 (conf 0.25, IoU 0.5 기준 P·R, AP50)", ""]
    for name, r in res.items():
        if "error" in r:
            lines.append(f"[{name}] 실패: {r['error']}")
            continue
        ms = r["msPerImage"]
        lines.append(f"[{name}] 추론 평균 {ms['mean']:.0f}ms / 중앙 {ms['p50']:.0f}ms / 95% {ms['p95']:.0f}ms")
        lines.append(f"  {'클래스':<12}{'GT':>6}{'P':>8}{'R':>8}{'AP50':>8}")
        per = r["perClass"]
        for c in KEY_CLASSES + [c for c in per if c not in KEY_CLASSES]:
            if c in per:
                x = per[c]
                star = " *" if c in KEY_CLASSES else ""
                lines.append(f"  {c:<12}{x['gt']:>6}{fmt(x['precision']):>8}{fmt(x['recall']):>8}{fmt(x['ap50']):>8}{star}")
        keys = [per[c]["ap50"] for c in KEY_CLASSES if c in per and per[c]["ap50"] is not None]
        if keys:
            lines.append(f"  우리 판정 클래스(*) AP50 평균: {statistics.mean(keys):.3f}")
        lines.append("")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=500)
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)

    print("1) 테스트셋 준비")
    root, ann = fetch_testset()
    ids, paths, gt, classes = load_gt(root, ann, a.limit, a.seed)
    print(f"  {len(ids)}장, 클래스 {classes}")

    print("2) 모델 준비")
    weights = {"A_current_hardhat_m": HERE.parent / "gate" / "models" / "ppe.pt"}
    for k, repo in MODELS.items():
        if repo:
            try:
                weights[k] = fetch_model(repo)
            except Exception as e:  # noqa: BLE001
                print(f"  {repo} 내려받기 실패: {e}")

    print("3) 평가")
    results = {}
    for k in MODELS:
        if k not in weights or not Path(weights[k]).exists():
            results[k] = {"error": "가중치 없음"}
            continue
        try:
            results[k] = evaluate(k, weights[k], ids, paths, gt, classes, A_MAP if k.startswith("A_") else None)
        except Exception as e:  # noqa: BLE001
            results[k] = {"error": str(e)}
        (OUT / "results.json").write_text(json.dumps(
            {"dataset": DATASET, "images": len(ids), "seed": a.seed, "classes": classes, "results": results},
            ensure_ascii=False, indent=2))

    text = summary(results, len(ids))
    (OUT / "summary.txt").write_text(text, encoding="utf-8")
    print("\n" + text)
    print(f"결과: {OUT}/summary.txt, results.json")


if __name__ == "__main__":
    sys.exit(main())
