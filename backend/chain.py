"""web3 연동 + EIP-712 서명.

모든 기록은 "서명 + 릴레이" 방식이다.
- 서명: 게이트 기기 / 시공사 감독자 / 감리 / 발주처가 각자의 키로 EIP-712 서명만 한다.
- 릴레이: 백엔드 계정(SENDER_PRIVATE_KEY)이 가스를 내고 서명을 컨트랙트에 전달한다.
컨트랙트가 서명자를 복구해 역할(GATE_DEVICE / SUPERVISOR / INSPECTOR / OWNER)을 확인하므로,
릴레이가 내용을 바꾸면 서명이 깨져서 거부된다.

데모에서는 감리·발주처 키도 백엔드 .env에 있지만, 실제 서비스에서는 각 기관이 자기 키를 보관하고
서명값만 보내는 구조다 (컨트랙트 쪽 검증 로직은 그대로).
"""

import hashlib
import hmac
import json
import time
from pathlib import Path

from eth_account import Account
from eth_account.messages import encode_typed_data
from web3 import Web3

import config

ABI_PATH = Path(__file__).parent / "abi" / "SafetyGate.json"

w3 = Web3(Web3.HTTPProvider(config.RPC_URL))
contract = w3.eth.contract(
    address=Web3.to_checksum_address(config.CONTRACT_ADDRESS),
    abi=json.loads(ABI_PATH.read_text()),
)

_sender_account = Account.from_key(config.SENDER_PRIVATE_KEY)
_device_account = Account.from_key(config.DEVICE_PRIVATE_KEY)
DEVICE_ADDRESS = _device_account.address

# 시공사 현장 감독자(안전관리자). 로그인 없이 이름을 고르면 그 이름에 연결된 키로 서명한다.
_ADMIN_ACCOUNTS: dict[str, Account] = {name: Account.from_key(key) for name, key in config.ADMIN_SIGNERS.items()}
ADMIN_NAMES = list(_ADMIN_ACCOUNTS.keys())
ADMIN_ADDRESSES = {name: acc.address for name, acc in _ADMIN_ACCOUNTS.items()}

# 감리·발주처 (데모용으로 각 1명)
_INSPECTOR = {name: Account.from_key(key) for name, key in config.INSPECTOR_SIGNER.items()}
_OWNER = {name: Account.from_key(key) for name, key in config.OWNER_SIGNER.items()}

_NAME_BY_ADDRESS = {
    acc.address.lower(): name for group in (_ADMIN_ACCOUNTS, _INSPECTOR, _OWNER) for name, acc in group.items()
}
_NAME_BY_ADDRESS[DEVICE_ADDRESS.lower()] = "게이트 기기"


def name_for_address(address: str) -> str | None:
    return _NAME_BY_ADDRESS.get(address.lower())


# 이전 코드와의 호환용 별칭
admin_name_for_address = name_for_address


def reviewer_account(role: str) -> tuple[str, Account]:
    """role = "inspector" | "owner" → (이름, 계정)"""
    group = {"inspector": _INSPECTOR, "owner": _OWNER}.get(role)
    if not group:
        raise ValueError(f"unknown reviewer role or signer not configured: {role}")
    name, acc = next(iter(group.items()))
    return name, acc


def supervisor_account(name: str) -> Account:
    if name not in _ADMIN_ACCOUNTS:
        raise ValueError(f"unknown supervisor: {name}")
    return _ADMIN_ACCOUNTS[name]


# ----------------------------------------------------------------------
# EIP-712 타입 (컨트랙트의 TYPEHASH 문자열과 필드 순서가 정확히 같아야 한다)
# ----------------------------------------------------------------------

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
        {"name": "deviceSeq", "type": "uint64"},
        {"name": "timestamp", "type": "uint64"},
    ],
}

