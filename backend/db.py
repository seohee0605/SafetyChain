"""SQLite 저장소.

CLAUDE.md 절대 원칙 3: 실명·연락처는 온체인에 절대 올리지 않는다.
workers 테이블(실명 매핑)과 sites 테이블(가명화 salt)은 이 파일에만 존재하고
체인에는 절대 넘기지 않는다. checkins 테이블도 alcoholPass는 bool만 저장한다
(원칙 2: 음주 수치는 로그에도 남기지 않는다).
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
    device_address TEXT NOT NULL,
    signature TEXT NOT NULL,
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

-- 감독자(안전관리자)의 케이스 최종 검토·서명. review_scope_hash가 그 시점에 검토한
-- site_records/checkins nonce 목록을 고정해서, 나중에 검토 범위를 몰래 넓히지 못하게 한다.
CREATE TABLE IF NOT EXISTS case_reviews (
    nonce TEXT PRIMARY KEY,
    case_id TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    reviewed_site_record_nonces TEXT NOT NULL,  -- JSON 배열
    reviewed_checkin_nonces TEXT NOT NULL,      -- JSON 배열
    review_scope_hash TEXT NOT NULL,
    review_result INTEGER NOT NULL,
    device_address TEXT NOT NULL,
    signature TEXT NOT NULL,
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
) -> None:
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO checkins
               (nonce, case_id, site_id, worker_id_hash, tx_hash, helmet_pass, shoes_pass,
                alcohol_pass, model_hash, device_address, signature, timestamp)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
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


def record_case_review(
    nonce: str,
    case_id: str,
    tx_hash: str,
    reviewed_site_record_nonces: str,
    reviewed_checkin_nonces: str,
    review_scope_hash: str,
    review_result: bool,
    device_address: str,
    signature: str,
    timestamp: int,
) -> None:
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO case_reviews
               (nonce, case_id, tx_hash, reviewed_site_record_nonces, reviewed_checkin_nonces,
                review_scope_hash, review_result, device_address, signature, timestamp)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                nonce,
                case_id,
                tx_hash,
                reviewed_site_record_nonces,
                reviewed_checkin_nonces,
                review_scope_hash,
                int(review_result),
                device_address,
                signature,
                timestamp,
            ),
        )


def get_case_review(nonce: str) -> sqlite3.Row | None:
    with get_conn() as conn:
        return conn.execute("SELECT * FROM case_reviews WHERE nonce = ?", (nonce,)).fetchone()


def list_case_reviews(case_id: str) -> list[sqlite3.Row]:
    with get_conn() as conn:
        return conn.execute(
            "SELECT * FROM case_reviews WHERE case_id = ? ORDER BY timestamp DESC", (case_id,)
        ).fetchall()


def dashboard_counts(site_id: str) -> dict:
    """checkedCount: 완료된 검사 수. uncheckedCount: 만료됐지만 검사로 이어지지 않은 QR 수."""
    now = int(time.time())
    with get_conn() as conn:
        checked = conn.execute(
            "SELECT COUNT(*) AS c FROM checkins WHERE site_id = ?", (site_id,)
        ).fetchone()["c"]
        unchecked = conn.execute(
            "SELECT COUNT(*) AS c FROM nonces WHERE site_id = ? AND consumed = 0 AND expires_at < ?",
            (site_id, now),
        ).fetchone()["c"]
    total = checked + unchecked
    rate = (checked / total) if total else 1.0
    return {"checkedCount": checked, "uncheckedCount": unchecked, "rate": rate}
