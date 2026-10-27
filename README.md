# SafetyChain

건설현장 출입 게이트에서 측정한 안전 검사 결과를, **기기 서명 + 온체인 앵커링**으로
누구도 사후에 조작하거나 삭제할 수 없게 만드는 신뢰 레이어입니다.

## 현재 상태

이 저장소는 해커톤 1차 서류 심사 제출을 위해 구현한 프로토타입입니다.
본선 진출 시 멘토링 기간 동안 다음을 검토·개선할 계획입니다.

- **라이선스**: 안전모 판정에 쓰는 Ultralytics YOLO는 AGPL-3.0입니다. 네트워크 서비스로
  제공할 경우 전체 소스 공개 또는 Enterprise 라이선스가 필요한데, 본 저장소는 이미
  Public으로 공개되어 있어 현재는 조건을 충족합니다.
- **안전화 탐지**: 공개된 안전화 전용 탐지 모델을 찾지 못해 색상 휴리스틱으로 대체해둔
  상태입니다 (`backend/vision.py` 참고). 정확도 개선이 필요합니다.
- 그 외 인프라(테스트넷 선택, DB, 배포 구성 등)는 제약 안에서 고른 조합이라,
  본선 진출 후 실사용 규모에 맞게 재검토할 수 있습니다.

## 왜 만들었나

건설현장의 안전검사·위험성평가 기록은 사고가 발생한 뒤에 사후적으로 다시 작성되거나
수정되는 경우가 반복적으로 지적됩니다. 종이·엑셀·사내 시스템 기반 기록은 관리자가
사후에 얼마든지 고쳐 쓸 수 있어, "그 시점에 실제로 그렇게 기록돼 있었는가"를 증명할
방법이 없습니다.

SafetyChain은 안전모·안전화·음주 검사 결과, 일일 위험성평가, 감독자 최종 승인까지
전부 기기 서명(EIP-712) 후 온체인에 앵커링해서 이 문제를 구조적으로 막습니다.

## 절대 원칙

1. **감시 대상은 노동자가 아니라 회사다** — 개인을 지목하는 UI를 만들지 않는다
2. **음주 측정 수치는 온체인·로그 어디에도 남기지 않는다** — `alcoholPass: bool`만 저장
3. **실명·연락처는 온체인에 절대 올리지 않는다** — `workerId = HMAC-SHA256(비밀키, 사번|현장|작업일)`
   날짜별 가명만 온체인에 가서 장기간 출근 패턴이 이어지지 않고, 실명 매핑은 오프체인 SQLite에만 존재

## 아키텍처

```
[작업자] → QR(1회용 nonce) 발급 → [키오스크 웹캠] → [게이트 기기 서비스] YOLO 안전모·안전화 판정
    → 게이트 기기 키로 EIP-712 서명 (판정 결과 + 모델 해시 + 사진 해시 + QR 유효기간 + 기기 일련번호)
    → 감리 감사 저장소로 사본 전송 → 시공사 릴레이가 [SafetyGate 컨트랙트]에 제출
    → 컨트랙트가 출입 상태(허가·불합격·보류·지연·의심)를 정함 → 확정된 뒤에만 게이트 결과 표시
    → 보호구 불합격이면 [감독자] 사유 코드와 함께 수동 처리 (음주 불합격은 불가)

[감독자] 위험성평가 작성 → 원문은 SQLite, 해시만 온체인 (SiteRecord)

[감리 감사] 게이트 원본 · 시공사 DB · 블록체인 3자 대조 → 미제출·바꿔치기·DB 조작 표시
[예외 출입] 게이트 고장·응급 시 감독자 서명 + 감리(또는 발주처)가 자기 지갑으로 공동 서명

[케이스 확정] 현장·작업일 단위
    시공사 감독자 제출 → 감리 승인 → 발주처 승인 = 확정 (감리·발주처는 각자 MetaMask로 서명, 서버는 키 없음)
    반려(사유 코드) 시 보완 후 재제출, 모든 이력이 온체인에 남음
```

### 역할 (컨트랙트가 강제)

| 역할 | 누구 | 서명할 수 있는 것 |
|---|---|---|
| `CONTRACTOR_ADMIN_ROLE` | 시공사 운영 관리자 (릴레이) | 서명자 등록 제안, 비상 해제 |
| `GATE_DEVICE_ROLE` | 게이트 기기 | 체크인만 |
| `SUPERVISOR_ROLE` | 시공사 현장 감독자 | 위험성평가, 수동 처리, 케이스 제출 |
| `INSPECTOR_ROLE` | 감리 | 서명자 등록 승인, 케이스 1차 승인/반려 |
| `OWNER_ROLE` | 발주처 | 서명자 등록 승인, 케이스 최종 승인/반려 |

- `DEFAULT_ADMIN_ROLE`은 아무에게도 없어서 `grantRole`로 역할을 임의로 줄 수 없습니다.
- 게이트 기기·감독자는 시공사가 제안하고 감리 또는 발주처가 승인 서명을 해야 등록됩니다.
- 출입 기록은 거부 대신 저장 후 분류합니다: 서명 후 10분 이내 정상, 24시간까지는 지연 도착(감사용, 출입 근거 X),
  그 이상이나 1분 넘는 미래 시각은 거부(`StaleTimestamp`). 위험성평가·수동 처리·케이스 승인은 1시간 안에 제출해야 합니다.
