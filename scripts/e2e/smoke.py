"""SafetyChain E2E 스모크 테스트.

로컬 체인(anvil)에 컨트랙트를 새로 배포하고, 시공사 백엔드·게이트·감리 감사 저장소를 실제로 띄워서
출입 기록이 게이트 → 감사 저장소 → 시공사 릴레이 → 체인으로 흐르는 전체 경로를 검증한다.

격리: 서비스 폴더와 contracts/를 임시 폴더에 복사해서 돌린다. 각 서비스의 DB·키 파일·.env는 복사하지 않으므로
평소 쓰는 DB(데모용 Sepolia 기록 포함)는 건드리지 않는다. 포트도 18xxx를 쓴다.
AI 두 가지 모드:
  기본(대역)   : 복사본의 gate/vision.py만 scripts/e2e/stub_vision.py로 바꾼다 (YOLO·torch 불필요, CI용).
  --real-vision: 실제 gate/vision.py와 gate/models/*.pt로 판정한다. 착용 사진과 미착용 사진을 넣으면
                 AI가 착용 사진은 통과, 미착용(사람은 찾고 헬멧은 없음) 사진은 불합격·감독자 확인으로 보는지도 검사한다.

필요한 것: anvil·forge (PATH), 서비스 의존성이 설치된 파이썬 (--real-vision이면 ultralytics까지)
실행:      python scripts/e2e/smoke.py            (실패한 검사가 있으면 종료 코드 1)
           python scripts/e2e/smoke.py --real-vision --deny-image <미착용 사진> [--pass-image <착용 사진>]
옵션:      --keep  임시 폴더를 지우지 않음 (로그 확인용)
"""

import argparse
import base64
import hashlib
import json
import os
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from Crypto.Hash import SHA256
from Crypto.PublicKey import ECC
from Crypto.Signature import DSS
from eth_account import Account

ROOT = Path(__file__).resolve().parents[2]
STUB_VISION = Path(__file__).resolve().parent / "stub_vision.py"

PORTS = {"anvil": 18545, "backend": 18000, "audit": 18100, "gate": 18200}
SITE = "E2E-SITE"
# 근로자 앱 주소 (임시 터널 와일드카드 허용을 같이 검사한다). rpId = 이 주소의 호스트 이름
WORKER_ORIGIN = "https://e2e-demo.trycloudflare.com"
SUPERVISOR = "감독자"
# anvil 기본 계정 0번 (공개된 테스트 키, 로컬 체인 전용). 릴레이 계정으로 가스를 낸다
ANVIL_KEY0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
DEFAULT_PASS_IMAGE = ROOT / "frontend" / "public" / "demo-helmet.jpg"
REAL_WEIGHTS = ("cand_killuminati.pt", "yolov8n.pt")  # gate/vision.py가 읽는 가중치
FORGE_DEPS = ["foundry-rs/forge-std@v1.16.2", "OpenZeppelin/openzeppelin-contracts@v5.7.0"]

IGNORE = shutil.ignore_patterns(
    ".env", "*.db", "*.db-*", "*.key", ".venv", "venv", "__pycache__", "*.pyc",
    "uploads", "models", "eval_data", "eval_out", "measure_out", "out", "cache", "broadcast", "node_modules",
)


# ----------------------------------------------------------------------
# 결과 기록
# ----------------------------------------------------------------------

RESULTS: list[tuple[bool, str, str]] = []


def check(ok: bool, name: str, detail: str = "") -> bool:
    RESULTS.append((bool(ok), name, detail))
    mark = "PASS" if ok else "FAIL"
    print(f"  [{mark}] {name}" + (f"  ({detail})" if detail else ""), flush=True)
    return bool(ok)


def step(title: str) -> None:
    print(f"\n== {title}", flush=True)


# ----------------------------------------------------------------------
# HTTP (표준 라이브러리만)
# ----------------------------------------------------------------------


