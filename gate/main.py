"""게이트 기기 서비스 (Gate Device).

현장 출입 게이트(키오스크 태블릿 + 카메라)에서 돌아가는 쪽을 시공사 백엔드와 분리한 서비스다.
게이트 기기 키는 이 서비스만 갖고 있고, 시공사 백엔드에는 없다.

한 번의 검사 흐름:
  1. 시공사 백엔드에 QR 확인 요청 (QR이 이 근로자·현장 것인지, 만료됐는지, 동의했는지)
  2. YOLO로 안전모·안전화 판정, 사진 SHA-256
  3. 기기 키로 EIP-712 서명 (QR 발급·만료 시각 + 기기 일련번호 포함)
  4. 체인 제출 "전에" 서명 사본을 감리 감사 저장소로 직접 전송
  5. 시공사 릴레이에 제출을 맡김 (가스는 시공사가 냄)

그래서 시공사는 릴레이를 멈추거나 특정 기록을 뺄 수는 있어도(감사 저장소에 원본이 남음),
기기 서명을 위조하거나 일련번호를 새로 매겨 누락을 감출 수는 없다.
실서비스에서는 이 키를 게이트 하드웨어의 보안 칩에 두고, 감사 저장소로 가는 네트워크도 따로 둔다.
"""

import hashlib
import json
import os
import sqlite3
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from contextlib import contextmanager
from pathlib import Path

from eth_account import Account
from eth_account.messages import encode_typed_data
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from web3 import Web3

import vision

BASE = Path(__file__).parent


def _load_env_file() -> None:
    env = BASE / ".env"
    if not env.exists():
        return
    for line in env.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


_load_env_file()

RPC_URL = os.environ.get("RPC_URL", "http://127.0.0.1:8545")
CONTRACT_ADDRESS = Web3.to_checksum_address(os.environ["CONTRACT_ADDRESS"])
BACKEND_URL = os.environ.get("BACKEND_URL", "http://127.0.0.1:8000")  # 시공사 백엔드 (QR 확인·릴레이)
AUDIT_URL = os.environ.get("AUDIT_URL", "http://127.0.0.1:8100")  # 감리 감사 저장소
DEMO_CONTROLS = os.environ.get("DEMO_CONTROLS", "0") == "1"
DB_PATH = BASE / "gate.db"

_device = Account.from_key(os.environ["DEVICE_PRIVATE_KEY"])
DEVICE_ADDRESS = _device.address
_chain_id = Web3(Web3.HTTPProvider(RPC_URL)).eth.chain_id

CHECKIN_TYPES = {
    "CheckIn": [
        {"name": "caseId", "type": "bytes32"},
        {"name": "workerId", "type": "bytes32"},
        {"name": "siteId", "type": "bytes32"},
        {"name": "helmetPass", "type": "bool"},
        {"name": "shoesPass", "type": "bool"},
        {"name": "alcoholPass", "type": "bool"},
        {"name": "modelHash", "type": "bytes32"},
        {"name": "evidenceHash", "type": "bytes32"},
        {"name": "nonce", "type": "bytes32"},
        {"name": "qrIssuedAt", "type": "uint64"},
        {"name": "qrExpiresAt", "type": "uint64"},
        {"name": "deviceSeq", "type": "uint64"},
        {"name": "timestamp", "type": "uint64"},
    ]
}

app = FastAPI(title="SafetyChain Gate Device")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# ----------------------------------------------------------------------
# 기기 로컬 상태: 일련번호 카운터 (서명에 쓴 번호는 제출 성공 여부와 무관하게 소진)
# ----------------------------------------------------------------------


@contextmanager
def _conn():
    conn = sqlite3.connect(DB_PATH)
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


@app.on_event("startup")
def _startup() -> None:
    with _conn() as c:
        c.execute("CREATE TABLE IF NOT EXISTS device_state (device TEXT PRIMARY KEY, last_seq INTEGER NOT NULL)")