SITE_RECORD_TYPES = {
    "SiteRecord": [
        {"name": "caseId", "type": "bytes32"},
        {"name": "siteId", "type": "bytes32"},
        {"name": "recordHash", "type": "bytes32"},
        {"name": "hazardsControlled", "type": "bool"},
        {"name": "nonce", "type": "bytes32"},
        {"name": "timestamp", "type": "uint64"},
    ],
}

OVERRIDE_TYPES = {
    "Override": [
        {"name": "checkInNonce", "type": "bytes32"},
        {"name": "reasonCode", "type": "uint8"},
        {"name": "nonce", "type": "bytes32"},
        {"name": "timestamp", "type": "uint64"},
    ],
}

CASE_ACTION_TYPES = {
    "CaseAction": [
        {"name": "caseId", "type": "bytes32"},
        {"name": "scopeHash", "type": "bytes32"},
        {"name": "action", "type": "uint8"},
        {"name": "reasonCode", "type": "uint8"},
        {"name": "nonce", "type": "bytes32"},
        {"name": "timestamp", "type": "uint64"},
    ],
}

ACTION_SUBMIT, ACTION_APPROVE, ACTION_REJECT = 1, 2, 3
CASE_STATUS = ["None", "Submitted", "InspectorApproved", "Finalized", "Rejected"]
ACTION_NAMES = {1: "submit", 2: "approve", 3: "reject"}
# 컨트랙트 EntryStatus enum 순서와 같아야 한다
ENTRY_STATUS = ["Granted", "Denied", "HeldNoAssessment", "LateAuditOnly", "HeldHazardsOpen"]
ROLE_IDS = {
    "device": Web3.keccak(text="GATE_DEVICE_ROLE"),
    "supervisor": Web3.keccak(text="SUPERVISOR_ROLE"),
}
ROLE_NAMES = {v: k for k, v in ROLE_IDS.items()}


# ----------------------------------------------------------------------
# 해시 유틸
# ----------------------------------------------------------------------


def to_hex0x(b: bytes) -> str:
    return "0x" + b.hex()


def from_hex0x(s: str) -> bytes:
    return bytes.fromhex(s[2:] if s.startswith("0x") else s)


def worker_id_hash(worker_id_plain: str, site_id_plain: str, work_date: str) -> bytes:
    """날짜별 가명: workerId = HMAC-SHA256(비밀키, 사번|현장|작업일).

    같은 근로자라도 날짜가 바뀌면 값이 달라져서, 공개 체인에서 장기간 출근 패턴·불합격 이력이
    한 사람으로 이어지지 않는다. 비밀키는 DB가 아니라 .env(또는 별도 키 파일)에 있어서
    DB만 유출돼서는 역산할 수 없다. 사고 조사 때는 키를 가진 담당자만 다시 계산해 대조한다.
    """
    msg = f"{worker_id_plain}|{site_id_plain}|{work_date}".encode()
    return hmac.new(config.WORKER_PSEUDONYM_KEY, msg, hashlib.sha256).digest()


def site_id_hash(site_id_plain: str) -> bytes:
    return Web3.keccak(text=site_id_plain)


def case_id_hash(site_id_plain: str, work_date: str) -> bytes:
    """caseId = keccak256(현장ID|작업일자). 같은 현장·같은 날의 기록을 묶는 값."""
    return Web3.keccak(text=f"{site_id_plain}|{work_date}")


def hash_text(s: str) -> bytes:
    return Web3.keccak(text=s)


def evidence_hash(image_bytes: bytes) -> bytes:
    """검사 사진 원본의 SHA-256. 원본은 오프체인, 이 해시만 온체인."""
    return hashlib.sha256(image_bytes).digest()


# ----------------------------------------------------------------------
# 서명 / 릴레이 공통
# ----------------------------------------------------------------------


def _domain():
    return {
        "name": "SafetyChain",
        "version": "1",
        "chainId": w3.eth.chain_id,
        "verifyingContract": contract.address,
    }


def _sign(types: dict, message: dict, account) -> bytes:
    typed = encode_typed_data(domain_data=_domain(), message_types=types, message_data=message)
    return account.sign_message(typed).signature