class HttpError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(f"HTTP {status}: {detail}")
        self.status = status
        self.detail = detail


def _send(req: urllib.request.Request, timeout: float = 90) -> dict:
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        try:
            body = str(json.loads(body).get("detail", body))
        except ValueError:
            pass
        raise HttpError(e.code, body) from e


def get(port: int, path: str, headers: dict | None = None) -> dict:
    return _send(urllib.request.Request(f"http://127.0.0.1:{port}{path}", headers=headers or {}))


def post_json(port: int, path: str, body: dict, headers: dict | None = None) -> dict:
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", **(headers or {})}, method="POST",
    )
    return _send(req)


def expect_error(status: int, fn, *args, contains: str = "") -> tuple[bool, str]:
    """요청이 지정한 HTTP 상태로 거부되는지. (통과 여부, 상세)"""
    try:
        fn(*args)
        return False, "거부되지 않음"
    except HttpError as e:
        return e.status == status and contains in e.detail, f"{e.status} {e.detail[:60]}"


def post_multipart(port: int, path: str, fields: dict, files: list[tuple[str, bytes]]) -> dict:
    boundary = uuid.uuid4().hex
    parts = [
        f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
        for k, v in fields.items()
    ]
    for i, (field, data) in enumerate(files):
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"; filename="frame{i}.jpg"\r\n'
            f"Content-Type: image/jpeg\r\n\r\n".encode() + data + b"\r\n"
        )
    body = b"".join(parts) + f"--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"}, method="POST",
    )
    return _send(req)


# ----------------------------------------------------------------------
# 환경 준비
# ----------------------------------------------------------------------


def require_tools() -> None:
    missing = [t for t in ("anvil", "forge") if shutil.which(t) is None]
    if missing:
        sys.exit(f"필요한 도구가 PATH에 없다: {', '.join(missing)} (Foundry 설치 필요)")


def require_free_ports() -> None:
    busy = []
    for name, port in PORTS.items():
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", port)) == 0:
                busy.append(f"{name}:{port}")
    if busy:
        sys.exit(f"포트가 이미 쓰이고 있다: {', '.join(busy)} (이전 스모크 테스트가 남아 있는지 확인)")


def prepare_workspace(ws: Path, real_vision: bool) -> None:
    for name in ("backend", "gate", "audit"):
        shutil.copytree(ROOT / name, ws / name, ignore=IGNORE)
    # contracts는 lib까지 복사한다 (out/cache/broadcast는 제외 → 맥의 빌드 산출물을 건드리지 않음)
    shutil.copytree(ROOT / "contracts", ws / "contracts", ignore=IGNORE)
    if real_vision:
        # 실제 판정: 원본 vision.py 그대로, 가중치만 복사본 models/로 가져온다
        (ws / "gate" / "models").mkdir(exist_ok=True)
        for w in REAL_WEIGHTS:
            shutil.copy(ROOT / "gate" / "models" / w, ws / "gate" / "models" / w)
    else:
        shutil.copy(STUB_VISION, ws / "gate" / "vision.py")
    (ws / "logs").mkdir()


def require_real_vision_inputs(pass_image: Path, deny_image: Path | None) -> None:
    missing = [str(ROOT / "gate" / "models" / w) for w in REAL_WEIGHTS if not (ROOT / "gate" / "models" / w).exists()]
    if missing:
        sys.exit("실제 판정에 필요한 가중치가 없다:\n  " + "\n  ".join(missing)
                 + "\n(gate/에서 python eval_shoes.py 를 한 번 실행하면 내려받는다)")
    if deny_image is None:
        sys.exit("--real-vision에는 --deny-image <헬멧 미착용 사진>이 필요하다")
    for p in (pass_image, deny_image):
        if not p.is_file():
            sys.exit(f"사진 파일이 없다: {p}")


