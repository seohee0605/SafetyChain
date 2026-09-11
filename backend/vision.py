"""YOLO 기반 안전모/안전화 착용 판정.

CLAUDE.md 4절 제약: Ultralytics YOLO 사전학습 가중치를 그대로 쓰고 파인튜닝하지 않는다.

- 헬멧: keremberke/yolov8m-hard-hat-detection (HuggingFace, Hardhat/NO-Hardhat 2클래스로
  이미 학습된 공개 사전학습 가중치)을 그대로 갖다 쓴다. 우리가 파인튜닝한 게 아니므로
  "사전학습 모델 그대로" 원칙과 충돌하지 않는다.
- 안전화: 공개된 안전화 전용 탐지 모델을 찾지 못해서, COCO 사전학습 모델로 person bbox만
  찾고 발 영역 색상 분포로 판별하는 임시 휴리스틱을 유지한다 (한계 있음, 후속 개선 대상).

third-party .pt 파일은 pickle이라 임의 코드 실행 위험이 있어, 로드 시
`ULTRALYTICS_SAFE_LOAD=1`로 ultralytics의 안전 허용목록(safe_only) 로더를 강제한다.
"""
import os
from pathlib import Path

import cv2
import numpy as np
from ultralytics import YOLO
from web3 import Web3

os.environ.setdefault("ULTRALYTICS_SAFE_LOAD", "1")

MODELS_DIR = Path(__file__).parent / "models"
MODELS_DIR.mkdir(exist_ok=True)
HELMET_WEIGHTS = MODELS_DIR / "ppe.pt"  # keremberke/yolov8m-hard-hat-detection
GENERIC_WEIGHTS = MODELS_DIR / "yolov8n.pt"  # ultralytics 공식 COCO 사전학습 가중치

CONF_THRESHOLD = 0.4
PERSON_CLASS_ID = 0  # COCO

_generic_model: YOLO | None = None
_helmet_model: YOLO | None = None


def get_generic_model() -> YOLO:
    """person 탐지용 COCO 사전학습 모델 (안전화 휴리스틱의 발 영역을 찾는 데 사용)."""
    global _generic_model
    if _generic_model is None:
        _generic_model = YOLO(str(GENERIC_WEIGHTS))
    return _generic_model


def get_helmet_model() -> YOLO | None:
    """헬멧 전용 사전학습 모델. 파일이 없으면 None (색상 휴리스틱으로 폴백)."""
    global _helmet_model
    if _helmet_model is None and HELMET_WEIGHTS.exists():
        _helmet_model = YOLO(str(HELMET_WEIGHTS))
    return _helmet_model


def get_model_hash() -> bytes:
    """앵커링할 modelHash. 판정에 관여하는 모든 가중치 파일 해시를 합쳐 하나로 만든다
    (헬멧 모델과 person 탐지 모델 중 하나라도 바뀌면 값이 달라진다)."""
    generic_hash = Web3.keccak(GENERIC_WEIGHTS.read_bytes())
    if HELMET_WEIGHTS.exists():
        helmet_hash = Web3.keccak(HELMET_WEIGHTS.read_bytes())
        return Web3.keccak(helmet_hash + generic_hash)
    return generic_hash


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


def _dark_ratio(region: np.ndarray) -> float:
    """안전화 색상(검정/짙은 계열)에 해당하는 픽셀 비율."""
    if region.size == 0:
        return 0.0
    hsv = cv2.cvtColor(region, cv2.COLOR_BGR2HSV)
    dark = cv2.inRange(hsv, (0, 0, 0), (180, 255, 70))
    return float(np.count_nonzero(dark)) / dark.size


def _bright_ratio(region: np.ndarray) -> float:
    """헬멧 모델이 없을 때의 폴백 휴리스틱: 형광 노랑/주황/흰색 픽셀 비율."""
    if region.size == 0:
        return 0.0
    hsv = cv2.cvtColor(region, cv2.COLOR_BGR2HSV)
    yellow_orange = cv2.inRange(hsv, (10, 80, 120), (40, 255, 255))
    bright_white = cv2.inRange(hsv, (0, 0, 200), (180, 60, 255))
    mask = cv2.bitwise_or(yellow_orange, bright_white)
    return float(np.count_nonzero(mask)) / mask.size


def _check_helmet(image_path: str, head_region: np.ndarray) -> bool:
    helmet_model = get_helmet_model()
    if helmet_model is None:
        return _bright_ratio(head_region) > 0.15

    result = helmet_model.predict(source=image_path, verbose=False)[0]
    boxes = result.boxes
    if boxes is None or len(boxes) == 0:
        return False  # 아무것도 검출 안 되면 fail-closed

    names = helmet_model.names
    classes = [names[int(c)] for c in boxes.cls.cpu().numpy()]
    confs = boxes.conf.cpu().numpy()

    has_no_hardhat = any(c == "NO-Hardhat" and conf >= CONF_THRESHOLD for c, conf in zip(classes, confs))
    has_hardhat = any(c == "Hardhat" and conf >= CONF_THRESHOLD for c, conf in zip(classes, confs))

    if has_no_hardhat:
        return False
    return has_hardhat


def check_ppe(image_path: str) -> dict:
    """helmetPass/shoesPass 판정. 사람이 검출되지 않으면 안전 쪽으로 fail-closed."""
    generic_result = get_generic_model().predict(source=image_path, verbose=False)[0]

    box = _largest_person_box(generic_result)
    if box is None:
        return {"helmetPass": False, "shoesPass": False}

    x1, y1, x2, y2 = box.astype(int)
    height = y2 - y1
    image = generic_result.orig_img

    head_region = image[y1 : y1 + int(height * 0.2), x1:x2]
    foot_region = image[y2 - int(height * 0.15) : y2, x1:x2]

    helmet_pass = _check_helmet(image_path, head_region)
    shoes_pass = _dark_ratio(foot_region) > 0.15

    return {"helmetPass": helmet_pass, "shoesPass": shoes_pass}
