"""SQLite 저장소 (오프체인 원본).

설계 원칙: 실명·연락처는 온체인에 올리지 않는다.
workers 테이블(실명 매핑)은 이 파일에만 존재하고 체인에는 절대 넘기지 않는다.
온체인 workerId는 날짜별 HMAC 가명이고, 그 비밀키는 이 DB가 아니라 .env/키 파일에 있다
(sites.salt는 예전 가명 방식의 흔적으로 남겨둔 테이블). checkins 테이블도 alcoholPass는 bool만 저장한다
(음주 수치는 로그에도 남기지 않는다).

이 DB는 "원본 보관소"일 뿐 신뢰 기준이 아니다. 검증 API는 항상 온체인 값과 대조한다.
"""
import secrets
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

DB_PATH = Path(__file__).parent / "safetychain.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS sites (
    site_id TEXT PRIMARY KEY,
    salt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workers (
    worker_id TEXT PRIMARY KEY,   -- 사번 (평문, 오프체인 전용)
    name TEXT NOT NULL
);

-- 민감정보(검사 사진·음주 통과 여부) 수집 동의. 동의 없으면 QR 발급 안 함
CREATE TABLE IF NOT EXISTS consents (
    worker_id TEXT NOT NULL,
    site_id TEXT NOT NULL,
    version TEXT NOT NULL,
    agreed_at INTEGER NOT NULL,
    PRIMARY KEY (worker_id, site_id)
);

