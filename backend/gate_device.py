"""게이트 기기 쪽 동작 (데모에서는 백엔드 안에서 시뮬레이션).

실제 현장에서는 이 파일의 역할이 게이트 하드웨어에서 돌아간다.
- 기기 키로 검사 기록에 EIP-712 서명
- 기기별 일련번호(deviceSeq) 부여: 빠진 번호 = 제출되지 않은 기록
- 서명 직후, 시공사 릴레이가 체인에 내기 "전에" 감리 감사 저장소로 사본을 직접 보낸다

시공사 릴레이(chain._send)를 멈추거나 특정 기록만 빼도, 감사 저장소에는 게이트가 보낸 원본이
남아 있어서 감리가 "서명은 됐는데 체인에 없는 기록"을 찾아낼 수 있다.
시공사 DB를 감리 서버로 복사하는 구조가 아니라, 게이트가 두 곳에 각각 보내는 구조다.
"""

import json
import urllib.error
import urllib.request

import chain
import config
import db


def next_seq() -> int:
    return db.next_device_seq(chain.DEVICE_ADDRESS)


def _jsonable_checkin(checkin: dict) -> dict:
    return {k: (chain.to_hex0x(v) if isinstance(v, bytes) else v) for k, v in checkin.items()}


def send_to_audit(checkin: dict, signature: bytes) -> bool:
    """감사 저장소로 서명된 기록 사본을 보낸다. 실패해도 게이트 동작은 멈추지 않는다
    (실제 기기라면 로컬에 쌓아뒀다가 재전송). 반환값: 전달 성공 여부."""
    body = json.dumps({"checkin": _jsonable_checkin(checkin), "signature": chain.to_hex0x(signature)}).encode()
    req = urllib.request.Request(
        f"{config.AUDIT_URL}/records", data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as res:
            return 200 <= res.status < 300
    except (urllib.error.URLError, TimeoutError, OSError):
        return False
