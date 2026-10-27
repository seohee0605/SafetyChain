import json
import secrets
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import urllib.error
import urllib.request

from Crypto.Cipher import AES
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel
from web3.exceptions import ContractCustomError, ContractLogicError

import chain
import config
import db

app = FastAPI(title="SafetyChain Backend")

# 로컬 데모용. 로그인/쿠키를 안 쓰니까 넓게 열어둠
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = Path(__file__).parent / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

# 사유 코드표. 온체인에는 코드 숫자만 올라가고, 사람이 읽는 문구는 여기(오프체인)에만 있다.
OVERRIDE_REASONS = {
    1: "AI 오탐 (육안 확인 결과 착용)",
    2: "카메라·조명 문제로 판정 불가",
    3: "보호구 재착용 후 재확인",
}
REJECT_REASONS = {
    1: "기록 누락",
    2: "위험요인 미조치",
    3: "증빙(사진·원문) 불일치",
    4: "재검사 요구",
    5: "수동 처리(override) 사유 부적절",
}
EMERGENCY_REASONS = {
    1: "게이트 장비 장애",
    2: "응급·구조 대응",
    3: "정전·통신 장애",
}
REVOKE_REASONS = {
    1: "키 유출 의심",
    2: "기기 고장·교체",
    3: "현장 철수",
}
# 시공사 릴레이 모드 (시연용): 정상 / 전부 중단 / 불합격만 빼고 제출
RELAY_MODES = ("normal", "paused", "drop_failed")

ONCHAIN_ERRORS = (ContractLogicError, ContractCustomError, chain.OnchainRejected)


@app.on_event("startup")
def _startup() -> None:
    db.init_db()


def _default_work_date() -> str:
    return date.today().isoformat()


def _parse_nonce(nonce: str) -> bytes:
    try:
        b = chain.from_hex0x(nonce)
    except ValueError:
        b = b""
    if len(b) != 32:
        raise HTTPException(400, "invalid nonce")
    return b


@app.get("/reasons")
def reasons():
    return {
        "override": [{"code": k, "label": v} for k, v in OVERRIDE_REASONS.items()],
        "reject": [{"code": k, "label": v} for k, v in REJECT_REASONS.items()],
        "revoke": [{"code": k, "label": v} for k, v in REVOKE_REASONS.items()],
        "emergency": [{"code": k, "label": v} for k, v in EMERGENCY_REASONS.items()],
    }


def _require_demo_controls() -> None:
    if not config.DEMO_CONTROLS:
        raise HTTPException(403, "demo controls are disabled (set DEMO_CONTROLS=1)")


# ======================================================================
# 출입 검사
# ======================================================================


class QrIssueRequest(BaseModel):
    workerId: str
    siteId: str


@app.post("/qr/issue")
def issue_qr(req: QrIssueRequest):
    # 민감정보 동의 없이는 자동 게이트를 쓸 수 없다 (관리자 대면 확인으로 처리)
    if db.get_consent(req.workerId, req.siteId) is None:
        raise HTTPException(403, "consent required")
    return db.issue_nonce(req.workerId, req.siteId)


# ======================================================================
# 근로자 앱: 민감정보 동의, 내 출입 기록
# ======================================================================

CONSENT_VERSION = "2026-10"


class ConsentRequest(BaseModel):
    workerId: str
    siteId: str
    personal: bool  # 일반 개인정보 (사번)
    sensitive: bool  # 민감정보 (검사 사진, 음주 측정 통과 여부) - 별도 동의


@app.post("/consent")
def give_consent(req: ConsentRequest):
    if not (req.personal and req.sensitive):
        raise HTTPException(400, "both consents are required to use the automated gate")
    agreed_at = db.save_consent(req.workerId, req.siteId, CONSENT_VERSION)
    return {"agreed": True, "version": CONSENT_VERSION, "agreedAt": agreed_at}


@app.get("/consent/{site}/{worker}")
def get_consent(site: str, worker: str):
    row = db.get_consent(worker, site)
    if row is None:
        return {"agreed": False, "version": CONSENT_VERSION, "agreedAt": None}
    return {"agreed": True, "version": row["version"], "agreedAt": row["agreed_at"]}


@app.post("/consent/withdraw")
def withdraw_consent(req: QrIssueRequest):
    db.delete_consent(req.workerId, req.siteId)
    return {"agreed": False}


@app.get("/worker/{site}/{worker}/records")
def worker_records(site: str, worker: str):
    out = []
    for c in db.list_checkins_by_worker(worker, site):
        overridden = db.get_override_for_checkin(c["nonce"]) is not None
        passed = bool(c["helmet_pass"] and c["shoes_pass"] and c["alcohol_pass"])
        out.append({
            "nonce": c["nonce"],
            "at": c["timestamp"],
            "result": _worker_result(c["entry_status"], overridden, passed),
            "helmetPass": bool(c["helmet_pass"]),
            "shoesPass": bool(c["shoes_pass"]),
            "alcoholPass": bool(c["alcohol_pass"]),
            "txHash": c["tx_hash"],
        })
    return out


def _worker_result(entry_status: str | None, overridden: bool, passed: bool) -> str:
    if entry_status == "Granted":
        return "pass"
    if entry_status == "HeldNoAssessment":
        return "held"
    if entry_status == "HeldHazardsOpen":
        return "hazards"
    if entry_status == "LateAuditOnly":
        return "late"
    if entry_status == "SuspectTimestamp":
        return "suspect"
    if entry_status is None and passed:
        return "pass"  # 출입 상태를 저장하기 전(이전 버전)에 남은 기록은 검사 결과로 판정
    return "override" if overridden else "fail"


def _check_gate_request(nonce: str, workerId: str, siteId: str):
    nonce_row = db.get_nonce(nonce)
    if nonce_row is None:
        raise HTTPException(404, "nonce not found")
    if nonce_row["consumed"]:
        raise HTTPException(400, "nonce already used")
    # 다른 사람 QR로 체크인 못하게
    if nonce_row["worker_id"] != workerId or nonce_row["site_id"] != siteId:
        raise HTTPException(400, "QR was issued for a different worker/site")
    return nonce_row


class GatePrepareRequest(BaseModel):
    nonce: str
    workerId: str
    siteId: str
    workDate: str | None = None
    signedMinutesAgo: int = 0  # 시연: 오프라인 상태에서 N분 전에 검사한 기록