def recover(types: dict, message: dict, signature: bytes) -> str:
    typed = encode_typed_data(domain_data=_domain(), message_types=types, message_data=dict(message))
    return Account.recover_message(typed, signature=signature)


class OnchainRejected(Exception):
    pass


def _error_selectors() -> dict[str, str]:
    out = {}
    for item in contract.abi:
        if item.get("type") == "error":
            sig = f"{item['name']}({','.join(i['type'] for i in item['inputs'])})"
            out["0x" + Web3.keccak(text=sig)[:4].hex().removeprefix("0x")] = item["name"]
    return out


_ERRORS = _error_selectors()


def describe_error(e: Exception) -> str:
    """컨트랙트 revert 데이터(0x1917ee8a...)를 사람이 읽을 수 있는 에러 이름으로 바꾼다."""
    text = str(e)
    for selector, name in _ERRORS.items():
        if selector in text:
            return name
    return text


def _send(fn) -> str:
    """릴레이 계정으로 트랜잭션을 보내고, 블록에 포함될 때까지 기다린다.
    게이트는 이 함수가 성공(=온체인 확정)한 뒤에만 결과를 돌려준다 (Gatekeeper)."""
    # 가스 추정은 'pending' 블록 기준으로 한다. 'latest' 기준이면 블록이 한동안 안 생긴 로컬 체인(Anvil)에서
    # 마지막 블록 시각으로 시간 검증이 돌아가, 방금 서명한 기록이 '미래 시각(StaleTimestamp)'으로 잘못 거부된다.
    gas = fn.estimate_gas({"from": _sender_account.address}, block_identifier="pending")
    tx = fn.build_transaction(
        {
            "from": _sender_account.address,
            "nonce": w3.eth.get_transaction_count(_sender_account.address),
            "gas": int(gas * 1.2),  # 테스트넷 업그레이드 후 추정 오차 대비 여유분
        }
    )
    signed_tx = _sender_account.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed_tx.raw_transaction)
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash)
    if receipt.status != 1:
        raise OnchainRejected(f"transaction reverted: {to_hex0x(tx_hash)}")
    return to_hex0x(tx_hash)


def _now() -> int:
    return int(time.time())


# ----------------------------------------------------------------------
# 출입 검사 (게이트 기기)
# ----------------------------------------------------------------------


def build_and_sign_checkin(
    case_id: bytes,
    worker_id: bytes,
    site_id: bytes,
    helmet_pass: bool,
    shoes_pass: bool,
    alcohol_pass: bool,
    model_hash: bytes,
    evidence: bytes,
    nonce: bytes,
    device_seq: int,
    signed_at: int | None = None,
) -> dict:
    """게이트 기기 키로 서명. device_seq는 기기가 매기는 일련번호(빠진 번호 = 누락)."""
    checkin = {
        "caseId": case_id,
        "workerId": worker_id,
        "siteId": site_id,
        "helmetPass": helmet_pass,
        "shoesPass": shoes_pass,
        "alcoholPass": alcohol_pass,
        "modelHash": model_hash,
        "evidenceHash": evidence,
        "nonce": nonce,
        "deviceSeq": device_seq,
        "timestamp": signed_at if signed_at is not None else _now(),
    }
    return {"checkin": checkin, "signature": _sign(CHECKIN_TYPES, checkin, _device_account)}


def submit_checkin(checkin: dict, signature: bytes) -> str:
    fields = [f["name"] for f in CHECKIN_TYPES["CheckIn"]]
    return _send(contract.functions.submitCheckIn(tuple(checkin[k] for k in fields), signature))


# ----------------------------------------------------------------------
# Manual Override (감독자)
# ----------------------------------------------------------------------


