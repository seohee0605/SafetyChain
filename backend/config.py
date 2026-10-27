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
DEVICE_PRIVATE_KEY = os.environ["DEVICE_PRIVATE_KEY"]


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

# 감리·발주처 서명 키 ("이름:0x키" 1개씩). 데모에서만 백엔드가 보관한다.
# 실제 서비스에서는 각 기관이 자기 키로 서명한 값만 보낸다.
INSPECTOR_SIGNER = _parse_admin_signers(os.environ.get("INSPECTOR_SIGNER", ""))
OWNER_SIGNER = _parse_admin_signers(os.environ.get("OWNER_SIGNER", ""))


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

# 시연용 제어(릴레이 중단, 지연 전송 재현, 기기 해제·재등록)를 켤지. 실서비스에서는 꺼둔다.
DEMO_CONTROLS = os.environ.get("DEMO_CONTROLS", "0") == "1"
