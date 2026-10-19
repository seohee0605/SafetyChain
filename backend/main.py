import json
import secrets
import time
from datetime import date
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from web3.exceptions import ContractCustomError, ContractLogicError

import chain
import db
import vision

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
    }


# ======================================================================
# 출입 검사
# ======================================================================


class QrIssueRequest(BaseModel):
    workerId: str
    siteId: str


@app.post("/qr/issue")
def issue_qr(req: QrIssueRequest):
    return db.issue_nonce(req.workerId, req.siteId)


@app.post("/gate/check")
def gate_check(
    image: UploadFile = File(...),
    nonce: str = Form(...),
    alcoholPass: bool = Form(...),
    workerId: str = Form(...),
    siteId: str = Form(...),
    workDate: str = Form(None),
):
    nonce_row = db.get_nonce(nonce)
    if nonce_row is None:
        raise HTTPException(404, "nonce not found")
    if nonce_row["consumed"]:
        raise HTTPException(400, "nonce already used")
    if nonce_row["expires_at"] < int(time.time()):
        raise HTTPException(400, "nonce expired")
    # 다른 사람 QR로 체크인 못하게
    if nonce_row["worker_id"] != workerId or nonce_row["site_id"] != siteId:
        raise HTTPException(400, "QR was issued for a different worker/site")
    nonce_bytes = _parse_nonce(nonce)

    work_date = workDate or _default_work_date()

    image_bytes = image.file.read()
    image_path = UPLOAD_DIR / f"{nonce.removeprefix('0x')}_{Path(image.filename or 'capture.jpg').name}"
    image_path.write_bytes(image_bytes)
    evidence_bytes = chain.evidence_hash(image_bytes)

    ppe = vision.check_ppe(str(image_path))

    site_salt = db.get_or_create_site_salt(siteId)
    case_id_bytes = chain.case_id_hash(siteId, work_date)
    worker_id_bytes = chain.worker_id_hash(workerId, site_salt)
    model_hash_bytes = vision.get_model_hash()

    signed = chain.build_and_sign_checkin(
        case_id=case_id_bytes,
        worker_id=worker_id_bytes,
        site_id=chain.site_id_hash(siteId),
        helmet_pass=ppe["helmetPass"],
        shoes_pass=ppe["shoesPass"],
        alcohol_pass=alcoholPass,
        model_hash=model_hash_bytes,
        evidence=evidence_bytes,
        nonce=nonce_bytes,
    )

    # Gatekeeper: 온체인에 기록이 확정된 뒤에만 판정 결과를 돌려준다.
    try:
        tx_hash = chain.submit_checkin(signed["checkin"], signed["signature"])
    except ONCHAIN_ERRORS as e:
        raise HTTPException(400, f"on-chain submission rejected: {chain.describe_error(e)}")

    db.consume_nonce(nonce)
    db.record_checkin(
        nonce=nonce,
        case_id=chain.to_hex0x(case_id_bytes),
        site_id=siteId,
        worker_id_hash=chain.to_hex0x(worker_id_bytes),
        tx_hash=tx_hash,
        helmet_pass=ppe["helmetPass"],
        shoes_pass=ppe["shoesPass"],
        alcohol_pass=alcoholPass,
        model_hash=chain.to_hex0x(model_hash_bytes),
        device_address=chain.DEVICE_ADDRESS,
        signature=chain.to_hex0x(signed["signature"]),
        timestamp=signed["checkin"]["timestamp"],
        evidence_hash=chain.to_hex0x(evidence_bytes),
        image_path=str(image_path),
    )

    verdict = ppe["helmetPass"] and ppe["shoesPass"] and alcoholPass
    return {
        "txHash": tx_hash,
        "verdict": verdict,
        "nonce": nonce,
        "helmetPass": ppe["helmetPass"],
        "shoesPass": ppe["shoesPass"],
        "alcoholPass": alcoholPass,
        # 음주 불합격은 AI 판정이 아니라서 수동 처리 대상이 아니다
        "overridable": (not verdict) and alcoholPass,
    }


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
    return {"txHash": tx_hash, "reason": OVERRIDE_REASONS[req.reasonCode], "entryAllowed": True}


