## SafetyChain 프론트엔드

Vite + React + TypeScript + Tailwind + viem. 지갑 연결 UI는 쓰지 않는다 (백엔드가 하드코딩 키로 서명).

```shell
npm install
npm run dev
```

`src/config.ts`에서 백엔드/RPC/컨트랙트 주소를 설정한다. 페이지 3개(`src/pages/`):

- `Gate.tsx` — 게이트 시뮬레이터 (QR 발급 → 웹캠 촬영 → 제출)
- `Dashboard.tsx` — 현장 집계 (개인 지목 없음)
- `Verify.tsx` — 온체인 검증 (백엔드 응답 + 프론트가 직접 체인에 물어본 결과 비교)