- 당일(KST) 위험성평가가 체인에 없으면 출입 기록은 "평가 전 보류"로 남고, 감독자 수동 처리로도 풀 수 없습니다.
- 게이트 기기는 기록마다 일련번호(`deviceSeq`)를 서명합니다. 체인은 기기별 빠진 번호(`missingCount`)를 공개하고,
  서명자 해제는 사유 코드·해제 시점 번호와 함께 이력(`getRevocations`)으로 남습니다.
- 검증뷰는 DB 원본·사진을 DB끼리가 아니라 온체인 저장값과 대조합니다.

## 기술 스택

| 레이어 | 스택 |
|---|---|
| 컨트랙트 | Solidity 0.8.24 + Foundry + OpenZeppelin AccessControl |
| 체인 | Anvil (개발) / Sepolia (데모) |
| 백엔드 | Python 3.11 + FastAPI + web3.py + eth-account (시공사 백엔드·게이트 서비스·감사 저장소 3개) |
| DB | SQLite |
| 프론트 | Vite + React + TypeScript + viem + Tailwind |
| AI | Ultralytics YOLO 사전학습 모델 (파인튜닝 없음) |

## 폴더 구조

```
safetychain/
├─ contracts/          # Foundry
│  ├─ src/SafetyGate.sol
│  ├─ test/SafetyGate.t.sol
│  └─ script/Deploy.s.sol
├─ backend/            # 시공사 백엔드 (포트 8000): QR·릴레이·위험성평가·케이스. 게이트 기기 키 없음
│  ├─ main.py
│  ├─ chain.py         # web3 연동 + EIP-712 서명 + 릴레이
│  └─ db.py            # SQLite
├─ gate/               # 게이트 기기 서비스 (포트 8200): 기기 키·일련번호·YOLO
│  ├─ main.py
│  └─ vision.py        # YOLO 추론 (가중치는 gate/models/)
├─ audit/              # 감리 감사 저장소 (포트 8100): 3자 대조
└─ frontend/           # Vite + React
   └─ src/pages/{Gate,SiteRecord,CaseReview,Dashboard,Audit,Verify,Worker}.tsx
```

## Sepolia 배포·데모 준비 순서

1. **지갑 준비**: MetaMask에 감리용·발주처용 계정을 하나씩 만든다 (ETH 필요 없음, 서명만 함).
   릴레이 계정(배포·가스 지불)에만 Sepolia ETH를 넣는다.
2. **배포**: 위 "1. 컨트랙트"의 명령을 `--rpc-url <Sepolia RPC>`로 실행. `INSPECTOR_ADDRESS`·`OWNER_ADDRESS`에 1번 MetaMask 주소.
   출력된 `SafetyGate deployed at:` 주소를 적어 둔다. 감리·발주처 주소는 배포 때 고정되어 바꿀 수 없다.
3. **ABI·주소 반영**: `contracts/out/SafetyGate.sol/SafetyGate.json`의 `abi`를 `backend/abi`, `audit/abi`, `frontend/src/abi`에 복사
   (이 저장소에는 이미 최신 ABI가 들어 있음). 새 주소를 `backend/.env`, `gate/.env`, `audit/.env`의 `CONTRACT_ADDRESS`와
   `frontend/src/config.ts`의 `CONTRACT_ADDRESS`, `RPC_URL`에 넣는다.
4. **환경 변수**: `backend/.env`에 `REVIEWER_SIGNING=wallet`, `INSPECTOR_ACCOUNT=감리:<주소>`, `OWNER_ACCOUNT=발주처:<주소>`,
   `DEVICE_ADDRESS`. `INSPECTOR_SIGNER`·`OWNER_SIGNER`·`DEVICE_PRIVATE_KEY`는 지운다. 기기 키는 `gate/.env`에만.
5. **서비스 실행**: 백엔드(8000) · 감사 저장소(8100) · 게이트(8200) · 프론트(5173).
6. **서명자 승인**: 감리 감사 탭 → 현장 ID 입력 → "지갑 서명 대기"에서 게이트 기기·감독자 등록을 감리 MetaMask로 승인.
   승인 전에는 게이트 검사가 `MissingRole`로 거부된다.
7. **리허설**: 위험성평가 → 게이트 검사 → 케이스 제출 → 감리 지갑 승인 → 발주처 지갑 승인,
   예외 출입 요청 → 감리 감사 탭에서 지갑 공동 서명, 릴레이 중단 → 감리 화면 누락 표시.
8. **백업**: 데모 중 지갑 문제가 생기면 `backend/.env`를 `REVIEWER_SIGNING=server`로 바꾸고
   `INSPECTOR_SIGNER`·`OWNER_SIGNER`에 키를 넣어 서버 서명으로 진행할 수 있다 (화면에 "백업 모드"로 표시됨).

