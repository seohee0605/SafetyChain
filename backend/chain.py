"""web3 연동 + EIP-712 서명.

게이트 기기(DEVICE_PRIVATE_KEY)가 검사 결과에 서명하고, 백엔드(SENDER_PRIVATE_KEY)가
가스를 내며 그 서명을 온체인에 릴레이한다. 두 키가 분리돼 있는 이유: 실제로는 기기가
자기 개인키로 서명한 결과만 백엔드로 보내고, 백엔드는 그걸 검증 없이 그대로 전달만 해도
컨트랙트가 서명자를 복구해 등록된 기기인지 확인하므로 안전하다.
"""
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

# 안전관리자별로 미리 등록된 서명 키. 로그인/비밀번호 없이, 자기 이름만 골라서
# 그 이름에 연결된 키로 서명한다 (기기 등록 패턴을 사람 단위로 확장한 것).
_ADMIN_ACCOUNTS: dict[str, Account] = {
    name: Account.from_key(key) for name, key in config.ADMIN_SIGNERS.items()
}
ADMIN_NAMES = list(_ADMIN_ACCOUNTS.keys())
ADMIN_ADDRESSES = {name: acc.address for name, acc in _ADMIN_ACCOUNTS.items()}
_ADMIN_NAME_BY_ADDRESS = {acc.address.lower(): name for name, acc in _ADMIN_ACCOUNTS.items()}


def admin_name_for_address(address: str) -> str | None:
    return _ADMIN_NAME_BY_ADDRESS.get(address.lower())


EIP712_TYPES = {
    "CheckIn": [
        {"name": "caseId", "type": "bytes32"},
        {"name": "workerId", "type": "bytes32"},
        {"name": "siteId", "type": "bytes32"},
        {"name": "helmetPass", "type": "bool"},
        {"name": "shoesPass", "type": "bool"},
        {"name": "alcoholPass", "type": "bool"},
        {"name": "modelHash", "type": "bytes32"},
        {"name": "nonce", "type": "bytes32"},
        {"name": "timestamp", "type": "uint64"},
    ],
}

SITE_RECORD_EIP712_TYPES = {
    "SiteRecord": [
        {"name": "caseId", "type": "bytes32"},
        {"name": "siteId", "type": "bytes32"},
        {"name": "recordHash", "type": "bytes32"},
        {"name": "hazardsControlled", "type": "bool"},
        {"name": "nonce", "type": "bytes32"},
        {"name": "timestamp", "type": "uint64"},
    ],
}

CASE_REVIEW_EIP712_TYPES = {
    "CaseReview": [
        {"name": "caseId", "type": "bytes32"},
        {"name": "reviewScopeHash", "type": "bytes32"},
        {"name": "reviewResult", "type": "bool"},
        {"name": "nonce", "type": "bytes32"},
        {"name": "timestamp", "type": "uint64"},
    ],
}


def to_hex0x(b: bytes) -> str:
    return "0x" + b.hex()


def from_hex0x(s: str) -> bytes:
    return bytes.fromhex(s[2:] if s.startswith("0x") else s)


def worker_id_hash(worker_id_plain: str, site_salt: str) -> bytes:
    """workerId = keccak256(사번 || siteSalt). 실명은 절대 여기 들어가지 않는다."""
    return Web3.keccak(text=worker_id_plain + site_salt)


def site_id_hash(site_id_plain: str) -> bytes:
    return Web3.keccak(text=site_id_plain)


def case_id_hash(site_id_plain: str, work_date: str) -> bytes:
    """caseId = keccak256(현장ID + 작업일자). 같은 현장·같은 날의 위험성평가·검사를 묶는 값."""
    return Web3.keccak(text=f"{site_id_plain}|{work_date}")


def hash_text(s: str) -> bytes:
    return Web3.keccak(text=s)


def _domain():
    return {
        "name": "SafetyChain",
        "version": "1",
        "chainId": w3.eth.chain_id,
        "verifyingContract": contract.address,
    }


def build_and_sign_checkin(
    case_id: bytes,
    worker_id: bytes,
    site_id: bytes,
    helmet_pass: bool,
    shoes_pass: bool,
    alcohol_pass: bool,
    model_hash: bytes,
    nonce: bytes,
) -> dict:
    """게이트 기기 키로 CheckIn에 서명한다. 반환값에 서명과 struct 원본을 함께 담는다."""
    checkin = {
        "caseId": case_id,
        "workerId": worker_id,
        "siteId": site_id,
        "helmetPass": helmet_pass,
        "shoesPass": shoes_pass,
        "alcoholPass": alcohol_pass,
        "modelHash": model_hash,
        "nonce": nonce,
        "timestamp": int(time.time()),
    }
    typed_data = encode_typed_data(
        domain_data=_domain(),
        message_types=EIP712_TYPES,
        message_data=checkin,
    )
    signed = _device_account.sign_message(typed_data)
    return {"checkin": checkin, "signature": signed.signature}


