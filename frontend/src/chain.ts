import { createPublicClient, http } from 'viem'
import { foundry } from 'viem/chains'
import abi from './abi/SafetyGate.json'
import { CONTRACT_ADDRESS, RPC_URL } from './config'

// 지갑 연결은 쓰지 않는다 (CLAUDE.md: 지갑 연결 UI 금지). 읽기 전용 public client로
// 백엔드를 거치지 않고 프론트가 직접 체인에 물어봐서 "누구도 조작할 수 없다"를 보여준다.
const client = createPublicClient({
  chain: foundry,
  transport: http(RPC_URL),
})

export async function isNonceUsedOnChain(nonce: `0x${string}`): Promise<boolean> {
  return client.readContract({
    address: CONTRACT_ADDRESS,
    abi,
    functionName: 'isNonceUsed',
    args: [nonce],
  }) as Promise<boolean>
}