@app.post("/gate/prepare")
def gate_prepare(req: GatePrepareRequest):
    """게이트 서비스가 서명하기 전에 묻는다: 이 QR이 이 근로자·현장 것이고 아직 유효한가.
    서명에 들어갈 가명(workerId)·caseId·QR 발급/만료 시각을 돌려준다 (가명 HMAC 키는 시공사만 갖는다)."""
    _parse_nonce(req.nonce)
    row = _check_gate_request(req.nonce, req.workerId, req.siteId)
    issued, expires = row["issued_at"], row["expires_at"]
    if req.signedMinutesAgo:
        _require_demo_controls()
        # 시연: 그때 발급된 QR로 그때 검사한 것처럼 QR 유효기간도 같이 옮긴다
        shift = req.signedMinutesAgo * 60
        issued, expires = issued - shift, expires - shift
    elif expires < int(time.time()):
        raise HTTPException(400, "nonce expired")
    work_date = req.workDate or _default_work_date()
    return {
        "caseId": chain.to_hex0x(chain.case_id_hash(req.siteId, work_date)),
        "workerId": chain.to_hex0x(chain.worker_id_hash(req.workerId, req.siteId, work_date)),
        "siteId": chain.to_hex0x(chain.site_id_hash(req.siteId)),
        "qrIssuedAt": issued,
        "qrExpiresAt": expires,
    }


def _encrypt_photo(image_bytes: bytes) -> bytes:
    cipher = AES.new(config.PHOTO_KEY, AES.MODE_GCM)
    ciphertext, tag = cipher.encrypt_and_digest(image_bytes)
    return cipher.nonce + tag + ciphertext


def _decrypt_photo(blob: bytes) -> bytes:
    cipher = AES.new(config.PHOTO_KEY, AES.MODE_GCM, nonce=blob[:16])
    return cipher.decrypt_and_verify(blob[32:], blob[16:32])


def _read_photo(path: str | None) -> bytes | None:
    if not path or not Path(path).exists():
        return None
    blob = Path(path).read_bytes()
    if path.endswith(".enc"):
        try:
            return _decrypt_photo(blob)
        except ValueError:
            return None  # 키가 다르거나 파일이 바뀜
    return blob  # 암호화 도입 전 사진


@app.post("/gate/relay")
def gate_relay(checkin: str = Form(...), signature: str = Form(...), image: UploadFile = File(...)):
    """시공사 릴레이: 게이트 서비스가 서명한 기록을 체인에 제출하고(가스는 시공사), 원본을 보관한다.
    시공사는 서명을 만들 수 없고 내용을 바꾸면 서명이 깨진다. 할 수 있는 건 '안 내는 것'뿐인데,
    그건 게이트가 먼저 보낸 감사 저장소 원본과 체인을 대조하면 드러난다."""
    try:
        c = json.loads(checkin)
        fields = [f["name"] for f in chain.CHECKIN_TYPES["CheckIn"]]
        msg = {
            k: (chain.from_hex0x(c[k]) if t["type"] == "bytes32" else (bool(c[k]) if t["type"] == "bool" else int(c[k])))
            for k, t in zip(fields, chain.CHECKIN_TYPES["CheckIn"])
        }
        sig = chain.from_hex0x(signature)
    except (ValueError, KeyError, TypeError) as e:
        raise HTTPException(400, f"invalid checkin payload: {e}")
    nonce = chain.to_hex0x(msg["nonce"])
    row = db.get_nonce(nonce)
    if row is None:
        raise HTTPException(404, "nonce not found")
    if row["consumed"]:
        raise HTTPException(400, "nonce already used")
    image_bytes = image.file.read()
    if chain.evidence_hash(image_bytes) != msg["evidenceHash"]:
        raise HTTPException(400, "image does not match signed evidenceHash")

    site_id = row["site_id"]
    all_passed = msg["helmetPass"] and msg["shoesPass"] and msg["alcoholPass"]
    base = {"nonce": nonce, "helmetPass": msg["helmetPass"], "shoesPass": msg["shoesPass"],
            "alcoholPass": msg["alcoholPass"], "verdict": all_passed}

    # 시연: 시공사가 릴레이를 멈추거나 불합격 기록만 빼는 상황. 시공사 DB에도 안 남기고 체인에도 안 낸다
    relay_mode = db.get_setting("relay_mode", "normal") if config.DEMO_CONTROLS else "normal"
    if relay_mode == "paused" or (relay_mode == "drop_failed" and not all_passed):
        db.consume_nonce(nonce)
        return {**base, "anchored": False, "txHash": None, "entryStatus": None, "entryAllowed": False,
                "overridable": False}

    try:
        tx_hash = chain.submit_checkin(msg, sig)
    except ONCHAIN_ERRORS as e:
        db.record_rejection("checkin", nonce, site_id, chain.describe_error(e))
        raise HTTPException(400, f"on-chain submission rejected: {chain.describe_error(e)}")

    onchain = chain.get_onchain_checkin(msg["nonce"])
    entry_status = onchain["status"] if onchain else None
    db.consume_nonce(nonce)
    # 사진에는 얼굴이 찍히므로 암호화해서 보관한다 (해시는 원본 기준이라 검증은 복호화 후 비교)
    image_path = UPLOAD_DIR / f"{msg['nonce'].hex()}.jpg.enc"
    image_path.write_bytes(_encrypt_photo(image_bytes))
    db.record_checkin(
        nonce=nonce,
        case_id=chain.to_hex0x(msg["caseId"]),
        site_id=site_id,
        worker_id_hash=chain.to_hex0x(msg["workerId"]),
        tx_hash=tx_hash,
        helmet_pass=msg["helmetPass"],
        shoes_pass=msg["shoesPass"],
        alcohol_pass=msg["alcoholPass"],
        model_hash=chain.to_hex0x(msg["modelHash"]),
        device_address=onchain["device"] if onchain else "",
        signature=signature,
        timestamp=msg["timestamp"],
        evidence_hash=chain.to_hex0x(msg["evidenceHash"]),
        image_path=str(image_path),
        entry_status=entry_status,
        device_seq=msg["deviceSeq"],
    )
    return {
        **base,
        "anchored": True,
        "txHash": tx_hash,
        "entryStatus": entry_status,
        "entryAllowed": entry_status == "Granted",
        # 수동 처리는 '보호구 불합격(Denied)'에만. 음주 불합격·보류·지연·의심은 불가
        "overridable": entry_status == "Denied" and msg["alcoholPass"],
    }


@app.get("/gate/records/{site}")
def gate_records(site: str):
    """시공사 DB에 남은 게이트 기록 목록 (nonce·기기 일련번호만). 감사 저장소가 3자 대조에 쓴다."""
    return [{"nonce": c["nonce"], "deviceSeq": c["device_seq"]} for c in db.list_checkins_by_site(site)]


class OverrideRequest(BaseModel):
    nonce: str  # 수동 처리할 검사 기록의 nonce
    reasonCode: int
    supervisorName: str