def ensure_forge_deps(contracts: Path) -> None:
    lib = contracts / "lib"
    if (lib / "openzeppelin-contracts").exists() and (lib / "forge-std").exists():
        return
    print("  contracts/lib이 없어서 고정 버전으로 설치한다", flush=True)
    subprocess.run(["forge", "install", *FORGE_DEPS, "--no-git"], cwd=contracts, check=True,
                   stdout=subprocess.DEVNULL)


PROCS: list[tuple[str, subprocess.Popen]] = []


def start(name: str, cmd: list[str], cwd: Path, env: dict, ws: Path) -> None:
    log = open(ws / "logs" / f"{name}.log", "w")
    proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT,
                            start_new_session=True)
    PROCS.append((name, proc))


def stop_all() -> None:
    for _, proc in reversed(PROCS):
        if proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    for _, proc in PROCS:
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)


def wait_ready(name: str, port: int, path: str, ws: Path, timeout: float = 60) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        proc = dict(PROCS).get(name)
        if proc is not None and proc.poll() is not None:
            break
        try:
            get(port, path)
            return
        except (HttpError, urllib.error.URLError, ConnectionError, OSError):
            time.sleep(0.5)
    tail = (ws / "logs" / f"{name}.log").read_text(errors="replace")[-3000:]
    raise RuntimeError(f"{name} 서비스가 뜨지 않았다. 로그 끝부분:\n{tail}")


def wait_rpc(port: int, timeout: float = 30) -> None:
    deadline = time.time() + timeout
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_chainId", "params": []}).encode()
    while time.time() < deadline:
        try:
            req = urllib.request.Request(f"http://127.0.0.1:{port}", data=body,
                                         headers={"Content-Type": "application/json"})
            urllib.request.urlopen(req, timeout=2).read()
            return
        except (urllib.error.URLError, ConnectionError, OSError):
            time.sleep(0.3)
    raise RuntimeError("anvil이 뜨지 않았다")


def deploy(contracts: Path, rpc: str, sender_key: str, device: str, supervisor: str,
           inspector_key: str, owner: str) -> str:
    env = {**os.environ, "DEVICE_ADDRESS": device, "ADMIN_SIGNER_ADDRESSES": supervisor,
           "OWNER_ADDRESS": owner, "INSPECTOR_PRIVATE_KEY": inspector_key}
    env.pop("INSPECTOR_ADDRESS", None)
    out = subprocess.run(
        ["forge", "script", "script/Deploy.s.sol:DeployScript", "--rpc-url", rpc, "--broadcast",
         "--private-key", sender_key],
        cwd=contracts, env=env, capture_output=True, text=True,
    )
    if out.returncode != 0:
        raise RuntimeError(f"배포 실패:\n{out.stdout[-3000:]}\n{out.stderr[-3000:]}")
    for line in out.stdout.splitlines():
        if "SafetyGate deployed at:" in line:
            return line.split("SafetyGate deployed at:")[1].strip()
    raise RuntimeError(f"배포 주소를 찾지 못했다:\n{out.stdout[-3000:]}")


# ----------------------------------------------------------------------
# 시나리오 헬퍼
# ----------------------------------------------------------------------

KST = timezone(timedelta(hours=9))


def key_hex(acct) -> str:
    # eth-account 버전에 따라 key.hex()에 0x가 붙기도, 안 붙기도 한다. forge는 0x가 있어야 16진수로 읽는다
    return "0x" + acct.key.hex().removeprefix("0x")


def work_date() -> str:
    # 컨트랙트는 위험성평가와 출입의 블록 시각을 KST 날짜로 비교한다. caseId도 같은 날짜로 맞춘다
    return datetime.now(KST).date().isoformat()


PHOTOS: dict[str, bytes] = {}  # --real-vision일 때 {"pass": 착용 사진, "deny": 미착용 사진}


