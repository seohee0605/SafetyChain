import { createPublicClient, http } from 'viem'
import { foundry } from 'viem/chains'
import abi from './abi/SafetyGate.json'
import { CONTRACT_ADDRESS, RPC_URL } from './config'

// 지갑 연결 없이 읽기 전용. 백엔드 안 거치고 프론트가 체인에 직접 물어보는 용도
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