@app.post("/gate/override")
def gate_override(req: OverrideRequest):
    """AI 보호구 불합격을 감독자가 사유 코드와 함께 수동 처리한다 (Manual Override)."""
    if req.reasonCode not in OVERRIDE_REASONS:
        raise HTTPException(400, "unknown reasonCode")
    if req.supervisorName not in chain.ADMIN_NAMES:
        raise HTTPException(400, "unknown supervisorName")
    checkin_nonce = _parse_nonce(req.nonce)
    if db.get_checkin(req.nonce) is None:
        raise HTTPException(404, "no check-in recorded for this nonce")

    override_nonce = secrets.token_bytes(32)
    signed = chain.build_and_sign_override(
        checkin_nonce, req.reasonCode, override_nonce, req.supervisorName
    )
    try:
        tx_hash = chain.submit_override(signed["override"], signed["signature"])
    except ONCHAIN_ERRORS as e:
        db.record_rejection("override", req.nonce, db.get_checkin(req.nonce)["site_id"], chain.describe_error(e))
        raise HTTPException(400, f"on-chain submission rejected: {chain.describe_error(e)}")

    db.record_override(
        nonce=chain.to_hex0x(override_nonce),
        checkin_nonce=req.nonce,
        reason_code=req.reasonCode,
        supervisor_address=signed["signerAddress"],
        signature=chain.to_hex0x(signed["signature"]),
        tx_hash=tx_hash,
        timestamp=signed["override"]["timestamp"],
    )
    return {
        "txHash": tx_hash,
        "reason": OVERRIDE_REASONS[req.reasonCode],
        "entryAllowed": chain.is_entry_allowed(checkin_nonce),
    }


KST = ZoneInfo("Asia/Seoul")


def _gate_model_hash() -> bytes | None:
    try:
        with urllib.request.urlopen(f"{config.GATE_URL}/model", timeout=5) as res:
            return chain.from_hex0x(json.loads(res.read())["modelHash"])
    except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError):
        return None


def _kst_day(ts: int) -> str:
    return datetime.fromtimestamp(ts, KST).date().isoformat()


@app.get("/dashboard/{site}")
def dashboard(site: str):
    stats = chain.get_site_stats(site)  # 검사·불합격·override 수는 온체인 값
    checked = stats["checkIns"]
    unchecked = db.count_unchecked(site)  # 만료된 QR 수는 오프체인에만 있음
    failed = stats["failed"]
    total = checked + unchecked

    # 최근 7일 추이: 검사·불합격·override는 온체인 기록(블록 시각) 기준
    today = datetime.now(KST).date()
    days = [(today - timedelta(days=i)).isoformat() for i in range(6, -1, -1)]
    daily = {
        d: {"date": d, "checked": 0, "unchecked": 0, "failed": 0, "overrides": 0, "held": 0, "late": 0}
        for d in days
    }
    onchain = chain.list_site_checkins(site)
    for c in onchain:
        d = daily.get(_kst_day(c["anchoredAt"]))
        if d is None:
            continue
        data = c["data"]
        d["checked"] += 1
        if not (data["helmetPass"] and data["shoesPass"] and data["alcoholPass"]):
            d["failed"] += 1
        if c["overridden"]:
            d["overrides"] += 1
        if c["status"] in ("HeldNoAssessment", "HeldHazardsOpen"):
            d["held"] += 1
        elif c["status"] in ("LateAuditOnly", "SuspectTimestamp"):
            d["late"] += 1
    week_start = int(datetime.combine(today - timedelta(days=6), datetime.min.time(), KST).timestamp())
    for ts in db.unchecked_expiry_times(site, week_start):
        d = daily.get(_kst_day(ts))
        if d is not None:
            d["unchecked"] += 1
    for d in daily.values():
        n = d["checked"] + d["unchecked"]
        d["rate"] = d["checked"] / n if n else None

    # 무사고 일수: 마지막 사고 보고일 기준, 사고 보고가 없으면 첫 온체인 기록일 기준
    last_incident = db.last_incident_date(site)
    if last_incident:
        no_incident_days, since = (today - date.fromisoformat(last_incident)).days, "incident"
    elif onchain:
        first = date.fromisoformat(_kst_day(min(c["anchoredAt"] for c in onchain)))
        no_incident_days, since = (today - first).days, "firstRecord"
    else:
        no_incident_days, since = None, None

    return {
        "checkedCount": checked,
        "uncheckedCount": unchecked,
        "rate": checked / total if total else 1.0,
        "failedCount": failed,
        "overrideCount": stats["overrides"],
        "overrideRate": (stats["overrides"] / failed) if failed else 0.0,
        # 검사 건수에 포함되지만 출입 근거가 아닌 기록 (온체인 집계)
        "heldCount": stats["held"],
        "lateCount": stats["late"],
        "suspectCount": stats["suspect"],
        "emergencyCount": stats["emergencies"],
        "noIncidentDays": no_incident_days,
        "noIncidentSince": since,
        "lastIncidentDate": last_incident,
        "daily": list(daily.values()),
    }


class IncidentRequest(BaseModel):
    siteId: str
    date: str | None = None  # YYYY-MM-DD, 없으면 오늘


@app.post("/site/incident")
def report_incident(req: IncidentRequest):
    d = req.date or datetime.now(KST).date().isoformat()
    try:
        date.fromisoformat(d)
    except ValueError:
        raise HTTPException(400, "date must be YYYY-MM-DD")
    db.add_incident(req.siteId, d)
    return {"lastIncidentDate": db.last_incident_date(req.siteId)}


