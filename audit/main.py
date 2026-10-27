"""감리 감사 저장소 (Audit Store).

시공사 백엔드와 별개로 감리 쪽에서 운영하는 서비스다. 프로세스·포트·DB 모두 분리되어 있고,
시공사 백엔드 코드를 import하지 않는다.

- 게이트 기기는 검사 기록에 서명한 직후, 시공사 릴레이가 체인에 내기 "전에" 이곳으로 사본을 보낸다.
- 이곳은 받은 기록의 EIP-712 서명을 직접 복구해, 체인에 등록된 게이트 기기 서명인지 확인한 뒤 보관한다.
- 감리 대시보드는 이 원본을 "체인에 실제로 올라간 값"과 대조해 다음을 드러낸다.
    · 미제출(missing): 게이트가 서명했는데 일정 시간이 지나도 체인에 없음  ← 릴레이 중단·선택적 누락
    · 바꿔치기(replaced): 같은 기기·같은 일련번호인데 체인에는 다른 기록이 올라감
    · 불일치(mismatch): 같은 nonce인데 체인 값이 게이트 원본과 다름
    · 체인 전용(chainOnly): 체인엔 있는데 게이트가 이곳에 보내지 않은 기록
- 미제출 기록은 서명된 원본을 컨트랙트에 직접 모의 실행(eth_call, 가스 없음)해서 둘로 나눈다.
    · 제출 보류(withheld): 체인이 받을 수 있었는데 시공사가 내지 않음  ← 가장 강한 누락 증거
    · 체인 거부(rejected): 체인이 거부했을 기록 + 체인이 알려준 거부 사유
  시공사 릴레이의 거부 로그를 믿지 않고 감리가 체인에서 직접 확인하는 것이다.
  모의 실행은 '지금' 기준이라, 받은 직후 한 번 · 미제출로 판정될 때 한 번 실행해 결과를 저장해 둔다.
- 세 번째로 시공사 DB 목록도 받아 대조한다 (감사 저장소 · 시공사 DB · 체인 3자 대조).
    · 시공사 DB에도 없음: 시공사가 체인에도 안 내고 자기 기록에서도 지운 것
    · 시공사 DB에만 있음: 게이트 원본도 체인 기록도 없는데 시공사 DB에만 있는 것 (DB 조작 의심)

무결성 판단의 기준은 체인 값이고, 이 저장소는 "게이트가 무엇을 서명했는가"의 독립 증거다.
시공사 DB는 누락을 찾는 비교 대상으로만 쓰고 신뢰 기준으로 쓰지 않는다.
개인 지목을 피하기 위해 응답에 근로자 가명(workerId)은 내보내지 않는다.
"""

import json
import os
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

from eth_account import Account
from eth_account.messages import encode_typed_data
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from web3 import Web3

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
CONTRACT_ADDRESS = os.environ["CONTRACT_ADDRESS"]
# 게이트가 보낸 뒤 이 시간이 지나도 체인에 없으면 '미제출'로 판정 (그 전에는 '대기 중')
GRACE_SECONDS = int(os.environ.get("AUDIT_GRACE_SECONDS", "300"))
# 3자 대조용 시공사 백엔드 주소 (기록 목록만 읽는다)
CONTRACTOR_URL = os.environ.get("CONTRACTOR_URL", "http://127.0.0.1:8000")
DB_PATH = BASE / "audit.db"

w3 = Web3(Web3.HTTPProvider(RPC_URL))
contract = w3.eth.contract(
    address=Web3.to_checksum_address(CONTRACT_ADDRESS),
    abi=json.loads((BASE / "abi" / "SafetyGate.json").read_text()),
)
GATE_DEVICE_ROLE = Web3.keccak(text="GATE_DEVICE_ROLE")
ROLE_NAMES = {GATE_DEVICE_ROLE: "device", Web3.keccak(text="SUPERVISOR_ROLE"): "supervisor"}
ENTRY_STATUS = ["Granted", "Denied", "HeldNoAssessment", "LateAuditOnly", "HeldHazardsOpen", "SuspectTimestamp"]
EMERGENCY_REASONS = {1: "게이트 장비 장애", 2: "응급·구조 대응", 3: "정전·통신 장애"}
REVOKE_REASONS = {1: "키 유출 의심", 2: "기기 고장·교체", 3: "현장 철수"}