def build_and_sign_override(check_in_nonce: bytes, reason_code: int, nonce: bytes, supervisor_name: str) -> dict:
    account = supervisor_account(supervisor_name)
    message = {"checkInNonce": check_in_nonce, "reasonCode": reason_code, "nonce": nonce, "timestamp": _now()}
    return {
        "override": message,
        "signature": _sign(OVERRIDE_TYPES, message, account),
        "signerAddress": account.address,
    }


def submit_override(message: dict, signature: bytes) -> str:
    fields = [f["name"] for f in OVERRIDE_TYPES["Override"]]
    return _send(contract.functions.submitOverride(tuple(message[k] for k in fields), signature))


# ----------------------------------------------------------------------
# 위험성평가 (감독자)
# ----------------------------------------------------------------------


def build_and_sign_site_record(
    case_id: bytes, site_id: bytes, record_hash: bytes, hazards_controlled: bool, nonce: bytes, admin_name: str
) -> dict:
    account = supervisor_account(admin_name)
    record = {
        "caseId": case_id,
        "siteId": site_id,
        "recordHash": record_hash,
        "hazardsControlled": hazards_controlled,
        "nonce": nonce,
        "timestamp": _now(),
    }
    return {"record": record, "signature": _sign(SITE_RECORD_TYPES, record, account), "signerAddress": account.address}


def submit_site_record(record: dict, signature: bytes) -> str:
    fields = [f["name"] for f in SITE_RECORD_TYPES["SiteRecord"]]
    return _send(contract.functions.submitSiteRecord(tuple(record[k] for k in fields), signature))


# ----------------------------------------------------------------------
# Case 확정 (감독자 제출 → 감리 → 발주처)
# ----------------------------------------------------------------------


def build_and_sign_case_action(
    case_id: bytes, scope_hash: bytes, action: int, reason_code: int, nonce: bytes, account
) -> dict:
    message = {
        "caseId": case_id,
        "scopeHash": scope_hash,
        "action": action,
        "reasonCode": reason_code,
        "nonce": nonce,
        "timestamp": _now(),
    }
    return {
        "action": message,
        "signature": _sign(CASE_ACTION_TYPES, message, account),
        "signerAddress": account.address,
    }


def submit_case_action(message: dict, signature: bytes) -> str:
    fields = [f["name"] for f in CASE_ACTION_TYPES["CaseAction"]]
    return _send(contract.functions.submitCaseAction(tuple(message[k] for k in fields), signature))


# ----------------------------------------------------------------------
# 온체인 조회 (검증은 항상 이 값을 기준으로 한다)
# ----------------------------------------------------------------------


def is_nonce_used(nonce: bytes) -> bool:
    return contract.functions.isNonceUsed(nonce).call()


def get_onchain_checkin(nonce: bytes) -> dict | None:
    if not is_nonce_used(nonce):
        return None
    try:
        data, device, status, anchored_at, overridden, reason, overridden_by, overridden_at = (
            contract.functions.getCheckIn(nonce).call()
        )
    except Exception:
        return None  # nonce는 쓰였지만 다른 종류의 기록
    fields = [f["name"] for f in CHECKIN_TYPES["CheckIn"]]
    return {
        "data": dict(zip(fields, data)),
        "device": device,
        "status": ENTRY_STATUS[status],
        "anchoredAt": anchored_at,
        "overridden": overridden,
        "overrideReason": reason,
        "overriddenBy": overridden_by,
        "overriddenAt": overridden_at,
    }


def get_onchain_site_record(nonce: bytes) -> dict | None:
    data, supervisor, anchored_at = contract.functions.getSiteRecord(nonce).call()
    if anchored_at == 0:
        return None
    fields = [f["name"] for f in SITE_RECORD_TYPES["SiteRecord"]]
    return {"data": dict(zip(fields, data)), "supervisor": supervisor, "anchoredAt": anchored_at}


def get_site_stats(site_id_plain: str) -> dict:
    checkins, failed, overrides, held, late = contract.functions.getSiteStats(site_id_hash(site_id_plain)).call()
    return {"checkIns": checkins, "failed": failed, "overrides": overrides, "held": held, "late": late}