@app.get("/verify/{nonce}")
def verify(nonce: str):
    """검사 기록 검증. 신뢰 기준은 온체인 값이고, DB와 사진 원본을 그것과 대조한다."""
    nonce_bytes = _parse_nonce(nonce)
    record = db.get_checkin(nonce)
    if record is None:
        raise HTTPException(404, "no check-in recorded for this nonce")

    onchain = chain.get_onchain_checkin(nonce_bytes)
    if onchain is None:
        return {"onchain": False, "sigValid": False, "modelHashMatch": False, "evidenceIntact": False,
                "recordMatchesChain": False}
    data = onchain["data"]

    # 1) DB에 남은 서명이 "온체인에 저장된 값"에 대해 그 기기 것으로 복구되는가
    recovered = chain.recover(chain.CHECKIN_TYPES, data, chain.from_hex0x(record["signature"]))
    sig_valid = recovered.lower() == onchain["device"].lower()

    # 2) DB 원본이 온체인 기록과 같은가
    record_matches = (
        record["case_id"] == chain.to_hex0x(data["caseId"])
        and chain.site_id_hash(record["site_id"]) == data["siteId"]
        and bool(record["helmet_pass"]) == data["helmetPass"]
        and bool(record["shoes_pass"]) == data["shoesPass"]
        and bool(record["alcohol_pass"]) == data["alcoholPass"]
        and record["worker_id_hash"] == chain.to_hex0x(data["workerId"])
        and record["model_hash"] == chain.to_hex0x(data["modelHash"])
        and record["evidence_hash"] == chain.to_hex0x(data["evidenceHash"])
        and record["timestamp"] == data["timestamp"]
        and (record["device_seq"] is None or record["device_seq"] == data["deviceSeq"])
    )

    # 3) 사진 원본이 바뀌지 않았는가
    photo = _read_photo(record["image_path"])
    evidence_intact = photo is not None and chain.evidence_hash(photo) == data["evidenceHash"]

    # 4) 지금 게이트의 AI 모델이 판정 당시 모델과 같은가 (게이트 서비스에 묻는다)
    model_hash_match = _gate_model_hash() == data["modelHash"]

    return {
        "onchain": True,
        "sigValid": sig_valid,
        "recordMatchesChain": record_matches,
        "evidenceIntact": evidence_intact,
        "modelHashMatch": model_hash_match,
        "anchoredAt": onchain["anchoredAt"],
        "device": onchain["device"],
        "entryStatus": onchain["status"],
        "entryAllowed": chain.is_entry_allowed(nonce_bytes),
        "deviceSeq": data["deviceSeq"],
        "overridden": onchain["overridden"],
        "overrideReason": OVERRIDE_REASONS.get(onchain["overrideReason"]),
        "overriddenBy": chain.name_for_address(onchain["overriddenBy"]) if onchain["overridden"] else None,
    }


# ======================================================================
# 위험성평가
# ======================================================================


class Hazard(BaseModel):
    hazard: str
    riskBasis: str
    controlMeasure: str
    completed: bool


class SiteRecordRequest(BaseModel):
    siteId: str
    processSummary: str
    hazards: list[Hazard]
    hazardsControlled: bool
    adminName: str
    changeReason: str | None = None
    workDate: str | None = None


@app.get("/admins")
def list_admins():
    """등록된 시공사 감독자(안전관리자) 이름 목록. 로그인 없이 드롭다운에서 선택하는 용도."""
    return [{"name": name, "address": chain.ADMIN_ADDRESSES[name]} for name in chain.ADMIN_NAMES]


@app.get("/reviewers")
def list_reviewers():
    """감리·발주처 이름과 주소. 지갑 모드에서는 백엔드가 이들의 키를 갖고 있지 않다."""
    out = []
    for role in ("inspector", "owner"):
        info = chain.reviewer_info(role)
        if info:
            out.append({"role": role, "name": info[0], "address": info[1]})
    return out


@app.get("/signing-mode")
def signing_mode():
    """wallet: 감리·발주처가 자기 지갑으로 서명 / server: 데모 백업용으로 백엔드가 대신 서명."""
    return {"mode": "wallet" if chain.WALLET_SIGNING else "server", "reviewers": list_reviewers()}


def _require_server_signing() -> None:
    if chain.WALLET_SIGNING:
        raise HTTPException(409, "reviewer must sign with their own wallet (use the /prepare + /submit endpoints)")


def _check_wallet_signer(types: dict, message: dict, signature: bytes, roles: tuple[str, ...]) -> str:
    """지갑 서명이 정말 감리·발주처 주소에서 나왔는지 먼저 확인한다 (최종 판단은 컨트랙트가 역할로 한다)."""
    try:
        signer = chain.recover(types, message, signature)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"invalid signature: {e}")
    allowed = {chain.reviewer_info(r)[1].lower(): r for r in roles if chain.reviewer_info(r)}
    if signer.lower() not in allowed:
        raise HTTPException(403, f"connected wallet {signer} is not the expected reviewer")
    return signer


def _site_record_content(process_summary: str, hazards: list[dict], change_reason: str | None) -> str:
    """온체인에 앵커링할 recordHash를 만드는 원문. 제출 시와 검증 시 반드시 같은 방식으로 직렬화해야 한다."""
    content = {"processSummary": process_summary, "hazards": hazards, "changeReason": change_reason}
    return json.dumps(content, ensure_ascii=False, sort_keys=True)


@app.post("/site/record")
def submit_site_record(req: SiteRecordRequest):
    if req.adminName not in chain.ADMIN_NAMES:
        raise HTTPException(400, "unknown adminName")

    work_date = req.workDate or _default_work_date()
    hazards_dicts = [h.model_dump() for h in req.hazards]
    content_json = _site_record_content(req.processSummary, hazards_dicts, req.changeReason)
    record_hash_bytes = chain.hash_text(content_json)
    case_id_bytes = chain.case_id_hash(req.siteId, work_date)
    nonce_bytes = secrets.token_bytes(32)

    signed = chain.build_and_sign_site_record(
        case_id=case_id_bytes,
        site_id=chain.site_id_hash(req.siteId),
        record_hash=record_hash_bytes,
        hazards_controlled=req.hazardsControlled,
        nonce=nonce_bytes,
        admin_name=req.adminName,
    )
    try:
        tx_hash = chain.submit_site_record(signed["record"], signed["signature"])
    except ONCHAIN_ERRORS as e:
        db.record_rejection("site_record", chain.to_hex0x(nonce_bytes), req.siteId, chain.describe_error(e))
        raise HTTPException(400, f"on-chain submission rejected: {chain.describe_error(e)}")

    nonce_hex = chain.to_hex0x(nonce_bytes)
    db.record_site_record(
        nonce=nonce_hex,
        case_id=chain.to_hex0x(case_id_bytes),
        site_id=req.siteId,
        tx_hash=tx_hash,
        process_summary=req.processSummary,
        hazards_json=json.dumps(hazards_dicts, ensure_ascii=False),
        change_reason=req.changeReason,
        hazards_controlled=req.hazardsControlled,
        record_hash=chain.to_hex0x(record_hash_bytes),
        device_address=signed["signerAddress"],
        signature=chain.to_hex0x(signed["signature"]),
        timestamp=signed["record"]["timestamp"],
    )
    return {
        "txHash": tx_hash,
        "nonce": nonce_hex,
        "recordHash": chain.to_hex0x(record_hash_bytes),
        "caseId": chain.to_hex0x(case_id_bytes),
    }


def _serialize_site_record_row(r) -> dict:
    return {
        "nonce": r["nonce"],
        "txHash": r["tx_hash"],
        "processSummary": r["process_summary"],
        "hazards": json.loads(r["hazards_json"]),
        "changeReason": r["change_reason"],
        "hazardsControlled": bool(r["hazards_controlled"]),
        "recordHash": r["record_hash"],
        "adminName": chain.name_for_address(r["device_address"]) or r["device_address"],
        "timestamp": r["timestamp"],
        "caseId": r["case_id"],
    }


