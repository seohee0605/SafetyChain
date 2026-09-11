# SafetyChain

건설현장 출입 게이트에서 측정한 안전 검사 결과를, **기기 서명 + 온체인 앵커링**으로
누구도 사후에 조작하거나 삭제할 수 없게 만드는 신뢰 레이어입니다.

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
    → [기기] EIP-712 서명 → [SafetyGate 컨트랙트] 온체인 앵커링
    → [대시보드 / 검증뷰] 공개

[안전관리자] 위험성평가 작성 → 이름 선택 서명 → 온체인 앵커링 (SiteRecord)

[감독자] 케이스(caseId) 조회 → 검토 범위 고정 → 최종 서명 (CaseReview)
```

같은 현장·같은 작업일의 위험성평가(SiteRecord)와 근로자 체크인(CheckIn)은
`caseId = keccak256(siteId || workDate)`로 묶이고, 세 기록(CheckIn·SiteRecord·CaseReview)
전부 하나의 `usedNonces` 풀과 `registeredDevices`를 공유합니다.


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
forge install
anvil                                   # 별도 터미널에서 로컬 체인 실행
forge test                              # 22개 테스트 전체 통과 확인

# 배포 (.env 에 DEVICE_ADDRESS, ADMIN_SIGNER_ADDRESSES 설정 후)
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
```

### 2. 백엔드

```bash
cd backend
pip install -r requirements.txt
cp .env.example .env                    # RPC_URL, CONTRACT_ADDRESS 등 채우기
uvicorn main:app --reload
```

### 3. 프론트엔드

```bash
cd frontend
npm install
npm run dev                             # http://localhost:5173
```

## 주요 기능

- **게이트 체크인**: QR(1회용 nonce) 발급 → 촬영 → YOLO 판정 → 기기 서명 → 온체인 기록
- **일일 위험성평가 앵커링**: 공정·위험요인·조치내용은 오프체인, 해시·조치완료 여부만 온체인
- **관리자 서명 (무로그인 신원증명)**: 이름 선택만으로 사전 등록된 키로 서명
- **케이스 연결 + 감독자 최종 검토**: caseId로 위험성평가·검사를 묶고 감독자가 범위 고정 서명
- **검증뷰**: 서명 검증 · nonce 소진 확인 · 모델 해시 일치 확인