def is_entry_allowed(nonce: bytes) -> bool:
    return contract.functions.isEntryAllowed(nonce).call()


def get_assessment(case_id: bytes) -> dict:
    site_id, controlled, record_nonce, anchored_at = contract.functions.getAssessment(case_id).call()
    return {
        "exists": anchored_at != 0,
        "hazardsControlled": controlled,
        "recordNonce": to_hex0x(record_nonce),
        "anchoredAt": anchored_at,
    }


def get_device_stats(address: str) -> dict:
    highest, received = contract.functions.getDeviceStats(Web3.to_checksum_address(address)).call()
    return {"highestSeq": highest, "received": received, "missing": highest - received}


def get_revocations() -> list[dict]:
    return [
        {
            "role": ROLE_NAMES.get(role, to_hex0x(role)),
            "account": account,
            "accountName": name_for_address(account) or account,
            "reasonCode": reason,
            "revokedBy": by,
            "revokedAt": at,
            "lastSeq": last_seq,
            "missingAtRevoke": missing,
        }
        for role, account, reason, by, at, last_seq, missing in contract.functions.getRevocations().call()
    ]


def has_role(role: str, address: str) -> bool:
    return contract.functions.hasRole(ROLE_IDS[role], Web3.to_checksum_address(address)).call()


# ----------------------------------------------------------------------
# 서명자 해제·등록 (시공사 운영 관리자 = 릴레이 계정)
# ----------------------------------------------------------------------


def revoke_signer(role: str, address: str, reason_code: int) -> str:
    """시공사가 즉시 해제한다. 사유 코드와 해제 시점 일련번호가 체인에 이력으로 남는다."""
    return _send(contract.functions.revokeSigner(ROLE_IDS[role], Web3.to_checksum_address(address), reason_code))


def register_signer(role: str, address: str) -> str:
    """시공사 제안 + 감리 승인 서명. 데모에서만 백엔드가 감리 키로 승인 서명까지 한다."""
    account = Web3.to_checksum_address(address)
    _send(contract.functions.proposeSigner(ROLE_IDS[role], account))
    proposal_id = contract.functions.proposalCount().call() - 1
    digest = contract.functions.signerApprovalDigest(proposal_id).call()
    _, inspector = reviewer_account("inspector")
    sig = inspector.unsafe_sign_hash(digest).signature
    return _send(contract.functions.approveSigner(proposal_id, sig))


def get_case_state(case_id: bytes) -> dict:
    status, scope_hash, round_ = contract.functions.getCase(case_id).call()
    return {"status": CASE_STATUS[status], "scopeHash": to_hex0x(scope_hash), "round": round_}


def get_case_history(case_id: bytes) -> list[dict]:
    entries = contract.functions.getCaseHistory(case_id).call()
    return [
        {
            "action": ACTION_NAMES.get(action, str(action)),
            "reasonCode": reason,
            "scopeHash": to_hex0x(scope),
            "actor": actor,
            "actorName": name_for_address(actor) or actor,
            "nonce": to_hex0x(nonce),
            "anchoredAt": anchored_at,
        }
        for action, reason, scope, actor, _role, nonce, anchored_at in entries
    ]


def list_site_checkins(site_id_plain: str, limit: int = 500) -> list[dict]:
    # 대시보드 일별 집계용. 최근 limit건만 온체인에서 읽는다
    total = get_site_stats(site_id_plain)["checkIns"]
    if total == 0:
        return []
    rows = contract.functions.getCheckIns(site_id_hash(site_id_plain), max(0, total - limit), total).call()
    fields = [f["name"] for f in CHECKIN_TYPES["CheckIn"]]
    return [
        {
            "data": dict(zip(fields, data)),
            "status": ENTRY_STATUS[status],
            "anchoredAt": anchored_at,
            "overridden": overridden,
        }
        for data, _device, status, anchored_at, overridden, _reason, _by, _at in rows
    ]