def submit_checkin(checkin: dict, signature: bytes) -> str:
    """서명된 CheckIn을 릴레이해서 온체인에 제출. tx hash를 반환."""
    checkin_tuple = (
        checkin["caseId"],
        checkin["workerId"],
        checkin["siteId"],
        checkin["helmetPass"],
        checkin["shoesPass"],
        checkin["alcoholPass"],
        checkin["modelHash"],
        checkin["nonce"],
        checkin["timestamp"],
    )
    tx = contract.functions.submitCheckIn(checkin_tuple, signature).build_transaction(
        {
            "from": _sender_account.address,
            "nonce": w3.eth.get_transaction_count(_sender_account.address),
        }
    )
    signed_tx = _sender_account.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed_tx.raw_transaction)
    w3.eth.wait_for_transaction_receipt(tx_hash)
    return to_hex0x(tx_hash)


def is_nonce_used(nonce: bytes) -> bool:
    return contract.functions.isNonceUsed(nonce).call()


def recover_signer(checkin: dict, signature: bytes) -> str:
    """서명이 어떤 주소에서 나왔는지 복구 (verify 엔드포인트용)."""
    checkin_for_typed_data = dict(checkin)
    typed_data = encode_typed_data(
        domain_data=_domain(),
        message_types=EIP712_TYPES,
        message_data=checkin_for_typed_data,
    )
    return Account.recover_message(typed_data, signature=signature)


def build_and_sign_site_record(
    case_id: bytes, site_id: bytes, record_hash: bytes, hazards_controlled: bool, nonce: bytes, admin_name: str
) -> dict:
    """지정된 안전관리자의 키로 일일 위험성평가 기록에 서명한다."""
    if admin_name not in _ADMIN_ACCOUNTS:
        raise ValueError(f"unknown admin: {admin_name}")
    signer_account = _ADMIN_ACCOUNTS[admin_name]

    record = {
        "caseId": case_id,
        "siteId": site_id,
        "recordHash": record_hash,
        "hazardsControlled": hazards_controlled,
        "nonce": nonce,
        "timestamp": int(time.time()),
    }
    typed_data = encode_typed_data(
        domain_data=_domain(),
        message_types=SITE_RECORD_EIP712_TYPES,
        message_data=record,
    )
    signed = signer_account.sign_message(typed_data)
    return {"record": record, "signature": signed.signature, "signerAddress": signer_account.address}


def submit_site_record(record: dict, signature: bytes) -> str:
    record_tuple = (
        record["caseId"],
        record["siteId"],
        record["recordHash"],
        record["hazardsControlled"],
        record["nonce"],
        record["timestamp"],
    )
    tx = contract.functions.submitSiteRecord(record_tuple, signature).build_transaction(
        {
            "from": _sender_account.address,
            "nonce": w3.eth.get_transaction_count(_sender_account.address),
        }
    )
    signed_tx = _sender_account.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed_tx.raw_transaction)
    w3.eth.wait_for_transaction_receipt(tx_hash)
    return to_hex0x(tx_hash)


def recover_site_record_signer(record: dict, signature: bytes) -> str:
    typed_data = encode_typed_data(
        domain_data=_domain(),
        message_types=SITE_RECORD_EIP712_TYPES,
        message_data=dict(record),
    )
    return Account.recover_message(typed_data, signature=signature)


def build_and_sign_case_review(
    case_id: bytes, review_scope_hash: bytes, review_result: bool, nonce: bytes, admin_name: str
) -> dict:
    """감독자(안전관리자)의 최종 검토 서명. review_scope_hash가 검토한 기록 범위를 고정한다."""
    if admin_name not in _ADMIN_ACCOUNTS:
        raise ValueError(f"unknown admin: {admin_name}")
    signer_account = _ADMIN_ACCOUNTS[admin_name]

    review = {
        "caseId": case_id,
        "reviewScopeHash": review_scope_hash,
        "reviewResult": review_result,
        "nonce": nonce,
        "timestamp": int(time.time()),
    }
    typed_data = encode_typed_data(
        domain_data=_domain(),
        message_types=CASE_REVIEW_EIP712_TYPES,
        message_data=review,
    )
    signed = signer_account.sign_message(typed_data)
    return {"review": review, "signature": signed.signature, "signerAddress": signer_account.address}


def submit_case_review(review: dict, signature: bytes) -> str:
    review_tuple = (
        review["caseId"],
        review["reviewScopeHash"],
        review["reviewResult"],
        review["nonce"],
        review["timestamp"],
    )
    tx = contract.functions.submitCaseReview(review_tuple, signature).build_transaction(
        {
            "from": _sender_account.address,
            "nonce": w3.eth.get_transaction_count(_sender_account.address),
        }
    )
    signed_tx = _sender_account.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed_tx.raw_transaction)
    w3.eth.wait_for_transaction_receipt(tx_hash)
    return to_hex0x(tx_hash)


def recover_case_review_signer(review: dict, signature: bytes) -> str:
    typed_data = encode_typed_data(
        domain_data=_domain(),
        message_types=CASE_REVIEW_EIP712_TYPES,
        message_data=dict(review),
    )
    return Account.recover_message(typed_data, signature=signature)
