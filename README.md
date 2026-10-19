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
3. **실명·연락처는 온체인에 절대 올리지 않는다** — `workerId = keccak256(사번 || siteSalt)`
   가명 식별자만 온체인에 가고, 실명 매핑은 오프체인 SQLite에만 존재

## 아키텍처

```
[작업자] → QR(1회용 nonce) 발급 → [게이트 웹캠] YOLO 안전모·안전화 판정
    → [게이트 기기] EIP-712 서명 (판정 결과 + 모델 해시 + 사진 해시)
    → [SafetyGate 컨트랙트] 온체인 앵커링 → 확정된 뒤에만 게이트 결과 표시
    → 보호구 불합격이면 [감독자] 사유 코드와 함께 수동 처리 (음주 불합격은 불가)

[감독자] 위험성평가 작성 → 원문은 SQLite, 해시만 온체인 (SiteRecord)

[케이스 확정] 현장·작업일 단위
    시공사 감독자 제출 → 감리 승인 → 발주처 승인 = 확정
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
- 서명 시각이 블록 시각 기준 10분 전 ~ 1분 후 밖이면 거부됩니다 (`StaleTimestamp`).
- 검증뷰는 DB 원본·사진을 DB끼리가 아니라 온체인 저장값과 대조합니다.

## 기술 스택

| 레이어 | 스택 |
|---|---|
| 컨트랙트 | Solidity 0.8.24 + Foundry + OpenZeppelin AccessControl |
| 체인 | Anvil (개발) / Sepolia (데모) |
| 백엔드 | Python 3.11 + FastAPI + web3.py + eth-account + ultralytics |
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
├─ backend/            # FastAPI
│  ├─ main.py          # 라우트
│  ├─ chain.py         # web3 연동 + EIP-712 서명
│  ├─ vision.py        # YOLO 추론
│  └─ db.py            # SQLite
└─ frontend/           # Vite + React
   └─ src/pages/{Gate,SiteRecord,CaseReview,Dashboard,Verify}.tsx
```

## 로컬 실행

### 1. 컨트랙트

```bash
cd contracts
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts --no-git
anvil                                   # 별도 터미널에서 로컬 체인 실행
forge test                              # 46개 테스트

# 배포 + 게이트 기기/감독자 등록 (감리 키로 승인 서명까지 스크립트에서 처리)
export DEVICE_ADDRESS=0x...
export ADMIN_SIGNER_ADDRESSES=0x...,0x...
export INSPECTOR_PRIVATE_KEY=0x...
export OWNER_ADDRESS=0x...
forge script script/Deploy.s.sol:DeployScript --rpc-url http://127.0.0.1:8545 --broadcast --private-key <릴레이 키>
```

### 2. 백엔드

```bash
cd backend
pip install -r requirements.txt
cp .env.example .env                    # CONTRACT_ADDRESS, 각 역할 키 채우기 (SENDER_PRIVATE_KEY = 배포한 릴레이 키)
uvicorn main:app --reload
```

### 3. 프론트엔드

```bash
cd frontend
npm install
npm run dev                             # http://localhost:5173
```

## 주요 기능

- **게이트 체크인**: QR(1회용, 발급받은 작업자만 사용 가능) → 촬영 → YOLO 판정 → 기기 서명 → 온체인 기록
- **수동 처리(Manual Override)**: 보호구 불합격만, 감독자 서명 + 사유 코드, 1회만. 현장 통계에 집계
- **일일 위험성평가 앵커링**: 원문은 오프체인, 해시·조치완료 여부만 온체인
- **케이스 3단계 확정**: 시공사 제출 → 감리 → 발주처, 제출 범위(scopeHash) 그대로만 승인 가능, 반려 이력 보존
- **대시보드**: 현장 단위 검사율·불합격·수동 처리 비율 (온체인 `getSiteStats`)
- **검증뷰**: 서명·DB 기록·사진·모델 해시를 온체인 값과 대조
