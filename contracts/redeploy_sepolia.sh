#!/usr/bin/env bash
# Sepolia 재배포 (4차 멘토링 반영: Override 사유 4 "AI 저신뢰")
#
#   cd ~/Desktop/safetychain/dev && bash contracts/redeploy_sepolia.sh
#
# 하는 일
#   1) backend/.env에서 RPC_URL·릴레이 키·감리/발주처/기기/감독자 주소를 읽는다 (키는 화면에 출력하지 않음)
#   2) forge test → 릴레이 계정 잔액 확인 → 배포 + 게이트 기기·감독자 등록 "제안"
#   3) 새 ABI를 backend/abi, audit/abi, frontend/src/abi에 복사
#   4) 새 주소를 backend/.env, gate/.env, audit/.env, frontend/src/config.ts, README.md에 반영
# 배포 후 할 일: 서비스 4개를 다시 켜고, 감리 감사 탭에서 게이트 기기·감독자 등록을 감리 MetaMask로 승인
#               (승인 전에는 게이트 검사가 MissingRole로 거부된다)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
command -v forge >/dev/null || { echo "forge가 없다 (foundryup 필요)"; exit 1; }
command -v cast >/dev/null || { echo "cast가 없다 (foundryup 필요)"; exit 1; }

set -a; . backend/.env; set +a
: "${RPC_URL:?backend/.env에 RPC_URL 필요}"
: "${SENDER_PRIVATE_KEY:?backend/.env에 SENDER_PRIVATE_KEY(릴레이 키) 필요}"
OLD_ADDRESS="${CONTRACT_ADDRESS:-}"

export DEVICE_ADDRESS
export INSPECTOR_ADDRESS="${INSPECTOR_ACCOUNT##*:}"
export OWNER_ADDRESS="${OWNER_ACCOUNT##*:}"
ADMIN_ADDRS=()
IFS=',' read -ra ADMIN_ITEMS <<< "$ADMIN_SIGNERS"
for item in "${ADMIN_ITEMS[@]}"; do
  ADMIN_ADDRS+=("$(cast wallet address --private-key "${item##*:}")")
done
export ADMIN_SIGNER_ADDRESSES="$(IFS=','; echo "${ADMIN_ADDRS[*]}")"

CHAIN_ID="$(cast chain-id --rpc-url "$RPC_URL")"
[ "$CHAIN_ID" = "11155111" ] || { echo "Sepolia가 아니다 (chainId $CHAIN_ID). RPC_URL 확인"; exit 1; }
RELAY="$(cast wallet address --private-key "$SENDER_PRIVATE_KEY")"
BAL="$(cast balance "$RELAY" --rpc-url "$RPC_URL" --ether)"
echo "릴레이 계정 $RELAY 잔액 $BAL ETH"
echo "감리 $INSPECTOR_ADDRESS / 발주처 $OWNER_ADDRESS / 기기 $DEVICE_ADDRESS / 감독자 $ADMIN_SIGNER_ADDRESSES"
echo "기존 컨트랙트 $OLD_ADDRESS"
read -r -p "이 설정으로 Sepolia에 새로 배포할까? (y/N) " ok
[ "$ok" = "y" ] || { echo "취소"; exit 0; }

cd contracts
forge test
LOG="$(mktemp)"
# Sepolia는 상태 생성 가스가 로컬 추정보다 훨씬 크다(EIP-8037 재가격, CLAUDE.md 9절). 10/27 배포도 추정치의 8배로 성공
forge script script/Deploy.s.sol:DeployScript --rpc-url "$RPC_URL" --broadcast --private-key "$SENDER_PRIVATE_KEY" \
  --gas-estimate-multiplier "${GAS_MULTIPLIER:-800}" | tee "$LOG"
NEW_ADDRESS="$(grep -o 'SafetyGate deployed at: 0x[0-9a-fA-F]\{40\}' "$LOG" | awk '{print $4}')"
rm -f "$LOG"
[ -n "$NEW_ADDRESS" ] || { echo "배포 주소를 찾지 못했다. 위 로그 확인"; exit 1; }
cd "$ROOT"

python3 - "$NEW_ADDRESS" "$OLD_ADDRESS" <<'EOF'
import datetime, json, re, sys
from pathlib import Path
new, old = sys.argv[1], sys.argv[2]
today = datetime.date.today()
abi = json.loads(Path("contracts/out/SafetyGate.sol/SafetyGate.json").read_text())["abi"]
for p in ("backend/abi/SafetyGate.json", "audit/abi/SafetyGate.json", "frontend/src/abi/SafetyGate.json"):
    Path(p).write_text(json.dumps(abi, indent=2, ensure_ascii=False) + "\n")
    print("ABI 갱신:", p)
for p in ("backend/.env", "gate/.env", "audit/.env"):
    f = Path(p); t = f.read_text()
    t = re.sub(r"(?m)^CONTRACT_ADDRESS=.*$", f"CONTRACT_ADDRESS={new}", t)
    f.write_text(t); print("주소 갱신:", p)
f = Path("frontend/src/config.ts"); t = f.read_text()
t = re.sub(r"export const CONTRACT_ADDRESS = '0x[0-9a-fA-F]{40}'", f"export const CONTRACT_ADDRESS = '{new}'", t)
f.write_text(t); print("주소 갱신: frontend/src/config.ts")
f = Path("README.md"); t = f.read_text()
t2 = re.sub(r"- \*\*Sepolia\*\*: `0x[0-9a-fA-F]{40}` \([^)]*\)\.",
            f"- **Sepolia**: `{new}` ({today.month}/{today.day} 재배포: Override 사유 4 \"AI 저신뢰\" 추가. 이전 배포 `{old}`).", t, count=1)
if t2 != t:
    f.write_text(t2); print("주소 갱신: README.md")
EOF

echo
echo "새 컨트랙트: $NEW_ADDRESS  (https://sepolia.etherscan.io/address/$NEW_ADDRESS)"
echo "다음: 서비스 4개 재시작 → 감리 감사 탭에서 게이트 기기·감독자 등록을 감리 MetaMask로 승인"