def _next_seq() -> int:
    with _conn() as c:
        c.execute(
            "INSERT INTO device_state (device, last_seq) VALUES (?, 1) "
            "ON CONFLICT(device) DO UPDATE SET last_seq = last_seq + 1",
            (DEVICE_ADDRESS.lower(),),
        )
        return c.execute("SELECT last_seq FROM device_state WHERE device = ?", (DEVICE_ADDRESS.lower(),)).fetchone()[0]


# ----------------------------------------------------------------------
# HTTP 헬퍼 (새 라이브러리 없이 표준 라이브러리만 사용)
# ----------------------------------------------------------------------


class GateError(Exception):
    pass


def _post_json(url: str, body: dict, timeout: float = 60) -> dict:
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST"
    )
    return _send(req, timeout)


def _post_multipart(url: str, fields: dict, file_field: str, file_bytes: bytes, timeout: float = 120) -> dict:
    boundary = uuid.uuid4().hex
    parts = [
        f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
        for k, v in fields.items()
    ]
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field}"; filename="capture.jpg"\r\n'
        f"Content-Type: image/jpeg\r\n\r\n".encode() + file_bytes + b"\r\n"
    )
    data = b"".join(parts) + f"--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": f"multipart/form-data; boundary={boundary}"}, method="POST"
    )
    return _send(req, timeout)


def _send(req: urllib.request.Request, timeout: float) -> dict:
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read())
    except urllib.error.HTTPError as e:
        try:
            detail = json.loads(e.read()).get("detail", str(e))
        except ValueError:
            detail = str(e)
        raise GateError(str(detail)) from e
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise GateError(f"cannot reach {req.full_url}: {e}") from e


def _hex(b: bytes) -> str:
    return "0x" + bytes(b).hex()


def _sign(checkin: dict) -> bytes:
    domain = {"name": "SafetyChain", "version": "1", "chainId": _chain_id, "verifyingContract": CONTRACT_ADDRESS}
    typed = encode_typed_data(domain_data=domain, message_types=CHECKIN_TYPES, message_data=checkin)
    return _device.sign_message(typed).signature


def _send_to_audit(checkin_json: dict, signature: bytes) -> bool:
    try:
        _post_json(f"{AUDIT_URL}/records", {"checkin": checkin_json, "signature": _hex(signature)}, timeout=5)
        return True
    except GateError:
        return False  # 실제 기기라면 로컬에 쌓아뒀다가 재전송한다


# ----------------------------------------------------------------------
# 검사 흐름
# ----------------------------------------------------------------------


def _steps(image_bytes, nonce, alcohol_pass, worker_id, site_id, work_date, signed_minutes_ago):
    yield {"stage": "inspecting"}
    # 1) 시공사 백엔드에 QR 확인 (시연용 '오프라인 재전송'이면 QR도 그만큼 이전에 쓴 것으로 맞춘다)
    prep = _post_json(
        f"{BACKEND_URL}/gate/prepare",
        {"nonce": nonce, "workerId": worker_id, "siteId": site_id, "workDate": work_date,
         "signedMinutesAgo": signed_minutes_ago},
    )
    # 2) 판정
    with tempfile.NamedTemporaryFile(suffix=".jpg") as tmp:
        tmp.write(image_bytes)
        tmp.flush()
        ppe = vision.check_ppe(tmp.name)
    evidence = hashlib.sha256(image_bytes).digest()

    yield {"stage": "signing"}
    seq = _next_seq()
    signed_at = int(time.time()) - signed_minutes_ago * 60
    checkin = {
        "caseId": bytes.fromhex(prep["caseId"][2:]),
        "workerId": bytes.fromhex(prep["workerId"][2:]),
        "siteId": bytes.fromhex(prep["siteId"][2:]),
        "helmetPass": ppe["helmetPass"],
        "shoesPass": ppe["shoesPass"],
        "alcoholPass": alcohol_pass,
        "modelHash": vision.get_model_hash(),
        "evidenceHash": evidence,
        "nonce": bytes.fromhex(nonce[2:]),
        "qrIssuedAt": prep["qrIssuedAt"],
        "qrExpiresAt": prep["qrExpiresAt"],
        "deviceSeq": seq,
        "timestamp": signed_at,
    }
    signature = _sign(checkin)
    checkin_json = {k: (_hex(v) if isinstance(v, bytes) else v) for k, v in checkin.items()}

    # 3) 감리 감사 저장소로 먼저 (시공사 릴레이와 독립된 경로)
    yield {"stage": "auditing"}
    audit_delivered = _send_to_audit(checkin_json, signature)

    # 4) 시공사 릴레이에 체인 제출을 맡긴다. 릴레이가 멈춰도 감사 저장소에는 원본이 남아 있다
    yield {"stage": "anchoring"}
    relayed = _post_multipart(
        f"{BACKEND_URL}/gate/relay",
        {"checkin": json.dumps(checkin_json), "signature": _hex(signature)},
        "image",
        image_bytes,
    )
    result = {**relayed, "deviceSeq": seq, "auditDelivered": audit_delivered}
    yield {"stage": "confirmed" if relayed.get("anchored") else "not_anchored", "result": result}


