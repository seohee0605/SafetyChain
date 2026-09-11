import json
import secrets
import shutil
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

# 데모 규모(로컬 프론트 + 로컬 백엔드)라 오리진을 넓게 허용한다. 인증/로그인 자체가 없는
# 스코프라 자격 증명(cookie)도 안 쓰므로 CORS를 좁힐 실익이 없다.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = Path(__file__).parent / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)


@app.on_event("startup")
def _startup() -> None:
    db.init_db()


def _default_work_date() -> str:
    return date.today().isoformat()


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

    work_date = workDate or _default_work_date()

    image_path = UPLOAD_DIR / f"{nonce.lstrip('0x')}_{image.filename}"
    with image_path.open("wb") as f:
        shutil.copyfileobj(image.file, f)

    ppe = vision.check_ppe(str(image_path))

    site_salt = db.get_or_create_site_salt(siteId)
    case_id_bytes = chain.case_id_hash(siteId, work_date)
    worker_id_bytes = chain.worker_id_hash(workerId, site_salt)
    site_id_bytes = chain.site_id_hash(siteId)
    model_hash_bytes = vision.get_model_hash()
    nonce_bytes = chain.from_hex0x(nonce)

    signed = chain.build_and_sign_checkin(
        case_id=case_id_bytes,
        worker_id=worker_id_bytes,
        site_id=site_id_bytes,
        helmet_pass=ppe["helmetPass"],
        shoes_pass=ppe["shoesPass"],
        alcohol_pass=alcoholPass,
        model_hash=model_hash_bytes,
        nonce=nonce_bytes,
    )

    try:
        tx_hash = chain.submit_checkin(signed["checkin"], signed["signature"])
    except (ContractLogicError, ContractCustomError) as e:
        raise HTTPException(400, f"on-chain submission rejected: {e}")

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
    )

    verdict = ppe["helmetPass"] and ppe["shoesPass"] and alcoholPass
    return {"txHash": tx_hash, "verdict": verdict}


@app.get("/dashboard/{site}")
def dashboard(site: str):
    return db.dashboard_counts(site)


@app.get("/verify/{nonce}")
def verify(nonce: str):
    record = db.get_checkin(nonce)
    if record is None:
        raise HTTPException(404, "no check-in recorded for this nonce")

    nonce_bytes = chain.from_hex0x(nonce)
    onchain = chain.is_nonce_used(nonce_bytes)

    checkin = {
        "caseId": chain.from_hex0x(record["case_id"]),
        "workerId": chain.from_hex0x(record["worker_id_hash"]),
        "siteId": chain.site_id_hash(record["site_id"]),
        "helmetPass": bool(record["helmet_pass"]),
        "shoesPass": bool(record["shoes_pass"]),
        "alcoholPass": bool(record["alcohol_pass"]),
        "modelHash": chain.from_hex0x(record["model_hash"]),
        "nonce": nonce_bytes,
        "timestamp": record["timestamp"],
    }
    signature = chain.from_hex0x(record["signature"])
    recovered = chain.recover_signer(checkin, signature)
    sig_valid = recovered.lower() == record["device_address"].lower()

    model_hash_match = record["model_hash"] == chain.to_hex0x(vision.get_model_hash())

    return {"onchain": onchain, "sigValid": sig_valid, "modelHashMatch": model_hash_match}


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
    """등록된 안전관리자 이름 목록. 로그인 없이 프론트 드롭다운에서 선택하는 용도."""
    return [{"name": name, "address": chain.ADMIN_ADDRESSES[name]} for name in chain.ADMIN_NAMES]


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
    site_id_bytes = chain.site_id_hash(req.siteId)
    nonce_bytes = secrets.token_bytes(32)

    signed = chain.build_and_sign_site_record(
        case_id=case_id_bytes,
        site_id=site_id_bytes,
        record_hash=record_hash_bytes,
        hazards_controlled=req.hazardsControlled,
        nonce=nonce_bytes,
        admin_name=req.adminName,
    )

    try:
        tx_hash = chain.submit_site_record(signed["record"], signed["signature"])
    except (ContractLogicError, ContractCustomError) as e:
        raise HTTPException(400, f"on-chain submission rejected: {e}")

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