@app.get("/site/records/{site}")
def get_site_records(site: str):
    return [_serialize_site_record_row(r) for r in db.list_site_records(site)]


@app.get("/verify/site/{nonce}")
def verify_site_record(nonce: str):
    """위험성평가 검증. DB 원문을 해시해서 '온체인에 저장된' recordHash와 비교한다."""
    nonce_bytes = _parse_nonce(nonce)
    record = db.get_site_record(nonce)
    if record is None:
        raise HTTPException(404, "no site record found for this nonce")

    onchain = chain.get_onchain_site_record(nonce_bytes)
    if onchain is None:
        return {"onchain": False, "sigValid": False, "contentIntact": False, "submittedBy": None}
    data = onchain["data"]

    recovered = chain.recover(chain.SITE_RECORD_TYPES, data, chain.from_hex0x(record["signature"]))
    sig_valid = recovered.lower() == onchain["supervisor"].lower()

    content_json = _site_record_content(
        record["process_summary"], json.loads(record["hazards_json"]), record["change_reason"]
    )
    content_intact = chain.hash_text(content_json) == data["recordHash"]

    return {
        "onchain": True,
        "sigValid": sig_valid,
        "contentIntact": content_intact,
        "anchoredAt": onchain["anchoredAt"],
        "submittedBy": chain.name_for_address(onchain["supervisor"]) or onchain["supervisor"],
    }


# ======================================================================
# Case 확정: 시공사 감독자 제출 → 감리 승인 → 발주처 승인
# ======================================================================


def _serialize_checkin_row(c) -> dict:
    o = db.get_override_for_checkin(c["nonce"])
    return {
        "nonce": c["nonce"],
        "txHash": c["tx_hash"],
        "helmetPass": bool(c["helmet_pass"]),
        "shoesPass": bool(c["shoes_pass"]),
        "alcoholPass": bool(c["alcohol_pass"]),
        "timestamp": c["timestamp"],
        "overridden": o is not None,
        "overrideReason": OVERRIDE_REASONS.get(o["reason_code"]) if o else None,
        "entryStatus": c["entry_status"],
        "deviceSeq": c["device_seq"],
    }


def _case_scope(case_id_hex: str) -> dict:
    """검토 범위 = 그 시점에 케이스에 걸린 위험성평가·검사·override 기록의 nonce 목록."""
    return {
        "siteRecordNonces": sorted(r["nonce"] for r in db.list_site_records_by_case(case_id_hex)),
        "checkinNonces": sorted(c["nonce"] for c in db.list_checkins_by_case(case_id_hex)),
        "overrideNonces": sorted(o["nonce"] for o in db.list_overrides_by_case(case_id_hex)),
        "emergencyNonces": sorted(e["nonce"] for e in db.list_emergencies_by_case(case_id_hex)),
    }


def _scope_json(scope: dict) -> str:
    return json.dumps(scope, ensure_ascii=False, sort_keys=True)


@app.get("/case/{site}/{workDate}")
def get_case(site: str, workDate: str):
    """현장+작업일을 하나의 케이스로 묶어 그날 기록 전부와 온체인 확정 상태를 함께 보여준다."""
    case_id = chain.case_id_hash(site, workDate)
    case_id_hex = chain.to_hex0x(case_id)
    return {
        "caseId": case_id_hex,
        "siteRecords": [_serialize_site_record_row(r) for r in db.list_site_records_by_case(case_id_hex)],
        "checkIns": [_serialize_checkin_row(c) for c in db.list_checkins_by_case(case_id_hex)],
        "emergencies": [
            {"nonce": e["nonce"], "reason": EMERGENCY_REASONS.get(e["reason_code"]), "timestamp": e["timestamp"],
             "supervisor": chain.name_for_address(e["supervisor_address"]) or e["supervisor_address"],
             "approver": chain.name_for_address(e["approver_address"]) or e["approver_address"]}
            for e in db.list_emergencies_by_case(case_id_hex)
        ],
        "state": chain.get_case_state(case_id),
        "history": [
            {**h, "reason": REJECT_REASONS.get(h["reasonCode"]) if h["action"] == "reject" else None}
            for h in chain.get_case_history(case_id)
        ],
    }


class CaseSubmitRequest(BaseModel):
    siteId: str
    workDate: str
    supervisorName: str


@app.post("/case/submit")
def submit_case(req: CaseSubmitRequest):
    """시공사 감독자가 그날 기록 전체를 검토 범위로 고정해 제출한다. 이것만으로는 확정되지 않는다."""
    if req.supervisorName not in chain.ADMIN_NAMES:
        raise HTTPException(400, "unknown supervisorName")
    case_id = chain.case_id_hash(req.siteId, req.workDate)
    case_id_hex = chain.to_hex0x(case_id)
    scope = _case_scope(case_id_hex)
    if not any(scope.values()):
        raise HTTPException(400, "no records found for this case yet")
    scope_json = _scope_json(scope)

    return _do_case_action(
        case_id, chain.hash_text(scope_json), chain.ACTION_SUBMIT, 0, chain.supervisor_account(req.supervisorName),
        scope_json,
    )


class CaseReviewRequest(BaseModel):
    siteId: str
    workDate: str
    reviewer: str  # "inspector"(감리) | "owner"(발주처)
    decision: str  # "approve" | "reject"
    reasonCode: int = 0  # 반려일 때 필수


def _case_review_message(req: CaseReviewRequest) -> tuple[bytes, dict]:
    if req.decision not in ("approve", "reject"):
        raise HTTPException(400, "decision must be approve or reject")
    if req.decision == "reject" and req.reasonCode not in REJECT_REASONS:
        raise HTTPException(400, "reject requires a valid reasonCode")
    if req.reviewer not in ("inspector", "owner"):
        raise HTTPException(400, "reviewer must be inspector or owner")
    case_id = chain.case_id_hash(req.siteId, req.workDate)
    state = chain.get_case_state(case_id)
    submission = db.latest_case_submission(chain.to_hex0x(case_id))
    if submission is None:
        raise HTTPException(400, "case not submitted yet")
    if chain.to_hex0x(chain.hash_text(submission["scope_json"])) != state["scopeHash"]:
        raise HTTPException(409, "submitted scope does not match chain")
    action = chain.ACTION_APPROVE if req.decision == "approve" else chain.ACTION_REJECT
    reason = req.reasonCode if action == chain.ACTION_REJECT else 0
    # 제출된 범위(온체인 scopeHash) 그대로 승인/반려한다
    message = chain.case_action_message(case_id, chain.from_hex0x(state["scopeHash"]), action, reason,
                                        secrets.token_bytes(32))
    return case_id, message