-- 현장 사고 보고일 (무사고 일수 계산용, 오프체인)
CREATE TABLE IF NOT EXISTS incidents (
    site_id TEXT NOT NULL,
    incident_date TEXT NOT NULL,
    reported_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nonces (
    nonce TEXT PRIMARY KEY,
    worker_id TEXT NOT NULL,
    site_id TEXT NOT NULL,
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS checkins (
    nonce TEXT PRIMARY KEY,
    case_id TEXT NOT NULL,         -- 현장+작업일 단위로 위험성평가·검사를 묶는 식별자
    site_id TEXT NOT NULL,
    worker_id_hash TEXT NOT NULL,  -- 온체인에 올라간 가명 workerId
    tx_hash TEXT NOT NULL,
    helmet_pass INTEGER NOT NULL,
    shoes_pass INTEGER NOT NULL,
    alcohol_pass INTEGER NOT NULL,  -- bool만. 수치는 어디에도 저장하지 않는다.
    model_hash TEXT NOT NULL,
    evidence_hash TEXT,            -- 검사 사진 SHA-256 (온체인에도 기록)
    image_path TEXT,               -- 사진 원본 위치 (오프체인)
    device_address TEXT NOT NULL,
    signature TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    entry_status TEXT,             -- 온체인 출입 상태 (Granted/Denied/HeldNoAssessment/LateAuditOnly)
    device_seq INTEGER             -- 게이트 기기 일련번호
);

-- 게이트 기기의 일련번호 카운터 (기기 로컬 상태를 시뮬레이션). 서명할 때마다 1씩 증가
CREATE TABLE IF NOT EXISTS device_state (
    device_address TEXT PRIMARY KEY,
    last_seq INTEGER NOT NULL
);

-- 시연 설정 (릴레이 모드 등)
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- 체인이 거부한 제출 (위조 서명·nonce 재사용·시간 초과 등). 온체인에는 흔적이 안 남아서 여기에 감사 로그로 남긴다
CREATE TABLE IF NOT EXISTS rejected_submissions (
    kind TEXT NOT NULL,
    nonce TEXT,
    site_id TEXT,
    error TEXT NOT NULL,
    at INTEGER NOT NULL
);

-- 감독자 Manual Override. AI 보호구 불합격을 사유 코드와 함께 수동 처리한 기록.
CREATE TABLE IF NOT EXISTS overrides (
    nonce TEXT PRIMARY KEY,
    checkin_nonce TEXT NOT NULL,
    reason_code INTEGER NOT NULL,
    supervisor_address TEXT NOT NULL,
    signature TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    timestamp INTEGER NOT NULL
);

-- 일일 현장 위험성평가 기록. 전체 내용(공정/위험요인/조치)은 여기 원문으로 남고,
-- 온체인에는 record_hash(이 원문의 keccak256) + hazards_controlled(bool)만 앵커링된다.
CREATE TABLE IF NOT EXISTS site_records (
    nonce TEXT PRIMARY KEY,
    case_id TEXT NOT NULL,
    site_id TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    process_summary TEXT NOT NULL,   -- 오늘 공정/작업순서/장비투입/동선/작업방법 변경사항
    hazards_json TEXT NOT NULL,      -- [{hazard, riskBasis, controlMeasure, completed}, ...]
    change_reason TEXT,              -- 공정/작업방법이 바뀐 날에만 채움
    hazards_controlled INTEGER NOT NULL,  -- 중점관리대상 위험요인 조치 완료 여부
    record_hash TEXT NOT NULL,
    device_address TEXT NOT NULL,
    signature TEXT NOT NULL,
    timestamp INTEGER NOT NULL
);

-- Case 제출·승인·반려 이력. 제출(submit) 행에는 검토 범위(nonce 목록)를 원문으로 남겨서
-- 온체인 scopeHash와 다시 대조할 수 있게 한다.
CREATE TABLE IF NOT EXISTS case_actions (
    nonce TEXT PRIMARY KEY,
    case_id TEXT NOT NULL,
    action INTEGER NOT NULL,           -- 1 제출, 2 승인, 3 반려
    reason_code INTEGER NOT NULL,
    scope_hash TEXT NOT NULL,
    scope_json TEXT,                   -- 제출 시점의 기록 nonce 목록 (submit일 때만)
    signer_address TEXT NOT NULL,
    signature TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    timestamp INTEGER NOT NULL
);
"""

NONCE_TTL_SECONDS = 5 * 60


@contextmanager
def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with get_conn() as conn:
        conn.executescript(SCHEMA)
        # 이전 버전 DB 파일에 새 컬럼 추가
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(checkins)")}
        for col, typ in (("evidence_hash", "TEXT"), ("image_path", "TEXT"), ("entry_status", "TEXT"),
                         ("device_seq", "INTEGER")):
            if col not in cols:
                conn.execute(f"ALTER TABLE checkins ADD COLUMN {col} {typ}")


def get_or_create_site_salt(site_id: str) -> str:
    with get_conn() as conn:
        row = conn.execute("SELECT salt FROM sites WHERE site_id = ?", (site_id,)).fetchone()
        if row:
            return row["salt"]
        salt = secrets.token_hex(16)
        conn.execute("INSERT INTO sites (site_id, salt) VALUES (?, ?)", (site_id, salt))
        return salt


def upsert_worker(worker_id: str, name: str) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO workers (worker_id, name) VALUES (?, ?) "
            "ON CONFLICT(worker_id) DO UPDATE SET name = excluded.name",
            (worker_id, name),
        )


def issue_nonce(worker_id: str, site_id: str) -> dict:
    nonce = "0x" + secrets.token_hex(32)
    now = int(time.time())
    expires_at = now + NONCE_TTL_SECONDS
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO nonces (nonce, worker_id, site_id, issued_at, expires_at) VALUES (?, ?, ?, ?, ?)",
            (nonce, worker_id, site_id, now, expires_at),
        )
    return {"nonce": nonce, "expiresAt": expires_at}


def get_nonce(nonce: str) -> sqlite3.Row | None:
    with get_conn() as conn:
        return conn.execute("SELECT * FROM nonces WHERE nonce = ?", (nonce,)).fetchone()


def consume_nonce(nonce: str) -> None:
    with get_conn() as conn:
        conn.execute("UPDATE nonces SET consumed = 1 WHERE nonce = ?", (nonce,))


def record_checkin(
    nonce: str,
    case_id: str,
    site_id: str,
    worker_id_hash: str,
    tx_hash: str,
    helmet_pass: bool,
    shoes_pass: bool,
    alcohol_pass: bool,
    model_hash: str,
    device_address: str,
    signature: str,
    timestamp: int,
    evidence_hash: str,
    image_path: str,
    entry_status: str,
    device_seq: int,
) -> None:
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO checkins
               (nonce, case_id, site_id, worker_id_hash, tx_hash, helmet_pass, shoes_pass,
                alcohol_pass, model_hash, device_address, signature, timestamp, evidence_hash, image_path,
                entry_status, device_seq)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                nonce,
                case_id,
                site_id,
                worker_id_hash,
                tx_hash,
                int(helmet_pass),
                int(shoes_pass),
                int(alcohol_pass),
                model_hash,
                device_address,
                signature,
                timestamp,
                evidence_hash,
                image_path,
                entry_status,
                device_seq,
            ),
        )


def get_checkin(nonce: str) -> sqlite3.Row | None:
    with get_conn() as conn:
        return conn.execute("SELECT * FROM checkins WHERE nonce = ?", (nonce,)).fetchone()


def list_checkins_by_case(case_id: str) -> list[sqlite3.Row]:
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM checkins WHERE case_id = ? ORDER BY timestamp DESC", (case_id,)
        ).fetchall()


def record_site_record(
    nonce: str,
    case_id: str,
    site_id: str,
    tx_hash: str,
    process_summary: str,
    hazards_json: str,
    change_reason: str | None,
    hazards_controlled: bool,
    record_hash: str,
    device_address: str,
    signature: str,
    timestamp: int,
) -> None:
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO site_records
               (nonce, case_id, site_id, tx_hash, process_summary, hazards_json, change_reason,
                hazards_controlled, record_hash, device_address, signature, timestamp)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                nonce,
                case_id,
                site_id,
                tx_hash,
                process_summary,
                hazards_json,
                change_reason,
                int(hazards_controlled),
                record_hash,
                device_address,
                signature,
                timestamp,
            ),
        )


def get_site_record(nonce: str) -> sqlite3.Row | None:
    with get_conn() as conn:
        return conn.execute("SELECT * FROM site_records WHERE nonce = ?", (nonce,)).fetchone()


def list_site_records(site_id: str) -> list[sqlite3.Row]:
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM site_records WHERE site_id = ? ORDER BY timestamp DESC", (site_id,)
        ).fetchall()


def list_site_records_by_case(case_id: str) -> list[sqlite3.Row]:
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM site_records WHERE case_id = ? ORDER BY timestamp DESC", (case_id,)
        ).fetchall()


def record_override(
    nonce: str, checkin_nonce: str, reason_code: int, supervisor_address: str, signature: str, tx_hash: str, timestamp: int
) -> None:
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO overrides
               (nonce, checkin_nonce, reason_code, supervisor_address, signature, tx_hash, timestamp)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (nonce, checkin_nonce, reason_code, supervisor_address, signature, tx_hash, timestamp),
        )


def get_override_for_checkin(checkin_nonce: str) -> sqlite3.Row | None:
    with get_conn() as conn:
        return conn.execute("SELECT * FROM overrides WHERE checkin_nonce = ?", (checkin_nonce,)).fetchone()


def list_overrides_by_case(case_id: str) -> list[sqlite3.Row]:
    with get_conn() as conn:
        return conn.execute(
            """SELECT o.* FROM overrides o JOIN checkins c ON c.nonce = o.checkin_nonce
               WHERE c.case_id = ? ORDER BY o.timestamp DESC""",
            (case_id,),
        ).fetchall()


def record_case_action(
    nonce: str,
    case_id: str,
    action: int,
    reason_code: int,
    scope_hash: str,
    scope_json: str | None,
    signer_address: str,
    signature: str,
    tx_hash: str,
    timestamp: int,
) -> None:
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO case_actions
               (nonce, case_id, action, reason_code, scope_hash, scope_json, signer_address, signature, tx_hash, timestamp)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (nonce, case_id, action, reason_code, scope_hash, scope_json, signer_address, signature, tx_hash, timestamp),
        )


def latest_case_submission(case_id: str) -> sqlite3.Row | None:
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM case_actions WHERE case_id = ? AND action = 1 ORDER BY timestamp DESC LIMIT 1", (case_id,)
        ).fetchone()


def list_case_actions(case_id: str) -> list[sqlite3.Row]:
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM case_actions WHERE case_id = ? ORDER BY timestamp ASC", (case_id,)
        ).fetchall()


def count_unchecked(site_id: str) -> int:
    # 발급만 되고 만료될 때까지 검사로 안 이어진 QR 수
    with get_conn() as conn:
        return conn.execute(
            "SELECT COUNT(*) AS c FROM nonces WHERE site_id = ? AND consumed = 0 AND expires_at < ?",
            (site_id, int(time.time())),
        ).fetchone()["c"]


def save_consent(worker_id: str, site_id: str, version: str) -> int:
    now = int(time.time())
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO consents (worker_id, site_id, version, agreed_at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(worker_id, site_id) DO UPDATE SET version = excluded.version, agreed_at = excluded.agreed_at",
            (worker_id, site_id, version, now),
        )
    return now


def get_consent(worker_id: str, site_id: str) -> sqlite3.Row | None:
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM consents WHERE worker_id = ? AND site_id = ?", (worker_id, site_id)
        ).fetchone()


def delete_consent(worker_id: str, site_id: str) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM consents WHERE worker_id = ? AND site_id = ?", (worker_id, site_id))


def list_checkins_by_worker(worker_id: str, site_id: str) -> list[sqlite3.Row]:
    # 가명이 날짜마다 바뀌므로 가명이 아니라 QR 발급 기록(오프체인 사번 매핑)으로 근로자 본인 기록을 찾는다
    with get_conn() as conn:
        return conn.execute(
            """SELECT c.* FROM checkins c JOIN nonces n ON n.nonce = c.nonce
               WHERE n.worker_id = ? AND n.site_id = ? ORDER BY c.timestamp DESC LIMIT 50""",
            (worker_id, site_id),
        ).fetchall()


def next_device_seq(device_address: str) -> int:
    """게이트 기기의 다음 일련번호. 서명에 쓰인 번호는 체인 제출 실패와 무관하게 소진된다
    (서명은 됐는데 체인에 없으면 그대로 '누락'으로 보이는 게 맞다)."""
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO device_state (device_address, last_seq) VALUES (?, 1) "
            "ON CONFLICT(device_address) DO UPDATE SET last_seq = last_seq + 1",
            (device_address.lower(),),
        )
        return conn.execute(
            "SELECT last_seq FROM device_state WHERE device_address = ?", (device_address.lower(),)
        ).fetchone()["last_seq"]


def get_setting(key: str, default: str) -> str:
    with get_conn() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(key: str, value: str) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )


def record_rejection(kind: str, nonce: str | None, site_id: str | None, error: str) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO rejected_submissions (kind, nonce, site_id, error, at) VALUES (?, ?, ?, ?, ?)",
            (kind, nonce, site_id, error, int(time.time())),
        )


def unchecked_expiry_times(site_id: str, since: int) -> list[int]:
    # 일별 미검사 집계용: 쓰이지 않고 만료된 QR의 만료 시각
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT expires_at FROM nonces WHERE site_id = ? AND consumed = 0 AND expires_at < ? AND expires_at >= ?",
            (site_id, int(time.time()), since),
        ).fetchall()
    return [r["expires_at"] for r in rows]


def add_incident(site_id: str, incident_date: str) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO incidents (site_id, incident_date, reported_at) VALUES (?, ?, ?)",
            (site_id, incident_date, int(time.time())),
        )


def last_incident_date(site_id: str) -> str | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT MAX(incident_date) AS d FROM incidents WHERE site_id = ?", (site_id,)
        ).fetchone()
    return row["d"] if row else None


def list_rejections(site_id: str, limit: int = 50) -> list[sqlite3.Row]:
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM rejected_submissions WHERE site_id = ? ORDER BY at DESC LIMIT ?", (site_id, limit)
        ).fetchall()