CHECKIN_FIELDS = [
    ("caseId", "bytes32"),
    ("workerId", "bytes32"),
    ("siteId", "bytes32"),
    ("helmetPass", "bool"),
    ("shoesPass", "bool"),
    ("alcoholPass", "bool"),
    ("modelHash", "bytes32"),
    ("evidenceHash", "bytes32"),
    ("nonce", "bytes32"),
    ("qrIssuedAt", "uint64"),
    ("qrExpiresAt", "uint64"),
    ("deviceSeq", "uint64"),
    ("timestamp", "uint64"),
]
CHECKIN_TYPES = {"CheckIn": [{"name": n, "type": t} for n, t in CHECKIN_FIELDS]}

SCHEMA = """
CREATE TABLE IF NOT EXISTS records (
    nonce TEXT PRIMARY KEY,
    device TEXT NOT NULL,
    device_seq INTEGER NOT NULL,
    site_id TEXT NOT NULL,         -- keccak256(현장ID). 체인과 같은 해시값만 보관
    checkin_json TEXT NOT NULL,    -- 게이트가 서명한 원본 필드 (hex/bool/int)
    signature TEXT NOT NULL,
    signed_at INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    receipt_check TEXT,            -- 받은 직후 모의 실행 결과: 'ok' 또는 컨트랙트 에러 이름
    missing_check TEXT,            -- 미제출로 판정될 때 모의 실행 결과
    missing_check_at INTEGER,
    UNIQUE (device, device_seq)
);

-- 같은 기기·같은 일련번호로 다른 기록이 들어온 시도 (정상 게이트라면 생기지 않음)
CREATE TABLE IF NOT EXISTS conflicts (
    device TEXT NOT NULL,
    device_seq INTEGER NOT NULL,
    nonce TEXT NOT NULL,
    checkin_json TEXT NOT NULL,
    received_at INTEGER NOT NULL
);
"""

app = FastAPI(title="SafetyChain Audit Store")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@contextmanager
def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


@app.on_event("startup")
def _startup() -> None:
    with get_conn() as conn:
        conn.executescript(SCHEMA)
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(records)")}
        for col, typ in (("receipt_check", "TEXT"), ("missing_check", "TEXT"), ("missing_check_at", "INTEGER")):
            if col not in cols:
                conn.execute(f"ALTER TABLE records ADD COLUMN {col} {typ}")


def _hex(b: bytes) -> str:
    return "0x" + bytes(b).hex()


def _parse_checkin(raw: dict) -> dict:
    """JSON(hex 문자열)로 받은 필드를 EIP-712 서명 검증용 타입으로 바꾼다."""
    out = {}
    for name, typ in CHECKIN_FIELDS:
        if name not in raw:
            raise HTTPException(400, f"missing field: {name}")
        v = raw[name]
        if typ == "bytes32":
            b = bytes.fromhex(str(v).removeprefix("0x"))
            if len(b) != 32:
                raise HTTPException(400, f"{name} must be 32 bytes")
            out[name] = b
        elif typ == "bool":
            if not isinstance(v, bool):
                raise HTTPException(400, f"{name} must be boolean")
            out[name] = v
        else:
            out[name] = int(v)
    return out


def _canonical(checkin: dict) -> dict:
    return {k: (_hex(v) if isinstance(v, bytes) else v) for k, v in checkin.items()}


def _error_selectors() -> dict[str, str]:
    out = {}
    for item in contract.abi:
        if item.get("type") == "error":
            sig = f"{item['name']}({','.join(i['type'] for i in item['inputs'])})"
            out[Web3.keccak(text=sig)[:4].hex().removeprefix("0x")] = item["name"]
    return out


_ERRORS = _error_selectors()