@app.post("/case/review/prepare")
def review_case_prepare(req: CaseReviewRequest):
    """감리·발주처 지갑이 서명할 EIP-712 데이터를 만든다. 서버는 서명하지 않는다."""
    _, message = _case_review_message(req)
    nonce = chain.to_hex0x(message["nonce"])
    typed = chain.typed_data(chain.CASE_ACTION_TYPES, message)
    db.save_pending(nonce, "case_review", req.siteId, json.dumps({"message": typed["message"], "reviewer": req.reviewer}))
    return {"nonce": nonce, "typedData": typed}


class SignatureSubmit(BaseModel):
    nonce: str
    signature: str


@app.post("/case/review/submit")
def review_case_submit(req: SignatureSubmit):
    """지갑 서명을 받아 체인에 전달한다. 서명 대상은 서버가 prepare 때 보관한 원문 그대로다."""
    pending = db.get_pending(req.nonce)
    if pending is None or pending["kind"] != "case_review" or pending["done"]:
        raise HTTPException(404, "no pending case review for this nonce")
    payload = json.loads(pending["payload_json"])
    message = chain.message_from_json(chain.CASE_ACTION_TYPES, payload["message"])
    sig = chain.from_hex0x(req.signature)
    signer = _check_wallet_signer(chain.CASE_ACTION_TYPES, message, sig, (payload["reviewer"],))
    result = _submit_case_action(message, sig, signer, None)
    db.mark_pending_done(req.nonce)
    return result


@app.post("/case/review")
def review_case(req: CaseReviewRequest):
    """(server 모드 백업) 감리 또는 발주처의 승인/반려를 백엔드 키로 대신 서명한다."""
    _require_server_signing()
    try:
        _, account = chain.reviewer_account(req.reviewer)
    except ValueError as e:
        raise HTTPException(400, str(e))

    case_id = chain.case_id_hash(req.siteId, req.workDate)
    state = chain.get_case_state(case_id)
    # 검토자가 보는 목록(DB 원문)이 제출 때 그 목록인지 먼저 확인
    submission = db.latest_case_submission(chain.to_hex0x(case_id))
    if submission is None:
        raise HTTPException(400, "case not submitted yet")
    if chain.to_hex0x(chain.hash_text(submission["scope_json"])) != state["scopeHash"]:
        raise HTTPException(409, "submitted scope does not match chain")
    action = chain.ACTION_APPROVE if req.decision == "approve" else chain.ACTION_REJECT
    reason = req.reasonCode if action == chain.ACTION_REJECT else 0
    # 제출된 범위(온체인 scopeHash) 그대로 승인/반려한다
    return _do_case_action(case_id, chain.from_hex0x(state["scopeHash"]), action, reason, account, None)


def _do_case_action(case_id: bytes, scope_hash: bytes, action: int, reason: int, account, scope_json):
    nonce = secrets.token_bytes(32)
    signed = chain.build_and_sign_case_action(case_id, scope_hash, action, reason, nonce, account)
    return _submit_case_action(signed["action"], signed["signature"], signed["signerAddress"], scope_json)


def _submit_case_action(message: dict, signature: bytes, signer_address: str, scope_json):
    try:
        tx_hash = chain.submit_case_action(message, signature)
    except ONCHAIN_ERRORS as e:
        raise HTTPException(400, f"on-chain submission rejected: {chain.describe_error(e)}")

    case_id = message["caseId"]
    db.record_case_action(
        nonce=chain.to_hex0x(message["nonce"]),
        case_id=chain.to_hex0x(case_id),
        action=message["action"],
        reason_code=message["reasonCode"],
        scope_hash=chain.to_hex0x(message["scopeHash"]),
        scope_json=scope_json,
        signer_address=signer_address,
        signature=chain.to_hex0x(signature),
        tx_hash=tx_hash,
        timestamp=message["timestamp"],
    )
    return {"txHash": tx_hash, "caseId": chain.to_hex0x(case_id), "state": chain.get_case_state(case_id)}


@app.get("/verify/case/{site}/{workDate}")
def verify_case(site: str, workDate: str):
    case_id = chain.case_id_hash(site, workDate)
    case_id_hex = chain.to_hex0x(case_id)
    state = chain.get_case_state(case_id)
    submission = db.latest_case_submission(case_id_hex)
    if submission is None or state["status"] == "None":
        return {"status": state["status"], "round": state["round"], "scopeIntact": False,
                "recordsPresent": False, "addedAfterSubmit": 0}

    # 제출 원문 해시 == 온체인 scopeHash
    scope_intact = chain.to_hex0x(chain.hash_text(submission["scope_json"])) == state["scopeHash"]
    try:
        submitted = json.loads(submission["scope_json"])
        submitted = {k: submitted.get(k, []) for k in ("siteRecordNonces", "checkinNonces", "overrideNonces",
                                                         "emergencyNonces")}
    except (ValueError, KeyError, TypeError):
        return {"status": state["status"], "round": state["round"], "scopeIntact": False,
                "recordsPresent": False, "addedAfterSubmit": 0}

    # 범위 안의 기록이 전부 "체인에" 실제로 있는지 (DB끼리 비교 X)
    def on_chain(fn, n):
        try:
            return bool(fn(chain.from_hex0x(n)))
        except ValueError:
            return False

    records_present = (
        all(on_chain(chain.get_onchain_site_record, n) for n in submitted["siteRecordNonces"])
        and all(on_chain(chain.get_onchain_checkin, n) for n in submitted["checkinNonces"])
        and all(on_chain(chain.is_nonce_used, n) for n in submitted["overrideNonces"])
        and all(on_chain(chain.is_nonce_used, n) for n in submitted["emergencyNonces"])
    )
    current = _case_scope(case_id_hex)

    return {
        "status": state["status"],
        "round": state["round"],
        "scopeIntact": scope_intact,
        "recordsPresent": records_present,
        "addedAfterSubmit": sum(len(set(current[k]) - set(submitted[k])) for k in current),
    }


# ======================================================================
# 게이트 기기 · 서명자 해제 이력 · 시연 제어
# ======================================================================


@app.get("/devices")
def list_devices():
    """게이트 기기별 온체인 일련번호 집계 (누락 = 받은 최대 번호 - 받은 건수)."""
    stats = chain.get_device_stats(chain.DEVICE_ADDRESS)
    return [{
        "address": chain.DEVICE_ADDRESS,
        "name": chain.name_for_address(chain.DEVICE_ADDRESS),
        "active": chain.has_role("device", chain.DEVICE_ADDRESS),
        **stats,
    }]


@app.get("/signers/revocations")
def list_revocations():
    return [{**r, "reason": REVOKE_REASONS.get(r["reasonCode"])} for r in chain.get_revocations()]