def frames(helmet_pass: bool, tag: str) -> list[tuple[str, bytes]]:
    if PHOTOS:
        # 실제 판정: 같은 사진 3장 (키오스크가 1초에 찍는 3장 대신. 같은 사진이라 판정이 매번 같다)
        photo = PHOTOS["pass" if helmet_pass else "deny"]
        return [("image", photo) for _ in range(3)]
    marker = b"HELMET:pass" if helmet_pass else b"HELMET:deny"
    return [("image", marker + f" {tag} frame{i} ".encode() + secrets.token_bytes(8)) for i in range(3)]


# ----------------------------------------------------------------------
# 가짜 패스키 인증기: 아이폰 패스키와 같은 형식(ES256, authenticatorData, clientDataJSON)으로 서명한다.
# 브라우저 없이 서버의 WebAuthn 검증을 그대로 거친다.
# ----------------------------------------------------------------------


def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


class FakePasskey:
    def __init__(self, origin: str = WORKER_ORIGIN):
        self.key = ECC.generate(curve="P-256")
        self.credential_id = b64url(secrets.token_bytes(32))
        self.origin = origin

    def _client_data(self, typ: str, challenge: str, origin: str | None = None) -> bytes:
        return json.dumps({"type": typ, "challenge": challenge, "origin": origin or self.origin,
                           "crossOrigin": False}, separators=(",", ":")).encode()

    def _auth_data(self, uv: bool = True, origin: str | None = None) -> bytes:
        rp_id = urllib.parse.urlparse(origin or self.origin).hostname
        flags = 0x01 | (0x04 if uv else 0)  # UP + UV(Face ID)
        return hashlib.sha256(rp_id.encode()).digest() + bytes([flags]) + (0).to_bytes(4, "big")  # 동기화 패스키: 카운터 0

    def attestation(self, challenge: str) -> dict:
        return {"credentialId": self.credential_id,
                "publicKey": b64url(self.key.public_key().export_key(format="DER")),
                "clientDataJSON": b64url(self._client_data("webauthn.create", challenge)),
                "authenticatorData": b64url(self._auth_data())}

    def assertion(self, challenge: str, uv: bool = True, origin: str | None = None, signer=None) -> dict:
        cd = self._client_data("webauthn.get", challenge, origin)
        ad = self._auth_data(uv, origin)
        digest = SHA256.new(ad + hashlib.sha256(cd).digest())
        sig = DSS.new(signer or self.key, "fips-186-3", encoding="der").sign(digest)
        return {"credentialId": self.credential_id, "clientDataJSON": b64url(cd),
                "authenticatorData": b64url(ad), "signature": b64url(sig)}


TOKENS: dict[str, str] = {}  # 사번 → 로그인 세션 토큰


def worker_ids(worker: str) -> dict:
    return {"workerId": worker, "siteId": SITE}


def enroll_and_login(worker: str) -> tuple[FakePasskey, str]:
    """감독자 초대 코드 → 패스키 등록 → 패스키 로그인. (인증기, 토큰)"""
    b = PORTS["backend"]
    code = post_json(b, "/worker/invite", {**worker_ids(worker), "supervisorName": SUPERVISOR})["code"]
    pk = FakePasskey()
    opt = post_json(b, "/worker/register/options", {**worker_ids(worker), "inviteCode": code})
    post_json(b, "/worker/register", {**worker_ids(worker), "inviteCode": code, **pk.attestation(opt["challenge"])})
    return pk, login(worker, pk)


def login(worker: str, pk: FakePasskey) -> str:
    b = PORTS["backend"]
    opt = post_json(b, "/worker/login/options", worker_ids(worker))
    token = post_json(b, "/worker/login", {**worker_ids(worker), **pk.assertion(opt["challenge"])})["token"]
    TOKENS[worker] = token
    return token


def auth(worker: str) -> dict:
    return {"X-Worker-Token": TOKENS[worker]}


def issue_qr(worker: str) -> str:
    if worker not in TOKENS:
        enroll_and_login(worker)
    b = PORTS["backend"]
    post_json(b, "/consent", {**worker_ids(worker), "personal": True, "sensitive": True}, auth(worker))
    return post_json(b, "/qr/issue", worker_ids(worker), auth(worker))["nonce"]