def _dry_run(checkin: dict, signature: bytes) -> str:
    """서명된 원본을 컨트랙트에 모의 실행한다 (eth_call, 트랜잭션 아님). 'ok' 또는 거부 사유(에러 이름)."""
    try:
        contract.functions.submitCheckIn(tuple(checkin[n] for n, _ in CHECKIN_FIELDS), signature).call(
            {"from": "0x000000000000000000000000000000000000dEaD"}, block_identifier="pending"
        )
        return "ok"
    except Exception as e:  # noqa: BLE001 - revert 데이터에서 에러 이름을 찾는다
        text = str(e).lower()
        for selector, name in _ERRORS.items():
            if selector in text:
                return name
        return "Reverted"


def _chain_check(receipt: str | None, missing: str | None) -> dict:
    """미제출 기록의 판정. 지금은 시간 초과로 거부되더라도 받은 직후에 유효했으면 '제출 보류'로 본다."""
    if missing == "ok" or (receipt == "ok" and missing == "StaleTimestamp"):
        return {"verdict": "withheld", "reason": None}
    reason = missing if missing and missing != "ok" else receipt
    return {"verdict": "rejected", "reason": reason}


def _recover(checkin: dict, signature: bytes) -> str:
    domain = {
        "name": "SafetyChain",
        "version": "1",
        "chainId": w3.eth.chain_id,
        "verifyingContract": contract.address,
    }
    typed = encode_typed_data(domain_data=domain, message_types=CHECKIN_TYPES, message_data=checkin)
    return Account.recover_message(typed, signature=signature)


# ======================================================================
# 게이트 → 감사 저장소
# ======================================================================


class RecordIn(BaseModel):
    checkin: dict
    signature: str