@app.get("/site/records/{site}")
def get_site_records(site: str):
    rows = db.list_site_records(site)
    return [
        {
            "nonce": r["nonce"],
            "txHash": r["tx_hash"],
            "processSummary": r["process_summary"],
            "hazards": json.loads(r["hazards_json"]),
            "changeReason": r["change_reason"],
            "hazardsControlled": bool(r["hazards_controlled"]),
            "recordHash": r["record_hash"],
            "timestamp": r["timestamp"],
            "adminName": chain.admin_name_for_address(r["device_address"]) or r["device_address"],
            "caseId": r["case_id"],
        }
        for r in rows
    ]


@app.get("/verify/site/{nonce}")
def verify_site_record(nonce: str):
    record = db.get_site_record(nonce)
    if record is None:
        raise HTTPException(404, "no site record found for this nonce")

    nonce_bytes = chain.from_hex0x(nonce)
    onchain = chain.is_nonce_used(nonce_bytes)

    site_record = {
        "caseId": chain.from_hex0x(record["case_id"]),
        "siteId": chain.site_id_hash(record["site_id"]),
        "recordHash": chain.from_hex0x(record["record_hash"]),
        "hazardsControlled": bool(record["hazards_controlled"]),
        "nonce": nonce_bytes,
        "timestamp": record["timestamp"],
    }
    signature = chain.from_hex0x(record["signature"])
    recovered = chain.recover_site_record_signer(site_record, signature)
    sig_valid = recovered.lower() == record["device_address"].lower()

    content_json = _site_record_content(
        record["process_summary"], json.loads(record["hazards_json"]), record["change_reason"]
    )
    recomputed_hash = chain.to_hex0x(chain.hash_text(content_json))
    content_intact = recomputed_hash == record["record_hash"]

    return {
        "onchain": onchain,
        "sigValid": sig_valid,
        "contentIntact": content_intact,
        "submittedBy": chain.admin_name_for_address(record["device_address"]) or record["device_address"],
    }


def _serialize_checkin_row(c) -> dict:
    return {
        "nonce": c["nonce"],
        "txHash": c["tx_hash"],
        "helmetPass": bool(c["helmet_pass"]),
        "shoesPass": bool(c["shoes_pass"]),
        "alcoholPass": bool(c["alcohol_pass"]),
        "timestamp": c["timestamp"],
    }


def _serialize_site_record_row(r) -> dict:
    return {
        "nonce": r["nonce"],
        "txHash": r["tx_hash"],
        "processSummary": r["process_summary"],
        "hazards": json.loads(r["hazards_json"]),
        "changeReason": r["change_reason"],
        "hazardsControlled": bool(r["hazards_controlled"]),
        "adminName": chain.admin_name_for_address(r["device_address"]) or r["device_address"],
        "timestamp": r["timestamp"],
    }


@app.get("/case/{site}/{workDate}")
def get_case(site: str, workDate: str):
    """현장+작업일을 하나의 케이스로 묶어서, 그날 위험성평가와 근로자 검사 전부를 한번에 보여준다."""
    case_id_hex = chain.to_hex0x(chain.case_id_hash(site, workDate))
    site_records = db.list_site_records_by_case(case_id_hex)
    checkins = db.list_checkins_by_case(case_id_hex)
    return {
        "caseId": case_id_hex,
        "siteRecords": [_serialize_site_record_row(r) for r in site_records],
        "checkIns": [_serialize_checkin_row(c) for c in checkins],
    }


def _review_scope_content(site_record_nonces: list[str], checkin_nonces: list[str]) -> str:
    """review_scope_hash를 만드는 원문. 검토 시점과 검증 시점에 반드시 같은 방식으로 직렬화해야 한다."""
    content = {"siteRecordNonces": sorted(site_record_nonces), "checkinNonces": sorted(checkin_nonces)}
    return json.dumps(content, ensure_ascii=False, sort_keys=True)


class CaseReviewRequest(BaseModel):
    siteId: str
    workDate: str
    adminName: str
    reviewResult: bool


