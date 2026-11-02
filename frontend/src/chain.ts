import { createPublicClient, decodeFunctionData, http, keccak256, stringToHex, type Hex } from 'viem'
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

// 게이트 판정 화면 하단 띠: 이 기록이 들어간 블록 번호와 블록 시각
export async function getTxBlock(txHash: `0x${string}`): Promise<{ blockNumber: bigint; timestamp: number }> {
  const receipt = await client.getTransactionReceipt({ hash: txHash })
  const block = await client.getBlock({ blockNumber: receipt.blockNumber })
  return { blockNumber: receipt.blockNumber, timestamp: Number(block.timestamp) }
}

// 백엔드 chain.case_id_hash와 같은 값: keccak256("현장ID|작업일자")
export function caseIdOf(siteId: string, workDate: string): `0x${string}` {
  return keccak256(stringToHex(`${siteId}|${workDate}`))
}

// 검증 화면: 붙여 넣은 값이 기록번호(tx 해시)면 그 트랜잭션 입력을 풀어 검증 코드(nonce)와 체인에 들어간 값을 꺼낸다.
// 트랜잭션이 없으면 null (그 값을 검증 코드로 보고 그대로 조회한다)
export type DecodedRecord =
  | { kind: 'checkin'; nonce: Hex; data: Record<string, unknown>; blockNumber: bigint; viaOverride: boolean }
  | { kind: 'site'; nonce: Hex; data: Record<string, unknown>; blockNumber: bigint }

export async function decodeRecordTx(txHash: Hex): Promise<DecodedRecord | null> {
  const tx = await client.getTransaction({ hash: txHash }).catch(() => null)
  if (!tx || !tx.blockNumber) return null
  const { functionName, args } = decodeFunctionData({ abi, data: tx.input })
  const first = (args?.[0] ?? {}) as Record<string, unknown>
  if (functionName === 'submitCheckIn') return { kind: 'checkin', nonce: first.nonce as Hex, data: first, blockNumber: tx.blockNumber, viaOverride: false }
  if (functionName === 'submitOverride')
    return { kind: 'checkin', nonce: first.checkInNonce as Hex, data: first, blockNumber: tx.blockNumber, viaOverride: true }
  if (functionName === 'submitSiteRecord') return { kind: 'site', nonce: first.nonce as Hex, data: first, blockNumber: tx.blockNumber }
  return null
}
