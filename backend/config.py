"""아주 단순한 .env 로더. python-dotenv 등 새 라이브러리를 추가하지 않기 위해 직접 구현."""
import os
from pathlib import Path

ENV_PATH = Path(__file__).parent / ".env"


def _load_env_file() -> None:
    if not ENV_PATH.exists():
        return
    for line in ENV_PATH.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


_load_env_file()

RPC_URL = os.environ.get("RPC_URL", "http://127.0.0.1:8545")
CONTRACT_ADDRESS = os.environ["CONTRACT_ADDRESS"]
SENDER_PRIVATE_KEY = os.environ["SENDER_PRIVATE_KEY"]


def _device_address() -> str:
    """게이트 기기 주소. 기기 키는 게이트 서비스(gate/)에만 있고 시공사 백엔드는 주소만 안다.
    예전 .env처럼 DEVICE_PRIVATE_KEY만 있으면 주소만 계산해서 쓰고, 키는 쓰지 않는다 (지우는 걸 권장)."""
    addr = os.environ.get("DEVICE_ADDRESS", "").strip()
    if addr:
        return addr
    legacy = os.environ.get("DEVICE_PRIVATE_KEY", "").strip()
    if legacy:
        from eth_account import Account

        print("[config] DEVICE_PRIVATE_KEY는 이제 gate/.env로 옮기고 backend/.env에는 DEVICE_ADDRESS만 두세요")
        return Account.from_key(legacy).address
    raise KeyError("DEVICE_ADDRESS")


DEVICE_ADDRESS = _device_address()


def _parse_admin_signers(raw: str) -> dict[str, str]:
    """"이름1:0x키1,이름2:0x키2" 형식을 {이름: 키} 딕셔너리로 파싱."""
    signers = {}
    for entry in raw.split(","):
        entry = entry.strip()
        if not entry:
            continue
        name, _, key = entry.partition(":")
        signers[name.strip()] = key.strip()
    return signers


ADMIN_SIGNERS = _parse_admin_signers(os.environ.get("ADMIN_SIGNERS", ""))

# 감리·발주처 서명 방식.
#   wallet (기본): 감리·발주처가 자기 지갑(MetaMask)으로 서명하고, 백엔드는 서명을 체인에 전달만 한다.
#                  백엔드는 감리·발주처 키를 갖지 않고 주소만 안다 (INSPECTOR_ACCOUNT / OWNER_ACCOUNT, "이름:0x주소").
#   server (백업): 데모 장애 대비. 백엔드가 INSPECTOR_SIGNER / OWNER_SIGNER ("이름:0x키")로 대신 서명한다.
REVIEWER_SIGNING = os.environ.get("REVIEWER_SIGNING", "wallet").strip().lower()
INSPECTOR_ACCOUNT = _parse_admin_signers(os.environ.get("INSPECTOR_ACCOUNT", ""))
OWNER_ACCOUNT = _parse_admin_signers(os.environ.get("OWNER_ACCOUNT", ""))
INSPECTOR_SIGNER = _parse_admin_signers(os.environ.get("INSPECTOR_SIGNER", "")) if REVIEWER_SIGNING == "server" else {}
OWNER_SIGNER = _parse_admin_signers(os.environ.get("OWNER_SIGNER", "")) if REVIEWER_SIGNING == "server" else {}


def _load_pseudonym_key() -> bytes:
    """날짜별 가명 workerId를 만드는 HMAC 비밀키.

    .env의 WORKER_PSEUDONYM_KEY를 우선 쓰고, 없으면 backend/pseudonym.key 파일을 만들어 쓴다
    (팀원 로컬 실행이 바로 깨지지 않게). 어느 쪽이든 DB 파일과는 따로 보관해야 한다.
    """
    raw = os.environ.get("WORKER_PSEUDONYM_KEY", "").strip()
    if raw:
        return raw.encode()
    key_file = Path(__file__).parent / "pseudonym.key"
    if not key_file.exists():
        import secrets

        key_file.write_text(secrets.token_hex(32))
    return key_file.read_text().strip().encode()


WORKER_PSEUDONYM_KEY = _load_pseudonym_key()

# 감리 감사 저장소 (시공사 백엔드와 별도 프로세스·별도 DB). 게이트가 서명 직후 체인 제출 전에 사본을 보낸다.
AUDIT_URL = os.environ.get("AUDIT_URL", "http://127.0.0.1:8100")

# 게이트 기기 서비스 (기기 키·YOLO 보유). 검증뷰가 현재 모델 해시를 물어볼 때 쓴다
GATE_URL = os.environ.get("GATE_URL", "http://127.0.0.1:8200")

# 시연용 제어(릴레이 중단, 지연 전송 재현, 기기 해제·재등록)를 켤지. 실서비스에서는 꺼둔다.
DEMO_CONTROLS = os.environ.get("DEMO_CONTROLS", "0") == "1"

# 릴레이 트랜잭션이 블록에 들어가길 기다리는 최대 시간(초). Sepolia 실측 최대 32초의 약 2배. 넘으면 거부가 아니라 "확정 대기"
RECEIPT_TIMEOUT = int(os.environ.get("RECEIPT_TIMEOUT", "60"))


def _load_photo_key() -> bytes:
    """검사 사진 암호화 키 (AES-256-GCM). .env의 PHOTO_KEY(64자리 hex)를 우선, 없으면 backend/photo.key 생성.
    사진에는 작업자 얼굴이 찍히므로 디스크에 평문으로 두지 않는다."""
    raw = os.environ.get("PHOTO_KEY", "").strip()
    if not raw:
        key_file = Path(__file__).parent / "photo.key"
        if not key_file.exists():
            import secrets

            key_file.write_text(secrets.token_hex(32))
        raw = key_file.read_text().strip()
    key = bytes.fromhex(raw)
    if len(key) != 32:
        raise ValueError("PHOTO_KEY must be 32 bytes (64 hex chars)")
    return key


PHOTO_KEY = _load_photo_key()

# 사고 조사 담당자 토큰. 이 토큰이 있어야 가명 → 사번 확인, 검사 사진 열람이 되고, 모든 열람은 로그로 남는다.
# 비워두면 조사용 열람 API는 꺼진다.
INVESTIGATOR_TOKEN = os.environ.get("INVESTIGATOR_TOKEN", "").strip()