@app.get("/dashboard/{site}")
def dashboard(site: str):
    stats = chain.get_site_stats(site)  # 검사·불합격·override 수는 온체인 값
    checked = stats["checkIns"]
    unchecked = db.count_unchecked(site)  # 만료된 QR 수는 오프체인에만 있음
    failed = stats["failed"]
    total = checked + unchecked
    return {
        "checkedCount": checked,
        "uncheckedCount": unchecked,
        "rate": checked / total if total else 1.0,
        "failedCount": failed,
        "overrideCount": stats["overrides"],
        "overrideRate": (stats["overrides"] / failed) if failed else 0.0,
    }


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
    )

    # 3) 사진 원본이 바뀌지 않았는가
    evidence_intact = False
    if record["image_path"] and Path(record["image_path"]).exists():
        evidence_intact = chain.evidence_hash(Path(record["image_path"]).read_bytes()) == data["evidenceHash"]

    # 4) 지금 서버의 AI 모델이 판정 당시 모델과 같은가
    model_hash_match = data["modelHash"] == vision.get_model_hash()

    return {
        "onchain": True,
        "sigValid": sig_valid,
        "recordMatchesChain": record_matches,
        "evidenceIntact": evidence_intact,
        "modelHashMatch": model_hash_match,
        "anchoredAt": onchain["anchoredAt"],
        "device": onchain["device"],
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
    out = []
    for role in ("inspector", "owner"):
        try:
            name, acc = chain.reviewer_account(role)
            out.append({"role": role, "name": name, "address": acc.address})
        except ValueError:
            pass
    return out


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
    }


def _case_scope(case_id_hex: str) -> dict:
    """검토 범위 = 그 시점에 케이스에 걸린 위험성평가·검사·override 기록의 nonce 목록."""
    return {
        "siteRecordNonces": sorted(r["nonce"] for r in db.list_site_records_by_case(case_id_hex)),
        "checkinNonces": sorted(c["nonce"] for c in db.list_checkins_by_case(case_id_hex)),
        "overrideNonces": sorted(o["nonce"] for o in db.list_overrides_by_case(case_id_hex)),
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


@app.post("/case/review")
def review_case(req: CaseReviewRequest):
    """감리 또는 발주처의 승인/반려. 어느 역할이 서명할 차례인지는 컨트랙트가 강제한다."""
    if req.decision not in ("approve", "reject"):
        raise HTTPException(400, "decision must be approve or reject")
    if req.decision == "reject" and req.reasonCode not in REJECT_REASONS:
        raise HTTPException(400, "reject requires a valid reasonCode")
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
    try:
        tx_hash = chain.submit_case_action(signed["action"], signed["signature"])
    except ONCHAIN_ERRORS as e:
        raise HTTPException(400, f"on-chain submission rejected: {chain.describe_error(e)}")

    db.record_case_action(
        nonce=chain.to_hex0x(nonce),
        case_id=chain.to_hex0x(case_id),
        action=action,
        reason_code=reason,
        scope_hash=chain.to_hex0x(scope_hash),
        scope_json=scope_json,
        signer_address=signed["signerAddress"],
        signature=chain.to_hex0x(signed["signature"]),
        tx_hash=tx_hash,
        timestamp=signed["action"]["timestamp"],
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
        submitted = {k: submitted[k] for k in ("siteRecordNonces", "checkinNonces", "overrideNonces")}
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
    )
    current = _case_scope(case_id_hex)

    return {
        "status": state["status"],
        "round": state["round"],
        "scopeIntact": scope_intact,
        "recordsPresent": records_present,
        "addedAfterSubmit": sum(len(set(current[k]) - set(submitted[k])) for k in current),
    }