def gate_check(worker: str, nonce: str, helmet_pass: bool, tag: str) -> dict:
    fields = {"nonce": nonce, "alcoholPass": "true", "shoesPass": "true", "workerId": worker,
              "siteId": SITE, "workDate": work_date()}
    return post_multipart(PORTS["gate"], "/check", fields, frames(helmet_pass, tag))


# ----------------------------------------------------------------------
# 시나리오
# ----------------------------------------------------------------------


def run_scenarios(ws: Path, audit_grace: int) -> None:
    b, g, a = PORTS["backend"], PORTS["gate"], PORTS["audit"]

    step("1. 백엔드·감사 저장소 ABI가 컨트랙트와 일치하는지")
    built = json.loads((ws / "contracts" / "out" / "SafetyGate.sol" / "SafetyGate.json").read_text())["abi"]
    for svc in ("backend", "audit"):
        committed = json.loads((ROOT / svc / "abi" / "SafetyGate.json").read_text())
        same = json.dumps(committed, sort_keys=True) == json.dumps(built, sort_keys=True)
        check(same, f"{svc}/abi/SafetyGate.json = 컨트랙트 빌드 ABI",
              "" if same else "컨트랙트를 바꿨다면 ABI 파일도 다시 복사해야 한다")

    step("2. 위험성평가 제출 (당일 평가가 있어야 출입 허가)")
    r = post_json(b, "/site/record", {
        "siteId": SITE, "processSummary": "E2E 스모크: 철골 조립", "workDate": work_date(),
        "hazards": [{"hazard": "추락", "riskBasis": "고소 작업", "controlMeasure": "안전대 체결", "completed": True}],
        "hazardsControlled": True, "adminName": SUPERVISOR,
    })
    check(bool(r.get("txHash")), "위험성평가가 체인에 기록됨", r.get("nonce", "")[:12])

    step("2-1. 근로자 패스키: 본인만 자기 QR·기록에 접근")
    ok, d = expect_error(401, post_json, b, "/qr/issue", worker_ids("W-PASS"))
    check(ok, "로그인 없이 QR 발급 요청 → 거부", d)
    code = post_json(b, "/worker/invite", {**worker_ids("W-PASS"), "supervisorName": SUPERVISOR})["code"]
    ok, d = expect_error(403, post_json, b, "/worker/register/options", {**worker_ids("W-OTHER"), "inviteCode": code})
    check(ok, "다른 사번으로 초대 코드 사용 → 거부", d)
    pk = FakePasskey()
    opt = post_json(b, "/worker/register/options", {**worker_ids("W-PASS"), "inviteCode": code})
    r = post_json(b, "/worker/register", {**worker_ids("W-PASS"), "inviteCode": code, **pk.attestation(opt["challenge"])})
    check(r.get("registered") is True, "초대 코드 + 패스키로 등록 (터널 주소 와일드카드 허용)")
    ok, d = expect_error(403, post_json, b, "/worker/register/options", {**worker_ids("W-PASS"), "inviteCode": code},
                         contains="already used")
    check(ok, "초대 코드 재사용 → 거부", d)

    opt = post_json(b, "/worker/login/options", worker_ids("W-PASS"))
    ok, d = expect_error(403, post_json, b, "/worker/login", {**worker_ids("W-PASS"), **pk.assertion(opt["challenge"], uv=False)})
    check(ok and "UV" in d, "Face ID 없이(UV 없음) 서명 → 거부", d)
    opt = post_json(b, "/worker/login/options", worker_ids("W-PASS"))
    ok, d = expect_error(403, post_json, b, "/worker/login",
                         {**worker_ids("W-PASS"), **pk.assertion(opt["challenge"], signer=ECC.generate(curve="P-256"))})
    check(ok, "다른 키로 만든 서명 → 거부", d)
    opt = post_json(b, "/worker/login/options", worker_ids("W-PASS"))
    ok, d = expect_error(403, post_json, b, "/worker/login",
                         {**worker_ids("W-PASS"), **pk.assertion(opt["challenge"], origin="https://evil.example")})
    check(ok and "origin" in d, "허용하지 않은 주소에서 서명 → 거부", d)
    opt = post_json(b, "/worker/login/options", worker_ids("W-PASS"))
    good = pk.assertion(opt["challenge"])
    token = post_json(b, "/worker/login", {**worker_ids("W-PASS"), **good})["token"]
    TOKENS["W-PASS"] = token
    check(bool(token), "정상 패스키 서명으로 로그인")
    ok, d = expect_error(403, post_json, b, "/worker/login", {**worker_ids("W-PASS"), **good}, contains="already used")
    check(ok, "같은 서명 재전송(챌린지 재사용) → 거부", d)

    enroll_and_login("W-OTHER")
    ok, d = expect_error(403, post_json, b, "/qr/issue", worker_ids("W-OTHER"), auth("W-PASS"))
    check(ok, "내 토큰으로 남의 사번 QR 발급 → 거부 (대리 출입 차단)", d)
    ok, d = expect_error(403, get, b, f"/worker/{SITE}/W-OTHER/records", auth("W-PASS"))
    check(ok, "내 토큰으로 남의 출입 기록 조회 → 거부", d)

    step("3. 정상 통과 → Granted")
    n_pass = issue_qr("W-PASS")
    r = gate_check("W-PASS", n_pass, True, "pass")
    if PHOTOS:
        ai = r.get("ai") or {}
        check(ai.get("helmetDecision") == "pass", "실제 AI: 착용 사진을 통과로 판정",
              f"decision={ai.get('helmetDecision')} score={ai.get('helmetScore')}")
    check(r.get("anchored") is True, "기록이 체인에 앵커링됨")
    check(r.get("entryStatus") == "Granted", "출입 상태 = Granted", str(r.get("entryStatus")))
    check(r.get("auditDelivered") is True, "감리 감사 저장소에 원본 전달됨")
    check(r.get("deviceSeq") == 1, "기기 일련번호 1번", str(r.get("deviceSeq")))
    mine = get(b, f"/worker/{SITE}/W-PASS/records", auth("W-PASS"))
    check(len(mine) == 1 and mine[0]["result"] == "pass", "근로자 앱: 본인 기록 조회", str(len(mine)))
    check(all("alcoholPass" not in x for x in mine), "본인 기록에도 음주 결과 필드 없음")

    step("4. 검증뷰: DB·사진 원본을 체인 저장값과 대조")
    v = get(b, f"/verify/{n_pass}")
    for key, label in [("onchain", "체인에 있음"), ("sigValid", "기기 서명 유효"),
                       ("recordMatchesChain", "시공사 DB = 체인 값"), ("evidenceIntact", "사진 해시 = 체인 evidenceHash"),
                       ("modelHashMatch", "현재 게이트 modelHash = 판정 당시 값")]:
        check(v.get(key) is True, label)

    step("5. 보호구 불합격 → Denied → 감독자 Override")
    n_fail = issue_qr("W-FAIL")
    r = gate_check("W-FAIL", n_fail, False, "fail")
    if PHOTOS:
        ai = r.get("ai") or {}
        check(ai.get("person") is True, "실제 AI: 미착용 사진에서 사람은 찾음 (사람 없음 경로가 아님)")
        check(ai.get("helmetDecision") in ("deny", "supervisor"), "실제 AI: 미착용 사진을 불합격 또는 감독자 확인으로 판정",
              f"decision={ai.get('helmetDecision')} score={ai.get('helmetScore')}")
    check(r.get("entryStatus") == "Denied", "출입 상태 = Denied", str(r.get("entryStatus")))
    check(r.get("overridable") is True, "Override 가능으로 표시")
    o = post_json(b, "/gate/override", {"nonce": n_fail, "reasonCode": 1, "supervisorName": SUPERVISOR})
    check(o.get("entryAllowed") is True, "Override 후 출입 허가 (isEntryAllowed)")

    step("6. 같은 QR 재사용 차단")
    try:
        gate_check("W-PASS", n_pass, True, "replay")
        check(False, "사용한 QR로 다시 검사하면 거부")
    except HttpError as e:
        check(e.status == 400 and "already used" in e.detail, "사용한 QR로 다시 검사하면 거부", e.detail[:60])

    step("7. 시공사가 불합격 기록을 숨김 → 감리 감사 저장소가 잡아냄")
    post_json(b, "/demo/relay", {"mode": "drop_failed"})
    n_hidden = issue_qr("W-HIDDEN")
    r = gate_check("W-HIDDEN", n_hidden, False, "hidden")
    post_json(b, "/demo/relay", {"mode": "normal"})
    check(r.get("anchored") is False, "릴레이가 체인에 제출하지 않음 (시공사 누락 시연)")
    check(r.get("auditDelivered") is True, "그래도 감사 저장소에는 원본이 들어감")
    time.sleep(audit_grace + 1)
    s = get(a, f"/summary/{SITE}")
    rec = next((x for x in s["records"] if x["nonce"] == n_hidden), None)
    check(rec is not None and rec["audit"] == "missing", "감리 화면: 체인 미제출", rec and rec["audit"])
    verdict = rec and rec.get("chainCheck") and rec["chainCheck"]["verdict"]
    check(verdict == "withheld", "모의 실행 결과: 받을 수 있었는데 안 냄", str(verdict))
    check(rec is not None and rec["inContractorDb"] is False, "시공사 DB에서도 사라짐")
    check((s.get("contractor") or {}).get("hidden") == 1, "숨긴 기록 1건으로 집계", str(s.get("contractor")))
    check(all("workerId" not in x for x in s["records"]), "감리 응답에 근로자 가명 없음 (개인 지목 금지)")

    step("8. 다음 기록이 올라오면 체인만 봐도 빈 번호가 보임")
    n_after = issue_qr("W-AFTER")
    r = gate_check("W-AFTER", n_after, True, "after")
    check(r.get("deviceSeq") == 4 and r.get("entryStatus") == "Granted", "4번 기록 정상 앵커링",
          f"seq={r.get('deviceSeq')} status={r.get('entryStatus')}")
    devices = get(b, "/devices")
    dev = devices[0] if isinstance(devices, list) and devices else (devices.get("devices") or [{}])[0]
    check(dev.get("missing") == 1, "체인 missingCount = 1 (3번 빈 번호)", json.dumps(dev, ensure_ascii=False)[:120])

    step("9. 감리 화면 최종 집계")
    s = get(a, f"/summary/{SITE}")
    c = s["counts"]
    check(c["anchored"] == 3 and c["missing"] == 1 and c["withheld"] == 1,
          "앵커링 3 · 미제출 1 · 제출 보류 1", json.dumps(c, ensure_ascii=False))
    check(c["chainOnly"] == 0 and c["mismatch"] == 0 and c["replaced"] == 0, "체인에만 있음·불일치·바꿔치기 0건")