@app.post("/records")
def receive_record(body: RecordIn):
    checkin = _parse_checkin(body.checkin)
    try:
        signature = bytes.fromhex(body.signature.removeprefix("0x"))
        device = _recover(checkin, signature)
    except (ValueError, TypeError) as e:
        raise HTTPException(400, f"invalid signature: {e}")
    # 체인에 승인 등록된 게이트 기기의 서명만 받는다 (시공사가 임의 키로 만든 기록은 거부)
    if not contract.functions.hasRole(GATE_DEVICE_ROLE, device).call():
        raise HTTPException(403, f"signer is not a registered gate device: {device}")

    canonical = _canonical(checkin)
    nonce = canonical["nonce"]
    now = int(time.time())
    with get_conn() as conn:
        same_seq = conn.execute(
            "SELECT nonce FROM records WHERE device = ? AND device_seq = ?", (device.lower(), checkin["deviceSeq"])
        ).fetchone()
        if same_seq and same_seq["nonce"] == nonce:
            return {"stored": True, "duplicate": True, "device": device, "deviceSeq": checkin["deviceSeq"]}
        if same_seq:
            # 원본은 그대로 두고 덮어쓰기 시도만 기록한다 (커밋한 뒤에 409를 돌려준다)
            conn.execute(
                "INSERT INTO conflicts (device, device_seq, nonce, checkin_json, received_at) VALUES (?, ?, ?, ?, ?)",
                (device.lower(), checkin["deviceSeq"], nonce, json.dumps(canonical), now),
            )
    if same_seq:
        raise HTTPException(409, "another record already uses this device sequence number")

    with get_conn() as conn:
        try:
            conn.execute(
                """INSERT INTO records (nonce, device, device_seq, site_id, checkin_json, signature, signed_at, received_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (nonce, device.lower(), checkin["deviceSeq"], canonical["siteId"], json.dumps(canonical),
                 _hex(signature), checkin["timestamp"], now),
            )
        except sqlite3.IntegrityError:
            raise HTTPException(409, "nonce already stored with a different sequence number")
    # 받은 직후 모의 실행: 이 시점에 체인이 이 기록을 받을 수 있었는지 남겨 둔다
    receipt = _dry_run(checkin, signature)
    with get_conn() as conn:
        conn.execute("UPDATE records SET receipt_check = ? WHERE nonce = ?", (receipt, nonce))
    return {"stored": True, "device": device, "deviceSeq": checkin["deviceSeq"], "receiptCheck": receipt}


# ======================================================================
# 감리 대시보드: 감사 저장소 원본 ↔ 체인 대조
# ======================================================================


def _chain_checkins(site_hash: bytes) -> list[dict]:
    total = contract.functions.getSiteStats(site_hash).call()[0]
    if total == 0:
        return []
    rows = contract.functions.getCheckIns(site_hash, max(0, total - 2000), total).call()
    names = [n for n, _ in CHECKIN_FIELDS]
    out = []
    for data, device, status, anchored_at, overridden, _reason, _by, _at in rows:
        d = dict(zip(names, data))
        out.append({
            "data": _canonical(d),
            "device": device.lower(),
            "status": ENTRY_STATUS[status],
            "anchoredAt": anchored_at,
            "overridden": overridden,
        })
    return out


def _public_view(checkin: dict) -> dict:
    # 개인 지목 없이 감리 판단에 필요한 값만
    return {
        "nonce": checkin["nonce"],
        "deviceSeq": checkin["deviceSeq"],
        "signedAt": checkin["timestamp"],
        "passed": checkin["helmetPass"] and checkin["shoesPass"] and checkin["alcoholPass"],
        "helmetPass": checkin["helmetPass"],
        "shoesPass": checkin["shoesPass"],
        "alcoholPass": checkin["alcoholPass"],
    }


def _contractor_nonces(site: str) -> set[str] | None:
    """시공사 DB에 남은 게이트 기록 nonce 목록. 시공사 백엔드에 닿지 않으면 None (대조 불가)."""
    import urllib.error
    import urllib.parse
    import urllib.request

    try:
        url = f"{CONTRACTOR_URL}/gate/records/{urllib.parse.quote(site)}"
        with urllib.request.urlopen(url, timeout=5) as res:
            return {r["nonce"] for r in json.loads(res.read())}
    except (urllib.error.URLError, TimeoutError, OSError, ValueError, KeyError):
        return None


def _emergencies(site_hash: bytes) -> list[dict]:
    rows = contract.functions.getEmergencyEntries(site_hash, 0, 1000).call()
    return [
        {"nonce": _hex(data[4]), "reason": EMERGENCY_REASONS.get(data[3]), "supervisor": sup, "approver": appr,
         "anchoredAt": at}
        for data, sup, appr, at in rows
    ]


@app.get("/summary/{site}")
def summary(site: str):
    site_hash = Web3.keccak(text=site)
    site_hex = _hex(site_hash)
    now = int(time.time())

    with get_conn() as conn:
        audit_rows = conn.execute(
            "SELECT * FROM records WHERE site_id = ? ORDER BY received_at DESC", (site_hex,)
        ).fetchall()
        conflict_rows = conn.execute("SELECT * FROM conflicts ORDER BY received_at DESC LIMIT 50").fetchall()

    chain_rows = _chain_checkins(site_hash)
    contractor = _contractor_nonces(site)
    chain_by_nonce = {c["data"]["nonce"]: c for c in chain_rows}
    chain_by_seq = {(c["device"], c["data"]["deviceSeq"]): c for c in chain_rows}

    records = []
    counts = {"anchored": 0, "pending": 0, "missing": 0, "replaced": 0, "mismatch": 0, "withheld": 0, "chainRejected": 0}
    audit_nonces = set()
    for r in audit_rows:
        original = json.loads(r["checkin_json"])
        audit_nonces.add(r["nonce"])
        onchain = chain_by_nonce.get(r["nonce"])
        if onchain:
            same = onchain["data"] == original and onchain["device"] == r["device"]
            status = "anchored" if same else "mismatch"
        elif (r["device"], r["device_seq"]) in chain_by_seq:
            status = "replaced"  # 같은 일련번호로 체인엔 다른 기록이 올라감
            onchain = chain_by_seq[(r["device"], r["device_seq"])]
        elif contract.functions.isNonceUsed(bytes.fromhex(r["nonce"][2:])).call():
            status = "mismatch"  # nonce가 다른 종류의 기록에 쓰임
        else:
            status = "pending" if now - r["received_at"] < GRACE_SECONDS else "missing"
        chain_check = None
        if status == "missing":
            missing_check = r["missing_check"]
            if missing_check is None:
                # 미제출로 처음 판정된 순간 체인에 직접 모의 실행하고 결과를 저장한다
                missing_check = _dry_run(_parse_checkin(original), bytes.fromhex(r["signature"][2:]))
                with get_conn() as conn:
                    conn.execute(
                        "UPDATE records SET missing_check = ?, missing_check_at = ? WHERE nonce = ?",
                        (missing_check, now, r["nonce"]),
                    )
            chain_check = _chain_check(r["receipt_check"], missing_check)
            counts["withheld" if chain_check["verdict"] == "withheld" else "chainRejected"] += 1
        counts[status] += 1
        records.append({
            **_public_view(original),
            "device": r["device"],
            "receivedAt": r["received_at"],
            "audit": status,
            "inContractorDb": None if contractor is None else r["nonce"] in contractor,
            "chainCheck": chain_check,
            "anchoredAt": onchain["anchoredAt"] if onchain and status == "anchored" else None,
            "entryStatus": onchain["status"] if onchain and status == "anchored" else None,
        })

    chain_only = [
        {**_public_view(c["data"]), "device": c["device"], "anchoredAt": c["anchoredAt"], "entryStatus": c["status"]}
        for c in chain_rows
        if c["data"]["nonce"] not in audit_nonces
    ]

    chain_nonces = set(chain_by_nonce)
    contractor_counts = None
    if contractor is not None:
        contractor_counts = {
            # 체인이 받을 수 있었는데 시공사 DB에도 체인에도 없음 = 시공사가 기록을 통째로 감춤
            # (체인이 거부한 기록은 시공사 DB에 없는 게 정상이라 세지 않는다)
            "hidden": sum(
                1 for r in records
                if r["inContractorDb"] is False and r["chainCheck"] and r["chainCheck"]["verdict"] == "withheld"
            ),
            # 시공사 DB에만 있음 (게이트 원본·체인 둘 다 없음)
            "contractorOnly": len(contractor - audit_nonces - chain_nonces),
            "total": len(contractor),
        }

    devices = []
    for addr in sorted({r["device"] for r in audit_rows} | {c["device"] for c in chain_rows}):
        highest, received = contract.functions.getDeviceStats(Web3.to_checksum_address(addr)).call()
        audit_seqs = [r["device_seq"] for r in audit_rows if r["device"] == addr]
        devices.append({
            "address": addr,
            "active": contract.functions.hasRole(GATE_DEVICE_ROLE, Web3.to_checksum_address(addr)).call(),
            "chainHighestSeq": highest,
            "chainReceived": received,
            "chainMissing": highest - received,  # 체인만 보고도 알 수 있는 누락 (번호 공백)
            "auditHighestSeq": max(audit_seqs) if audit_seqs else 0,
            "auditCount": len(audit_seqs),
        })

    revocations = [
        {
            "role": ROLE_NAMES.get(role, _hex(role)),
            "account": account,
            "reasonCode": reason,
            "reason": REVOKE_REASONS.get(reason),
            "revokedBy": by,
            "revokedAt": at,
            "lastSeq": last_seq,
            "missingAtRevoke": missing,
        }
        for role, account, reason, by, at, last_seq, missing in contract.functions.getRevocations().call()
    ]

    return {
        "site": site,
        "graceSeconds": GRACE_SECONDS,
        "counts": {**counts, "chainOnly": len(chain_only), "auditTotal": len(audit_rows), "chainTotal": len(chain_rows)},
        "contractor": contractor_counts,
        "emergencies": _emergencies(site_hash),
        "records": records[:200],
        "chainOnly": chain_only[:50],
        "devices": devices,
        "revocations": revocations,
        "conflicts": [
            {"device": c["device"], "deviceSeq": c["device_seq"], "nonce": c["nonce"], "receivedAt": c["received_at"]}
            for c in conflict_rows
        ],
    }


@app.get("/health")
def health():
    return {"ok": True, "contract": contract.address, "chainId": w3.eth.chain_id, "graceSeconds": GRACE_SECONDS}
