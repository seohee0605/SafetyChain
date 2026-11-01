"""보호구 판정 (사전학습 가중치 그대로, 파인튜닝 X)

- 안전모: killuminati1/construction-ppe-yolov8 (Apache-2.0, Hard_hat / No-Helmet 클래스) — "후보 K"
    점수 = (Hard_hat 최고 신뢰도) − (No-Helmet 최고 신뢰도), 범위 −1~1
    3단계: 점수 ≥ 상한 → 통과 / 하한 ≤ 점수 < 상한 → 감독자 확인 (AI 저신뢰) / 점수 < 하한 → 불합격
    임계값은 직접 촬영 평가셋(docs/dataset, 266장)에서 측정 전에 정한 절차로 결정 (gate/eval_selfset.py)
- 안전화: AI가 "작업화로 보이는지" 1차로 보고, 확실하지 않으면 감독자 확인으로 넘긴다 (멘토링 4회차 Q2).
    점수 = (Boots 최고 신뢰도) − (No-Boots 최고 신뢰도). 구조는 안전모와 같은 3단계.
    다만 직접 촬영 평가셋에서 구분력(AUC)이 0.28로 믿을 수 있는 점수 구간이 없어서,
    지금 정책은 자동 통과·자동 불합격 구간을 닫아 두었다 (low/high = None → 전부 감독자 확인).
    AI 1차 의견은 키오스크에 참고로 보여주고, 최종 shoesPass는 감독자 육안 체크.
    모델·데이터가 좋아지면 POLICY의 low/high만 열면 되고, 그 변경은 policyHash로 체인에 남는다.
- 사람이 검출되지 않으면 fail-closed (불합격)
- 다중 프레임 (멘토링 4회차 Q3): 키오스크가 1초 동안 3~5장을 찍어 보내고, 모든 프레임이 통과해야 통과.
    항목별로 가장 나쁜 프레임의 판정을 따른다 (불합격 < 감독자 확인 < 통과). 3장 미만이면 자동 통과하지 않고 감독자 확인.
    판정을 가른 프레임(안전모 점수가 가장 낮은 프레임)을 증빙 사진으로 쓴다 (evidenceHash).

policyHash: 가중치 파일 해시 + 판정 정책(임계값·점수 방식)을 하나로 묶은 해시.
CheckIn의 modelHash 칸에 이 값을 넣는다 → 임계값만 바꿔도 값이 달라져서 몰래 관대하게 바꿀 수 없다.

.pt는 pickle이라 ULTRALYTICS_SAFE_LOAD=1로 안전 로더 강제
"""
import json
import os
from pathlib import Path

import numpy as np
from ultralytics import YOLO
from web3 import Web3

os.environ.setdefault("ULTRALYTICS_SAFE_LOAD", "1")

MODELS_DIR = Path(__file__).parent / "models"
MODELS_DIR.mkdir(exist_ok=True)
PPE_WEIGHTS = MODELS_DIR / "cand_killuminati.pt"  # killuminati1/construction-ppe-yolov8
GENERIC_WEIGHTS = MODELS_DIR / "yolov8n.pt"  # ultralytics 공식 COCO 사전학습 가중치 (사람 찾기)

CONF_THRESHOLD = 0.4  # 사람 검출 기준
PERSON_CLASS_ID = 0  # COCO

# 판정 정책. 바꾸면 policyHash가 바뀐다 (modelHash 칸으로 체인에 앵커링).
POLICY = {
    "version": 1,
    "helmet": {
        "model": "killuminati1/construction-ppe-yolov8",
        "score": "max(Hard_hat) - max(No-Helmet)",
        "low": 0.3256,  # 이 아래면 불합격
        "high": 0.5144,  # 이 이상이면 통과, 그 사이는 감독자 확인
        "source": "docs/dataset 266장, 놓침<=5% 먼저 만족 후 차단 최소, 감독자 구간<=10% (2026-11-01)",
    },
    "shoes": {
        "model": "killuminati1/construction-ppe-yolov8",
        "score": "max(Boots) - max(No-Boots)",
        "low": None,  # 자동 불합격 구간 닫힘
        "high": None,  # 자동 통과 구간 닫힘 → 전부 감독자 확인
        "source": "docs/dataset 237장에서 AUC 0.28 (착용자 차단 70~90%) → 신뢰 구간 없음 (2026-11-01)",
    },
    "person": {"model": "yolov8n", "conf": CONF_THRESHOLD},
    "frames": {"min": 3, "max": 5, "rule": "worst frame decides; fewer than min -> no auto pass"},
}

_generic_model: YOLO | None = None
_ppe_model: YOLO | None = None


def get_generic_model() -> YOLO:
    """person 탐지용 COCO 사전학습 모델."""
    global _generic_model
    if _generic_model is None:
        _generic_model = YOLO(str(GENERIC_WEIGHTS))
    return _generic_model


def get_ppe_model() -> YOLO:
    global _ppe_model
    if _ppe_model is None:
        if not PPE_WEIGHTS.exists():
            raise RuntimeError(f"보호구 모델 가중치가 없다: {PPE_WEIGHTS} (python eval_shoes.py 를 한 번 실행하면 내려받는다)")
        _ppe_model = YOLO(str(PPE_WEIGHTS))
    return _ppe_model


def get_policy() -> dict:
    return POLICY