# ----------------------------------------------------------------------
# main
# ----------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description="SafetyChain E2E 스모크 테스트")
    parser.add_argument("--keep", action="store_true", help="임시 폴더(로그 포함)를 지우지 않는다")
    parser.add_argument("--real-vision", action="store_true", help="대역 대신 실제 YOLO 판정 (gate/models/*.pt 필요)")
    parser.add_argument("--pass-image", type=Path, default=DEFAULT_PASS_IMAGE, help="안전모 착용 사진")
    parser.add_argument("--deny-image", type=Path, help="안전모 미착용 사진 (--real-vision에서 필수)")
    args = parser.parse_args()
    if args.real_vision:
        require_real_vision_inputs(args.pass_image, args.deny_image)
        PHOTOS["pass"] = args.pass_image.read_bytes()
        PHOTOS["deny"] = args.deny_image.read_bytes()

    require_tools()
    require_free_ports()
    ws = Path(tempfile.mkdtemp(prefix="safetychain-e2e-"))
    print(f"임시 작업 폴더: {ws}")
    audit_grace = 2

    try:
        step("0. 준비: 복사 · anvil · 배포 · 서비스 기동")
        prepare_workspace(ws, args.real_vision)
        print(f"  AI 모드: {'실제 YOLO' if args.real_vision else '대역(stub)'}")
        ensure_forge_deps(ws / "contracts")

        sender = Account.from_key(ANVIL_KEY0)
        device, supervisor, inspector, owner = (Account.create() for _ in range(4))
        rpc = f"http://127.0.0.1:{PORTS['anvil']}"

        start("anvil", ["anvil", "--port", str(PORTS["anvil"]), "--silent"], ws, dict(os.environ), ws)
        wait_rpc(PORTS["anvil"])
        address = deploy(ws / "contracts", rpc, key_hex(sender), device.address, supervisor.address,
                         key_hex(inspector), owner.address)
        print(f"  컨트랙트 배포: {address}")

        base = {**os.environ, "RPC_URL": rpc, "CONTRACT_ADDRESS": address, "DEMO_CONTROLS": "1",
                "PYTHONDONTWRITEBYTECODE": "1"}
        urls = {k: f"http://127.0.0.1:{p}" for k, p in PORTS.items()}
        envs = {
            "backend": {**base, "SENDER_PRIVATE_KEY": key_hex(sender), "DEVICE_ADDRESS": device.address,
                        "ADMIN_SIGNERS": f"{SUPERVISOR}:{key_hex(supervisor)}", "REVIEWER_SIGNING": "wallet",
                        "INSPECTOR_ACCOUNT": f"감리:{inspector.address}", "OWNER_ACCOUNT": f"발주처:{owner.address}",
                        "INSPECTOR_SIGNER": "", "OWNER_SIGNER": "", "INVESTIGATOR_TOKEN": "",
                        "WORKER_PSEUDONYM_KEY": secrets.token_hex(32), "PHOTO_KEY": secrets.token_hex(32),
                        "AUDIT_URL": urls["audit"], "GATE_URL": urls["gate"], "RECEIPT_TIMEOUT": "20",
                        "WORKER_AUTH": "required", "WORKER_ORIGINS": "https://*.trycloudflare.com"},
            "audit": {**base, "AUDIT_GRACE_SECONDS": str(audit_grace), "CONTRACTOR_URL": urls["backend"]},
            "gate": {**base, "DEVICE_PRIVATE_KEY": key_hex(device), "BACKEND_URL": urls["backend"],
                     "AUDIT_URL": urls["audit"]},
        }
        health = {"backend": "/reasons", "audit": "/health", "gate": "/health"}
        for name in ("backend", "audit", "gate"):
            start(name, [sys.executable, "-m", "uvicorn", "main:app", "--host", "127.0.0.1",
                         "--port", str(PORTS[name])], ws / name, envs[name], ws)
        for name in ("backend", "audit", "gate"):
            wait_ready(name, PORTS[name], health[name], ws)
        print("  서비스 3개 기동 완료")

        run_scenarios(ws, audit_grace)
    except Exception as e:  # noqa: BLE001 - 어떤 실패든 결과표와 로그 위치를 남긴다
        check(False, "스모크 테스트 진행", f"{type(e).__name__}: {e}")
        args.keep = True
    finally:
        stop_all()

    failed = [r for r in RESULTS if not r[0]]
    print(f"\n결과: {len(RESULTS) - len(failed)}/{len(RESULTS)} 통과")
    if args.keep:
        print(f"로그: {ws / 'logs'}")
    else:
        shutil.rmtree(ws, ignore_errors=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