class RevokeRequest(BaseModel):
    role: str = "device"  # "device" | "supervisor"
    address: str | None = None  # 비우면 데모 게이트 기기
    reasonCode: int


@app.post("/signers/revoke")
def revoke_signer(req: RevokeRequest):
    """시공사 운영 관리자의 즉시 해제. 사유 코드·해제 시점 일련번호가 체인 이력에 남아 감리가 확인한다.
    로그인이 없는 데모 백엔드라 시연 제어가 켜져 있을 때만 연다."""
    _require_demo_controls()
    if req.role not in chain.ROLE_IDS:
        raise HTTPException(400, "role must be device or supervisor")
    if req.reasonCode not in REVOKE_REASONS:
        raise HTTPException(400, "unknown reasonCode")
    address = req.address or chain.DEVICE_ADDRESS
    try:
        tx_hash = chain.revoke_signer(req.role, address, req.reasonCode)
    except ONCHAIN_ERRORS as e:
        raise HTTPException(400, f"on-chain submission rejected: {chain.describe_error(e)}")
    return {"txHash": tx_hash, "reason": REVOKE_REASONS[req.reasonCode]}


class RegisterRequest(BaseModel):
    role: str = "device"
    address: str | None = None


@app.post("/signers/register")
def register_signer(req: RegisterRequest):
    """시공사 제안. wallet 모드에서는 제안만 하고, 감리·발주처가 감리 화면에서 지갑으로 승인해야 등록된다.
    server 모드(백업)에서는 백엔드가 감리 키로 승인까지 한다."""
    _require_demo_controls()
    if req.role not in chain.ROLE_IDS:
        raise HTTPException(400, "role must be device or supervisor")
    address = req.address or chain.DEVICE_ADDRESS
    if chain.has_role(req.role, address):
        raise HTTPException(400, "already registered")
    try:
        proposal_id = chain.propose_signer(req.role, address)
        if chain.WALLET_SIGNING:
            return {"proposalId": proposal_id, "pendingApproval": True}
        msg = chain.signer_approval_message(proposal_id)
        sig = chain.server_sign(chain.SIGNER_APPROVAL_TYPES, {k: msg[k] for k in ("proposalId", "role", "account")},
                                "inspector")
        return {"proposalId": proposal_id, "txHash": chain.approve_signer(proposal_id, sig)}
    except ValueError as e:
        raise HTTPException(400, str(e))
    except ONCHAIN_ERRORS as e:
        raise HTTPException(400, f"on-chain submission rejected: {chain.describe_error(e)}")


@app.get("/signers/proposals")
def signer_proposals():
    """감리·발주처 승인을 기다리는 서명자 등록 제안 (+ 지갑이 서명할 EIP-712 데이터)."""
    return chain.list_pending_proposals()


class ApproveRequest(BaseModel):
    proposalId: int
    signature: str


@app.post("/signers/approve")
def approve_signer(req: ApproveRequest):
    """감리·발주처의 지갑 승인 서명을 체인에 전달한다. 누가 제출하든 컨트랙트는 서명자로 판단한다."""
    msg = chain.signer_approval_message(req.proposalId)
    if msg["executed"]:
        raise HTTPException(400, "proposal already approved")
    sig = chain.from_hex0x(req.signature)
    _check_wallet_signer(chain.SIGNER_APPROVAL_TYPES, {k: msg[k] for k in ("proposalId", "role", "account")}, sig,
                         ("inspector", "owner"))
    try:
        return {"txHash": chain.approve_signer(req.proposalId, sig)}
    except ONCHAIN_ERRORS as e:
        raise HTTPException(400, f"on-chain submission rejected: {chain.describe_error(e)}")


class RelayModeRequest(BaseModel):
    mode: str


@app.get("/demo/relay")
def get_relay_mode():
    return {"mode": db.get_setting("relay_mode", "normal"), "demoControls": config.DEMO_CONTROLS}


@app.post("/demo/relay")
def set_relay_mode(req: RelayModeRequest):
    """시연: 시공사 릴레이를 멈추거나(paused) 불합격만 빼고(drop_failed) 제출하게 만든다.
    게이트 → 감사 저장소 경로는 그대로라, 감리 화면에 '체인 미제출' 기록이 쌓이는 걸 보여줄 수 있다."""
    _require_demo_controls()
    if req.mode not in RELAY_MODES:
        raise HTTPException(400, f"mode must be one of {RELAY_MODES}")
    db.set_setting("relay_mode", req.mode)
    return {"mode": req.mode}


@app.get("/rejections/{site}")
def list_rejections(site: str):
    """체인이 거부한 제출 로그 (위조 서명·nonce 재사용·시간 초과·역할 없음 등).
    거부된 트랜잭션은 체인에 흔적이 남지 않아서, 릴레이가 받은 거부 응답을 여기에 남겨 감리가 볼 수 있게 한다.
    이 로그는 시공사 백엔드가 쓰는 것이라 신뢰 기준이 아니라 참고용이다 (누락 판정은 감사 저장소 ↔ 체인 대조가 기준)."""
    return [
        {"kind": r["kind"], "nonce": r["nonce"], "error": r["error"], "at": r["at"]}
        for r in db.list_rejections(site)
    ]


# ======================================================================
# 긴급·장비 장애 예외 출입 (감독자 + 감리 또는 발주처 이중 서명)
# ======================================================================


class EmergencyRequest(BaseModel):
    siteId: str
    workerId: str
    reasonCode: int
    supervisorName: str
    reviewer: str = "inspector"  # server 모드에서 함께 서명할 기관: inspector(감리) | owner(발주처)
    workDate: str | None = None


def _emergency_message(req: EmergencyRequest) -> dict:
    if req.reasonCode not in EMERGENCY_REASONS:
        raise HTTPException(400, "unknown reasonCode")
    if req.supervisorName not in chain.ADMIN_NAMES:
        raise HTTPException(400, "unknown supervisorName")
    work_date = req.workDate or _default_work_date()
    return chain.build_emergency_with_supervisor(
        chain.case_id_hash(req.siteId, work_date), chain.site_id_hash(req.siteId),
        chain.worker_id_hash(req.workerId, req.siteId, work_date), req.reasonCode, secrets.token_bytes(32),
        req.supervisorName,
    )


