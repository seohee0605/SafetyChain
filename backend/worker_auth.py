"""근로자 본인 확인: 패스키(WebAuthn).

근로자 키는 근로자 폰의 패스키 저장소(아이폰은 보안칩으로 보호되는 iCloud 키체인)에 만들어지고,
브라우저도 서버도 개인키를 꺼낼 수 없다. 서명할 때마다 Face ID·지문 확인(UV)이 필요하다.
서버는 공개키만 보관하고, 로그인할 때마다 새 챌린지에 대한 서명을 검증해 짧은 세션 토큰을 준다.

등록 흐름 (자격 대여·남의 사번 도용 방지):
  1. 감독자가 현장 등록 때 대면 확인 후 일회용 초대 코드 발급 (/worker/invite)
  2. 근로자 폰에서 사번 + 초대 코드 → 패스키 생성 → 공개키 등록 (/worker/register/*). 초대 코드는 한 번 쓰면 소멸
  3. 이후 로그인 = 패스키 서명 (/worker/login/*) → 세션 토큰 (X-Worker-Token)
  4. 동의·QR 발급·내 기록 조회는 그 토큰의 사번·현장으로만 동작

검증 범위: attestation은 "none"으로 받는다 (기기 제조사 증명은 보지 않음). 등록의 신뢰 근거는
감독자가 대면 확인 후 발급한 초대 코드다. 공개키는 브라우저의 getPublicKey()(SPKI DER)로 받아 CBOR 파싱 없이 처리한다.
새 라이브러리 없이 pycryptodome(이미 사진 암호화에 사용)과 표준 라이브러리만 쓴다.
"""

import base64
import hashlib
import json
import os
import secrets
import time
from urllib.parse import urlparse

from Crypto.Hash import SHA256
from Crypto.PublicKey import ECC
from Crypto.Signature import DSS

import db

INVITE_TTL = 24 * 3600  # 초대 코드 유효기간
CHALLENGE_TTL = 300  # 등록·로그인 챌린지 유효기간
SESSION_TTL = 30 * 60  # 로그인 세션 유효기간

# required(기본): 동의·QR 발급·내 기록 조회에 근로자 로그인이 필요하다.
# off: 예전 방식(사번만으로 동작). 화면을 새 방식으로 바꾸기 전 전환용으로만 쓴다.
WORKER_AUTH = os.environ.get("WORKER_AUTH", "required").strip().lower()