@app.post("/case/review")
def submit_case_review(req: CaseReviewRequest):
    """감독자 최종 검토·서명. 그 시점에 케이스에 걸려있는 위험성평가·검사 기록 전체를 검토 범위로 고정한다."""
    if req.adminName not in chain.ADMIN_NAMES:
        raise HTTPException(400, "unknown adminName")

    case_id_bytes = chain.case_id_hash(req.siteId, req.workDate)
    case_id_hex = chain.to_hex0x(case_id_bytes)

    site_records = db.list_site_records_by_case(case_id_hex)
    checkins = db.list_checkins_by_case(case_id_hex)
    if not site_records and not checkins:
        raise HTTPException(400, "no records found for this case yet")

    site_record_nonces = [r["nonce"] for r in site_records]
    checkin_nonces = [c["nonce"] for c in checkins]
    scope_content = _review_scope_content(site_record_nonces, checkin_nonces)
    review_scope_hash_bytes = chain.hash_text(scope_content)
    nonce_bytes = secrets.token_bytes(32)

    signed = chain.build_and_sign_case_review(
        case_id=case_id_bytes,
        review_scope_hash=review_scope_hash_bytes,
        review_result=req.reviewResult,
        nonce=nonce_bytes,
        admin_name=req.adminName,
    )

    try:
        tx_hash = chain.submit_case_review(signed["review"], signed["signature"])
    except (ContractLogicError, ContractCustomError) as e:
        raise HTTPException(400, f"on-chain submission rejected: {e}")

    nonce_hex = chain.to_hex0x(nonce_bytes)
    db.record_case_review(
        nonce=nonce_hex,
        case_id=case_id_hex,
        tx_hash=tx_hash,
        reviewed_site_record_nonces=json.dumps(site_record_nonces),
        reviewed_checkin_nonces=json.dumps(checkin_nonces),
        review_scope_hash=chain.to_hex0x(review_scope_hash_bytes),
        review_result=req.reviewResult,
        device_address=signed["signerAddress"],
        signature=chain.to_hex0x(signed["signature"]),
        timestamp=signed["review"]["timestamp"],
    )

    return {
        "txHash": tx_hash,
        "nonce": nonce_hex,
        "caseId": case_id_hex,
        "reviewedSiteRecords": len(site_record_nonces),
        "reviewedCheckIns": len(checkin_nonces),
    }


@app.get("/case/reviews/{site}/{workDate}")
def get_case_reviews(site: str, workDate: str):
    case_id_hex = chain.to_hex0x(chain.case_id_hash(site, workDate))
    rows = db.list_case_reviews(case_id_hex)
    return [
        {
            "nonce": r["nonce"],
            "txHash": r["tx_hash"],
            "reviewResult": bool(r["review_result"]),
            "reviewedSiteRecordNonces": json.loads(r["reviewed_site_record_nonces"]),
            "reviewedCheckinNonces": json.loads(r["reviewed_checkin_nonces"]),
            "adminName": chain.admin_name_for_address(r["device_address"]) or r["device_address"],
            "timestamp": r["timestamp"],
        }
        for r in rows
    ]


@app.get("/verify/case/{nonce}")
def verify_case_review(nonce: str):
    record = db.get_case_review(nonce)
    if record is None:
        raise HTTPException(404, "no case review found for this nonce")

    nonce_bytes = chain.from_hex0x(nonce)
    onchain = chain.is_nonce_used(nonce_bytes)

    review = {
        "caseId": chain.from_hex0x(record["case_id"]),
        "reviewScopeHash": chain.from_hex0x(record["review_scope_hash"]),
        "reviewResult": bool(record["review_result"]),
        "nonce": nonce_bytes,
        "timestamp": record["timestamp"],
    }
    signature = chain.from_hex0x(record["signature"])
    recovered = chain.recover_case_review_signer(review, signature)
    sig_valid = recovered.lower() == record["device_address"].lower()

    scope_content = _review_scope_content(
        json.loads(record["reviewed_site_record_nonces"]), json.loads(record["reviewed_checkin_nonces"])
    )
    recomputed_hash = chain.to_hex0x(chain.hash_text(scope_content))
    scope_intact = recomputed_hash == record["review_scope_hash"]

    return {
        "onchain": onchain,
        "sigValid": sig_valid,
        "scopeIntact": scope_intact,
        "reviewedBy": chain.admin_name_for_address(record["device_address"]) or record["device_address"],
    }