def get_model_hash() -> bytes:
    """앵커링할 policyHash = keccak(보호구 가중치 해시 + 사람 탐지 가중치 해시 + 정책 JSON 해시).
    가중치나 임계값 중 하나라도 바뀌면 값이 달라진다. (CheckIn 구조체의 modelHash 칸에 들어간다)"""
    ppe_hash = Web3.keccak(PPE_WEIGHTS.read_bytes())
    generic_hash = Web3.keccak(GENERIC_WEIGHTS.read_bytes())
    policy_hash = Web3.keccak(text=json.dumps(POLICY, sort_keys=True, ensure_ascii=False, separators=(",", ":")))
    return Web3.keccak(ppe_hash + generic_hash + policy_hash)


def _largest_person_box(result) -> np.ndarray | None:
    boxes = result.boxes
    if boxes is None or len(boxes) == 0:
        return None

    person_mask = (boxes.cls == PERSON_CLASS_ID) & (boxes.conf >= CONF_THRESHOLD)
    if not person_mask.any():
        return None

    xyxy = boxes.xyxy[person_mask].cpu().numpy()
    areas = (xyxy[:, 2] - xyxy[:, 0]) * (xyxy[:, 3] - xyxy[:, 1])
    return xyxy[int(np.argmax(areas))]


def _class_max(result, model) -> dict:
    """클래스 이름(소문자, '-'→'_')별 최고 신뢰도."""
    best: dict[str, float] = {}
    if result.boxes is None:
        return best
    for c, sc in zip(result.boxes.cls.cpu().numpy(), result.boxes.conf.cpu().numpy()):
        name = model.names[int(c)].lower().replace("-", "_")
        best[name] = max(best.get(name, 0.0), float(sc))
    return best


def _decision(item: str, score: float) -> str:
    """3단계. low/high가 None이면 그 쪽 자동 구간은 닫힘 (감독자 확인으로 넘어감)."""
    p = POLICY[item]
    if p["high"] is not None and score >= p["high"]:
        return "pass"
    if p["low"] is not None and score < p["low"]:
        return "deny"
    return "supervisor"


def helmet_decision(score: float) -> str:
    return _decision("helmet", score)


def shoes_decision(score: float) -> str:
    return _decision("shoes", score)


def check_ppe(image_path: str) -> dict:
    """안전모·안전화 3단계 판정.

    helmetPass: 자동 통과일 때만 True (감독자 확인 구간은 False → 체인에 불합격으로 기록, 감독자 Override 대상)
    helmetDecision / shoesDecision: pass / supervisor / deny
    shoesOpinion: AI 1차 의견 (looks_work / not_work_like). 감독자 참고용
    shoesPass는 여기서 내지 않는다 (supervisor면 감독자 육안 체크값, gate/main.py에서 결정)
    """
    generic_result = get_generic_model().predict(source=image_path, verbose=False)[0]
    if _largest_person_box(generic_result) is None:
        return {"person": False, "helmetPass": False, "helmetDecision": "deny", "helmetScore": -1.0,
                "shoesDecision": "deny", "shoesScoreAI": None, "shoesOpinion": None}

    model = get_ppe_model()
    best = _class_max(model.predict(source=image_path, verbose=False, conf=0.001)[0], model)
    helmet_score = round(best.get("hard_hat", 0.0) - best.get("no_helmet", 0.0), 4)
    shoes_score = round(best.get("boots", 0.0) - best.get("no_boots", 0.0), 4)
    decision = helmet_decision(helmet_score)
    return {
        "person": True,
        "helmetPass": decision == "pass",
        "helmetDecision": decision,
        "helmetScore": helmet_score,
        "shoesDecision": shoes_decision(shoes_score),
        "shoesScoreAI": shoes_score,
        "shoesOpinion": "looks_work" if shoes_score > 0 else "not_work_like",
    }


_RANK = {"deny": 0, "supervisor": 1, "pass": 2}


def check_frames(image_paths: list[str]) -> dict:
    """1초 동안 찍은 3~5장을 모두 판정해 하나로 합친다. 모든 프레임이 통과해야 통과.

    항목별 최종 판정 = 가장 나쁜 프레임의 판정. 프레임이 최소 장수보다 적으면 통과 → 감독자 확인으로 낮춘다.
    worstIndex: 안전모 점수가 가장 낮은 프레임 (증빙 사진으로 쓴다).
    """
    if not 1 <= len(image_paths) <= POLICY["frames"]["max"]:
        raise ValueError(f"프레임 수는 1~{POLICY['frames']['max']}장이어야 한다 (받은 수 {len(image_paths)})")
    frames = [check_ppe(p) for p in image_paths]
    enough = len(frames) >= POLICY["frames"]["min"]

    def combine(key):
        d = min((f[key] for f in frames), key=lambda x: _RANK[x])
        return "supervisor" if d == "pass" and not enough else d

    worst = min(range(len(frames)), key=lambda i: frames[i]["helmetScore"])
    shoes_scores = [f["shoesScoreAI"] for f in frames if f["shoesScoreAI"] is not None]
    shoes_min = min(shoes_scores) if shoes_scores else None
    helmet = combine("helmetDecision")
    return {
        "person": all(f["person"] for f in frames),
        "helmetPass": helmet == "pass",
        "helmetDecision": helmet,
        "helmetScore": frames[worst]["helmetScore"],
        "shoesDecision": combine("shoesDecision"),
        "shoesScoreAI": shoes_min,
        "shoesOpinion": None if shoes_min is None else ("looks_work" if shoes_min > 0 else "not_work_like"),
        "frameCount": len(frames),
        "enoughFrames": enough,
        "worstIndex": worst,
        "frames": [{"helmetDecision": f["helmetDecision"], "helmetScore": f["helmetScore"],
                    "shoesDecision": f["shoesDecision"]} for f in frames],
    }