def _validate(nonce: str, signed_minutes_ago: int) -> None:
    if not (nonce.startswith("0x") and len(nonce) == 66):
        raise HTTPException(400, "invalid nonce")
    if signed_minutes_ago and not DEMO_CONTROLS:
        raise HTTPException(403, "demo controls are disabled (set DEMO_CONTROLS=1)")
    if not 0 <= signed_minutes_ago <= 48 * 60:
        raise HTTPException(400, "signedMinutesAgo must be between 0 and 2880")


@app.post("/check")
def check(
    image: UploadFile = File(...),
    nonce: str = Form(...),
    alcoholPass: bool = Form(...),
    workerId: str = Form(...),
    siteId: str = Form(...),
    workDate: str = Form(...),
    signedMinutesAgo: int = Form(0),
):
    _validate(nonce, signedMinutesAgo)
    try:
        for step in _steps(image.file.read(), nonce, alcoholPass, workerId, siteId, workDate, signedMinutesAgo):
            if "result" in step:
                return step["result"]
    except GateError as e:
        raise HTTPException(400, str(e))


@app.post("/check/stream")
def check_stream(
    image: UploadFile = File(...),
    nonce: str = Form(...),
    alcoholPass: bool = Form(...),
    workerId: str = Form(...),
    siteId: str = Form(...),
    workDate: str = Form(...),
    signedMinutesAgo: int = Form(0),
):
    """단계마다 한 줄씩(NDJSON) 보내 키오스크가 진행 상황을 보여준다.
    판정 결과는 체인 확정(또는 미확정) 뒤에만 나간다 (Gatekeeper)."""
    _validate(nonce, signedMinutesAgo)
    image_bytes = image.file.read()

    def lines():
        try:
            for step in _steps(image_bytes, nonce, alcoholPass, workerId, siteId, workDate, signedMinutesAgo):
                yield json.dumps(step, ensure_ascii=False) + "\n"
        except GateError as e:
            yield json.dumps({"stage": "error", "detail": str(e)}, ensure_ascii=False) + "\n"
        except Exception as e:  # noqa: BLE001 - 키오스크에 실패를 알려야 함
            yield json.dumps({"stage": "error", "detail": f"gate error: {e}"}, ensure_ascii=False) + "\n"

    return StreamingResponse(lines(), media_type="application/x-ndjson")


@app.get("/model")
def model():
    """지금 게이트가 쓰는 AI 모델 해시. 검증뷰가 판정 당시 modelHash와 비교한다."""
    return {"modelHash": _hex(vision.get_model_hash())}


@app.get("/health")
def health():
    return {"ok": True, "device": DEVICE_ADDRESS, "chainId": _chain_id, "contract": CONTRACT_ADDRESS}