def _submit_emergency(entry: dict, supervisor_sig: bytes, reviewer_sig: bytes, site_id: str, worker_id: str):
    nonce = entry["nonce"]
    try:
        tx_hash = chain.submit_emergency(entry, supervisor_sig, reviewer_sig)
    except ONCHAIN_ERRORS as e:
        db.record_rejection("emergency", chain.to_hex0x(nonce), site_id, chain.describe_error(e))
        raise HTTPException(400, f"on-chain submission rejected: {chain.describe_error(e)}")
    stored = chain.contract.functions.getEmergencyEntry(nonce).call()
    db.record_emergency(
        nonce=chain.to_hex0x(nonce), case_id=chain.to_hex0x(entry["caseId"]), site_id=site_id,
        worker_id=worker_id, reason_code=entry["reasonCode"], supervisor_address=stored[1],
        approver_address=stored[2], tx_hash=tx_hash, timestamp=entry["timestamp"],
    )
    return {"txHash": tx_hash, "nonce": chain.to_hex0x(nonce), "reason": EMERGENCY_REASONS[entry["reasonCode"]],
            "approver": chain.name_for_address(stored[2]) or stored[2]}


@app.post("/gate/emergency/request")
def emergency_request(req: EmergencyRequest):
    """게이트 고장·응급 상황 등으로 정상 검사를 못 할 때: 감독자(시공사)가 먼저 서명해 요청을 올린다.
    감리 또는 발주처가 자기 지갑으로 공동 서명해야 체인에 기록된다 (감독자 혼자서는 불가)."""
    signed = _emergency_message(req)
    entry = signed["entry"]
    nonce = chain.to_hex0x(entry["nonce"])
    typed = chain.typed_data(chain.EMERGENCY_TYPES, entry)
    db.save_pending(nonce, "emergency", req.siteId, json.dumps({
        "message": typed["message"], "supervisorSig": chain.to_hex0x(signed["supervisorSig"]),
        "workerId": req.workerId, "supervisorName": req.supervisorName,
    }))
    return {"nonce": nonce, "typedData": typed, "reason": EMERGENCY_REASONS[req.reasonCode]}


@app.get("/gate/emergency/pending/{site}")
def emergency_pending(site: str):
    """공동 서명을 기다리는 예외 출입 요청. 서명 유효 시간(1시간) 안의 것만."""
    since = int(time.time()) - 55 * 60
    out = []
    for p in db.list_pending("emergency", since):
        if p["site_id"] != site:
            continue
        payload = json.loads(p["payload_json"])
        out.append({
            "nonce": p["nonce"], "createdAt": p["created_at"], "supervisor": payload["supervisorName"],
            "reason": EMERGENCY_REASONS.get(payload["message"]["reasonCode"]),
            "typedData": chain.typed_data(chain.EMERGENCY_TYPES, chain.message_from_json(chain.EMERGENCY_TYPES,
                                                                                         payload["message"])),
        })
    return out


@app.post("/gate/emergency/cosign")
def emergency_cosign(req: SignatureSubmit):
    """감리 또는 발주처의 지갑 서명을 받아 감독자 서명과 함께 체인에 제출한다."""
    pending = db.get_pending(req.nonce)
    if pending is None or pending["kind"] != "emergency" or pending["done"]:
        raise HTTPException(404, "no pending emergency request for this nonce")
    payload = json.loads(pending["payload_json"])
    entry = chain.message_from_json(chain.EMERGENCY_TYPES, payload["message"])
    sig = chain.from_hex0x(req.signature)
    _check_wallet_signer(chain.EMERGENCY_TYPES, entry, sig, ("inspector", "owner"))
    result = _submit_emergency(entry, chain.from_hex0x(payload["supervisorSig"]), sig, pending["site_id"],
                               payload["workerId"])
    db.mark_pending_done(req.nonce)
    return result


@app.post("/gate/emergency")
def emergency_entry(req: EmergencyRequest):
    """(server 모드 백업) 감독자 서명 + 백엔드가 가진 감리·발주처 키로 공동 서명까지 한 번에."""
    _require_server_signing()
    if req.reviewer not in ("inspector", "owner"):
        raise HTTPException(400, "reviewer must be inspector or owner")
    signed = _emergency_message(req)
    try:
        reviewer_sig = chain.server_sign(chain.EMERGENCY_TYPES, signed["entry"], req.reviewer)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return _submit_emergency(signed["entry"], signed["supervisorSig"], reviewer_sig, req.siteId, req.workerId)


@app.get("/emergencies/{site}")
def list_emergencies(site: str):
    return [{**e, "reason": EMERGENCY_REASONS.get(e["reasonCode"])} for e in chain.get_emergencies(site)]


# ======================================================================
# 사고 조사용 열람 (조사 토큰 필요, 모든 열람은 로그로 남는다)
# ======================================================================


def _require_investigator(token: str | None, name: str | None = "-") -> str:
    if not config.INVESTIGATOR_TOKEN:
        raise HTTPException(403, "investigation access is disabled (set INVESTIGATOR_TOKEN)")
    if not token or not secrets.compare_digest(token, config.INVESTIGATOR_TOKEN):
        raise HTTPException(401, "invalid investigator token")
    if not name or not name.strip():
        raise HTTPException(400, "investigator name is required")
    return name.strip()


class IdentifyRequest(BaseModel):
    nonce: str
    reason: str
    investigator: str  # 열람자 이름 (한글 가능해서 헤더가 아니라 본문으로 받는다)


@app.post("/investigation/identify")
def investigation_identify(req: IdentifyRequest, x_investigator_token: str | None = Header(None)):
    """사고 조사 때만: 검사 기록(nonce)의 날짜별 가명을 실제 사번으로 되돌린다. 누가·언제·왜 봤는지 남긴다."""
    who = _require_investigator(x_investigator_token, req.investigator)
    if len(req.reason.strip()) < 5:
        raise HTTPException(400, "reason is required")
    record = db.get_checkin(req.nonce)
    issued = db.get_nonce(req.nonce)
    if record is None or issued is None:
        raise HTTPException(404, "no check-in recorded for this nonce")
    db.log_access("identify", req.nonce, who, req.reason.strip())
    return {"workerId": issued["worker_id"], "siteId": issued["site_id"], "workerIdHash": record["worker_id_hash"]}


@app.get("/investigation/evidence/{nonce}")
def investigation_evidence(
    nonce: str,
    reason: str,
    investigator: str,
    x_investigator_token: str | None = Header(None),
):
    """사고 조사 때만: 암호화된 검사 사진을 복호화해서 내준다. 열람 기록이 남는다."""
    who = _require_investigator(x_investigator_token, investigator)
    if len(reason.strip()) < 5:
        raise HTTPException(400, "reason is required")
    record = db.get_checkin(nonce)
    photo = _read_photo(record["image_path"]) if record else None
    if photo is None:
        raise HTTPException(404, "photo not found")
    db.log_access("evidence", nonce, who, reason.strip())
    return Response(content=photo, media_type="image/jpeg")


@app.get("/investigation/access-log")
def investigation_access_log(x_investigator_token: str | None = Header(None)):
    _require_investigator(x_investigator_token)
    return [dict(r) for r in db.list_access_log()]
