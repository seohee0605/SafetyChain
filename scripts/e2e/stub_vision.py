"""E2E 스모크 테스트용 vision 대역(stub).

스모크 테스트는 임시 폴더에 복사한 gate/의 vision.py만 이 파일로 바꿔서 돌린다 (원본 gate/는 그대로).
YOLO 가중치·torch 없이 판정을 정해서 돌려주므로, 블록체인·릴레이·감사 저장소 흐름만 검증한다.
AI 판정 성능은 gate/eval_*.py 평가 스크립트가 따로 다룬다.

판정 규칙: 사진 바이트 안에 b"HELMET:pass"가 있으면 안전모 통과, 그 밖에는 불합격.
안전화는 실제 정책과 같이 항상 감독자 확인 구간(supervisor)이라 키오스크 체크값을 따른다.
"""

import json

from web3 import Web3

POLICY = {
    "version": "e2e-stub",
    "helmet": {"rule": "bytes contain HELMET:pass -> pass, otherwise deny"},
    "shoes": {"rule": "always supervisor (same as the real policy)"},
    "frames": {"min": 3, "max": 5, "rule": "worst frame decides; fewer than min -> no auto pass"},
}

_RANK = {"deny": 0, "supervisor": 1, "pass": 2}


def get_policy() -> dict:
    return POLICY


def get_model_hash() -> bytes:
    return Web3.keccak(text=json.dumps(POLICY, sort_keys=True, separators=(",", ":")))


def check_ppe(image_path: str) -> dict:
    with open(image_path, "rb") as f:
        data = f.read()
    passed = b"HELMET:pass" in data
    decision = "pass" if passed else "deny"
    return {
        "person": True,
        "helmetPass": passed,
        "helmetDecision": decision,
        "helmetScore": 0.9 if passed else -0.9,
        "shoesDecision": "supervisor",
        "shoesScoreAI": 0.0,
        "shoesOpinion": "not_work_like",
    }


def check_frames(image_paths: list[str]) -> dict:
    if not 1 <= len(image_paths) <= POLICY["frames"]["max"]:
        raise ValueError(f"프레임 수는 1~{POLICY['frames']['max']}장이어야 한다 (받은 수 {len(image_paths)})")
    frames = [check_ppe(p) for p in image_paths]
    enough = len(frames) >= POLICY["frames"]["min"]

    def combine(key):
        d = min((f[key] for f in frames), key=lambda x: _RANK[x])
        return "supervisor" if d == "pass" and not enough else d

    worst = min(range(len(frames)), key=lambda i: frames[i]["helmetScore"])
    helmet = combine("helmetDecision")
    return {
        "person": True,
        "helmetPass": helmet == "pass",
        "helmetDecision": helmet,
        "helmetScore": frames[worst]["helmetScore"],
        "shoesDecision": combine("shoesDecision"),
        "shoesScoreAI": 0.0,
        "shoesOpinion": "not_work_like",
        "frameCount": len(frames),
        "enoughFrames": enough,
        "worstIndex": worst,
        "frames": [{"helmetDecision": f["helmetDecision"], "helmetScore": f["helmetScore"],
                    "shoesDecision": f["shoesDecision"]} for f in frames],
    }