## 로컬 실행

### 1. 컨트랙트

```bash
cd contracts
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts --no-git
anvil                                   # 별도 터미널에서 로컬 체인 실행
forge test                              # 92개 테스트

# 배포 + 게이트 기기/감독자 등록 "제안" (승인은 배포 후 감리가 감리 감사 화면에서 지갑으로)
export DEVICE_ADDRESS=0x...             # 게이트 기기 주소 (gate/.env의 DEVICE_PRIVATE_KEY 주소)
export ADMIN_SIGNER_ADDRESSES=0x...     # 감독자 주소(콤마)
export INSPECTOR_ADDRESS=0x...          # 감리 MetaMask 주소 (키는 넘기지 않음)
export OWNER_ADDRESS=0x...              # 발주처 MetaMask 주소
forge script script/Deploy.s.sol:DeployScript --rpc-url http://127.0.0.1:8545 --broadcast --private-key <릴레이 키>
# (로컬 테스트용) INSPECTOR_ADDRESS 대신 INSPECTOR_PRIVATE_KEY를 주면 스크립트가 승인까지 한다
```

### 2. 시공사 백엔드

```bash
cd backend
pip install -r requirements.txt
cp .env.example .env                    # CONTRACT_ADDRESS, 각 역할 키 (SENDER_PRIVATE_KEY = 배포한 릴레이 키)
uvicorn main:app --reload               # 포트 8000
```

게이트 기기 키(`DEVICE_PRIVATE_KEY`)는 이제 `gate/.env`에만 넣고, 여기에는 `DEVICE_ADDRESS`만 둡니다.
사고 조사용 열람 API를 쓰려면 `INVESTIGATOR_TOKEN`을 채웁니다 (비우면 꺼짐). 검사 사진은 암호화돼 저장됩니다.

### 2-1. 게이트 기기 서비스

```bash
cd gate
pip install -r requirements.txt
cp .env.example .env                    # CONTRACT_ADDRESS, DEVICE_PRIVATE_KEY
mv ../backend/models/*.pt models/       # 예전에 backend/models에 받아둔 YOLO 가중치를 옮김
uvicorn main:app --port 8200
```

키오스크(게이트 화면)는 시공사 백엔드가 아니라 이 서비스로 검사를 보냅니다.

### 3. 감리 감사 저장소

시공사 백엔드와 별도 프로세스·별도 DB로 띄우는 감리 쪽 서비스입니다. 게이트가 서명한 기록 사본을
체인 제출 전에 직접 받아 보관하고, 체인 값과 대조해 미제출·바꿔치기를 드러냅니다.

```bash
cd audit
pip install -r requirements.txt
cp .env.example .env                    # CONTRACT_ADDRESS (시연 때는 AUDIT_GRACE_SECONDS=30 권장)
uvicorn main:app --port 8100
```

백엔드 `.env`의 `AUDIT_URL`이 이 주소를 가리켜야 합니다. `DEMO_CONTROLS=1`이면 감리 감사 화면에서
릴레이 중단·불합격만 누락·기기 해제/재등록을 시연할 수 있습니다.

### 4. 프론트엔드

```bash
cd frontend
npm install
npm run dev                             # http://localhost:5173
```

### 5. 근로자 앱을 폰으로 열기 (같은 와이파이)

```bash
cd backend && uvicorn main:app --host 0.0.0.0 --reload
cd frontend && npm run dev -- --host
```

폰 브라우저에서 `http://<노트북 IP>:5173/#/worker` 를 열면 근로자 앱(동의 → 출입 QR → 내 기록)이 뜹니다.
게이트 화면은 `#/gate`, 데모 영상용 준비 사진 모드는 `?demo` 를 붙여서 엽니다 (`http://localhost:5173/?demo#/gate`).

## 주요 기능

- **근로자 앱**: 개인정보·민감정보(사진·음주 통과 여부) 별도 동의, 동의 없으면 QR 발급 안 함. 1회용 출입 QR, 내 출입 기록
- **게이트 키오스크**: 처리 단계(검사 → 기기 서명 → 블록체인 기록 → 확정) 표시 후 전체 화면 초록(허용)/빨강(불가)/노랑(감독자 확인)
- **게이트 체크인**: QR(1회용, 발급받은 작업자만 사용 가능) → 촬영 → YOLO 판정 → 기기 서명 → 온체인 기록
- **수동 처리(Manual Override)**: 보호구 불합격만, 감독자 서명 + 사유 코드, 1회만. 현장 통계에 집계
- **일일 위험성평가 앵커링**: 원문은 오프체인, 해시·조치완료 여부만 온체인
- **케이스 3단계 확정**: 시공사 제출 → 감리 → 발주처, 제출 범위(scopeHash) 그대로만 승인 가능, 반려 이력 보존
- **대시보드**: 무사고 일수, 최근 7일 검사율 추이, 불합격·수동 처리 비율 (검사 수치는 온체인 기록 기준)
- **검증뷰**: 서명·DB 기록·사진·모델 해시를 온체인 값과 대조