# 패스키를 쓸 수 있는 근로자 앱 주소. 브라우저는 https 또는 localhost에서만 패스키를 허용한다.
# "https://*.trycloudflare.com"처럼 하위 도메인 와일드카드를 쓸 수 있다 (임시 터널 주소가 매번 바뀌므로).
WORKER_ORIGINS = [
    o.strip().rstrip("/")
    for o in os.environ.get("WORKER_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")
    if o.strip()
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS worker_invites (
    code_hash TEXT PRIMARY KEY,
    worker_id TEXT NOT NULL,
    site_id TEXT NOT NULL,
    issued_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
);
CREATE TABLE IF NOT EXISTS worker_credentials (
    worker_id TEXT NOT NULL,
    site_id TEXT NOT NULL,
    credential_id TEXT NOT NULL,
    public_key TEXT NOT NULL,
    sign_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (worker_id, site_id)
);
CREATE TABLE IF NOT EXISTS worker_challenges (
    challenge TEXT PRIMARY KEY,
    purpose TEXT NOT NULL,
    worker_id TEXT NOT NULL,
    site_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS worker_sessions (
    token_hash TEXT PRIMARY KEY,
    worker_id TEXT NOT NULL,
    site_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
"""


class AuthError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def init() -> None:
    with db.get_conn() as conn:
        conn.executescript(SCHEMA)


# ----------------------------------------------------------------------
# 인코딩 헬퍼
# ----------------------------------------------------------------------


def b64url_decode(s: str) -> bytes:
    try:
        return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
    except (ValueError, TypeError) as e:
        raise AuthError(400, f"invalid base64url: {e}") from e


def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def user_handle(worker_id: str, site_id: str) -> str:
    # 패스키의 user.id. 사번을 그대로 넣지 않고 해시한다 (기기·동기화 저장소에 사번이 남지 않게)
    return b64url(hashlib.sha256(f"{site_id}|{worker_id}".encode()).digest()[:16])


# ----------------------------------------------------------------------
# 초대 코드 (감독자 대면 확인 → 발급)
# ----------------------------------------------------------------------


def issue_invite(worker_id: str, site_id: str, issued_by: str) -> dict:
    code = "-".join(secrets.token_hex(2).upper() for _ in range(3))  # 예: 1A2B-3C4D-5E6F
    now = int(time.time())
    with db.get_conn() as conn:
        conn.execute(
            "INSERT INTO worker_invites (code_hash, worker_id, site_id, issued_by, created_at, expires_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (_sha(code), worker_id, site_id, issued_by, now, now + INVITE_TTL),
        )
    return {"code": code, "expiresAt": now + INVITE_TTL}


def _check_invite(code: str, worker_id: str, site_id: str):
    with db.get_conn() as conn:
        row = conn.execute("SELECT * FROM worker_invites WHERE code_hash = ?", (_sha(code.strip().upper()),)).fetchone()
    if row is None or row["worker_id"] != worker_id or row["site_id"] != site_id:
        raise AuthError(403, "invalid invite code")
    if row["used_at"] is not None:
        raise AuthError(403, "invite code already used")
    if row["expires_at"] < int(time.time()):
        raise AuthError(403, "invite code expired")
    return row


# ----------------------------------------------------------------------
# 챌린지
# ----------------------------------------------------------------------


def new_challenge(purpose: str, worker_id: str, site_id: str) -> str:
    challenge = b64url(secrets.token_bytes(32))
    with db.get_conn() as conn:
        conn.execute(
            "INSERT INTO worker_challenges (challenge, purpose, worker_id, site_id, created_at) VALUES (?, ?, ?, ?, ?)",
            (challenge, purpose, worker_id, site_id, int(time.time())),
        )
    return challenge


def _consume_challenge(challenge: str, purpose: str, worker_id: str, site_id: str) -> None:
    with db.get_conn() as conn:
        row = conn.execute("SELECT * FROM worker_challenges WHERE challenge = ?", (challenge,)).fetchone()
        if (row is None or row["purpose"] != purpose or row["worker_id"] != worker_id
                or row["site_id"] != site_id):
            raise AuthError(403, "unknown challenge")
        if row["used"]:
            raise AuthError(403, "challenge already used")
        if row["created_at"] + CHALLENGE_TTL < int(time.time()):
            raise AuthError(403, "challenge expired")
        conn.execute("UPDATE worker_challenges SET used = 1 WHERE challenge = ?", (challenge,))


# ----------------------------------------------------------------------
# WebAuthn 공통 검증
# ----------------------------------------------------------------------


def _origin_allowed(origin: str) -> bool:
    for allowed in WORKER_ORIGINS:
        if allowed == origin:
            return True
        if "://*." in allowed:
            scheme, suffix = allowed.split("://*.", 1)
            o = urlparse(origin)
            if o.scheme == scheme and o.hostname and o.hostname.endswith("." + suffix) and not o.port:
                return True
    return False


def _check_client_data(client_data_json: bytes, expected_type: str, purpose: str, worker_id: str, site_id: str) -> str:
    """clientDataJSON을 확인하고 rpId(= 출처의 호스트 이름)를 돌려준다."""
    try:
        cd = json.loads(client_data_json)
    except ValueError as e:
        raise AuthError(400, "invalid clientDataJSON") from e
    if cd.get("type") != expected_type:
        raise AuthError(403, f"clientData type must be {expected_type}")
    origin = str(cd.get("origin", "")).rstrip("/")
    if not _origin_allowed(origin):
        raise AuthError(403, f"origin not allowed: {origin}")
    _consume_challenge(str(cd.get("challenge", "")), purpose, worker_id, site_id)
    return urlparse(origin).hostname or ""


def _check_authenticator_data(auth_data: bytes, rp_id: str) -> int:
    """rpIdHash와 플래그(사용자 존재 UP + 본인 확인 UV)를 확인하고 서명 카운터를 돌려준다."""
    if len(auth_data) < 37:
        raise AuthError(400, "authenticatorData too short")
    if auth_data[:32] != hashlib.sha256(rp_id.encode()).digest():
        raise AuthError(403, "rpIdHash mismatch")
    flags = auth_data[32]
    if not flags & 0x01:
        raise AuthError(403, "user presence (UP) flag missing")
    if not flags & 0x04:
        raise AuthError(403, "user verification (UV) required: Face ID·지문 확인이 필요하다")
    return int.from_bytes(auth_data[33:37], "big")


# ----------------------------------------------------------------------
# 등록
# ----------------------------------------------------------------------


def register_options(worker_id: str, site_id: str, invite_code: str) -> dict:
    _check_invite(invite_code, worker_id, site_id)
    return {
        "challenge": new_challenge("register", worker_id, site_id),
        "userId": user_handle(worker_id, site_id),
        "userName": f"{worker_id}@{site_id}",
        "rpName": "SafetyChain 근로자",
        "timeout": CHALLENGE_TTL * 1000,
    }


def register(worker_id: str, site_id: str, invite_code: str, credential_id: str, public_key: str,
             client_data_json: str, authenticator_data: str) -> dict:
    invite = _check_invite(invite_code, worker_id, site_id)
    rp_id = _check_client_data(b64url_decode(client_data_json), "webauthn.create", "register", worker_id, site_id)
    sign_count = _check_authenticator_data(b64url_decode(authenticator_data), rp_id)
    try:
        key = ECC.import_key(b64url_decode(public_key))
    except (ValueError, IndexError, TypeError) as e:
        raise AuthError(400, f"invalid public key: {e}") from e
    if key.curve not in ("NIST P-256", "p256", "P-256", "prime256v1", "secp256r1"):
        raise AuthError(400, f"unsupported key curve: {key.curve} (ES256 / P-256만 받는다)")
    if not credential_id or len(b64url_decode(credential_id)) < 16:
        raise AuthError(400, "invalid credential id")
    now = int(time.time())
    with db.get_conn() as conn:
        # 폰을 바꾸면 새 초대 코드로 다시 등록한다 (이전 패스키는 무효)
        conn.execute(
            "INSERT INTO worker_credentials (worker_id, site_id, credential_id, public_key, sign_count, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(worker_id, site_id) DO UPDATE SET "
            "credential_id = excluded.credential_id, public_key = excluded.public_key, "
            "sign_count = excluded.sign_count, created_at = excluded.created_at",
            (worker_id, site_id, credential_id, public_key, sign_count, now),
        )
        conn.execute("UPDATE worker_invites SET used_at = ? WHERE code_hash = ?", (now, invite["code_hash"]))
        conn.execute("DELETE FROM worker_sessions WHERE worker_id = ? AND site_id = ?", (worker_id, site_id))
    return {"registered": True, "credentialId": credential_id}


# ----------------------------------------------------------------------
# 로그인
# ----------------------------------------------------------------------


def _credential(worker_id: str, site_id: str):
    with db.get_conn() as conn:
        return conn.execute(
            "SELECT * FROM worker_credentials WHERE worker_id = ? AND site_id = ?", (worker_id, site_id)
        ).fetchone()


def login_options(worker_id: str, site_id: str) -> dict:
    cred = _credential(worker_id, site_id)
    if cred is None:
        raise AuthError(404, "not registered: 감독자에게 초대 코드를 받아 먼저 등록한다")
    return {
        "challenge": new_challenge("login", worker_id, site_id),
        "credentialIds": [cred["credential_id"]],
        "timeout": CHALLENGE_TTL * 1000,
    }


def login(worker_id: str, site_id: str, credential_id: str, client_data_json: str, authenticator_data: str,
          signature: str) -> dict:
    cred = _credential(worker_id, site_id)
    if cred is None:
        raise AuthError(404, "not registered")
    if credential_id != cred["credential_id"]:
        raise AuthError(403, "unknown credential")
    cdj = b64url_decode(client_data_json)
    auth_data = b64url_decode(authenticator_data)
    rp_id = _check_client_data(cdj, "webauthn.get", "login", worker_id, site_id)
    sign_count = _check_authenticator_data(auth_data, rp_id)
    # 서명 대상 = authenticatorData || SHA-256(clientDataJSON), ES256(DER)
    key = ECC.import_key(b64url_decode(cred["public_key"]))
    digest = SHA256.new(auth_data + hashlib.sha256(cdj).digest())
    try:
        DSS.new(key, "fips-186-3", encoding="der").verify(digest, b64url_decode(signature))
    except ValueError as e:
        raise AuthError(403, "signature verification failed") from e
    # 서명 카운터: 동기화되는 패스키(아이폰 등)는 항상 0이다. 0이 아닐 때만 되감김을 막는다
    if sign_count and sign_count <= cred["sign_count"]:
        raise AuthError(403, "signature counter did not increase (cloned authenticator?)")
    token = secrets.token_urlsafe(32)
    expires = int(time.time()) + SESSION_TTL
    with db.get_conn() as conn:
        conn.execute(
            "UPDATE worker_credentials SET sign_count = ? WHERE worker_id = ? AND site_id = ?",
            (sign_count, worker_id, site_id),
        )
        conn.execute(
            "INSERT INTO worker_sessions (token_hash, worker_id, site_id, expires_at) VALUES (?, ?, ?, ?)",
            (_sha(token), worker_id, site_id, expires),
        )
    return {"token": token, "expiresAt": expires}


# ----------------------------------------------------------------------
# 세션 확인 (동의·QR 발급·내 기록 조회)
# ----------------------------------------------------------------------


def require_worker(token: str | None, worker_id: str, site_id: str) -> None:
    """요청한 사번·현장이 로그인한 근로자 본인인지 확인한다. WORKER_AUTH=off면 예전 방식 그대로 통과."""
    if WORKER_AUTH == "off":
        return
    if not token:
        raise AuthError(401, "worker login required (X-Worker-Token)")
    with db.get_conn() as conn:
        row = conn.execute("SELECT * FROM worker_sessions WHERE token_hash = ?", (_sha(token),)).fetchone()
    if row is None or row["expires_at"] < int(time.time()):
        raise AuthError(401, "worker session expired")
    if row["worker_id"] != worker_id or row["site_id"] != site_id:
        raise AuthError(403, "token belongs to a different worker/site")
