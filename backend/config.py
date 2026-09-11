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
