import { createWalletClient, custom, type Address, type Hex } from 'viem'
import { RPC_URL } from './config'

// 감리·발주처가 자기 지갑(MetaMask)으로 EIP-712 서명할 때 쓴다.
// 서버는 서명할 내용(typedData)만 내려주고, 서명은 지갑 안에서 만들어진다 → 서버는 감리·발주처 서명을 만들 수 없다.
// 가스는 시공사 릴레이가 내므로 지갑에 ETH가 없어도 된다.

type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }

declare global {
  interface Window {
    ethereum?: Eip1193
  }
}

export type TypedData = {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address }
  types: Record<string, { name: string; type: string }[]>
  primaryType: string
  message: Record<string, unknown>
}

function provider(): Eip1193 {
  if (!window.ethereum) throw new Error('MetaMask 같은 지갑이 없습니다. 지갑 확장 프로그램을 설치하고 다시 시도하세요')
  return window.ethereum
}

export async function connectWallet(): Promise<Address> {
  const accounts = (await provider().request({ method: 'eth_requestAccounts' })) as Address[]
  if (!accounts?.length) throw new Error('지갑 계정을 가져오지 못했습니다')
  return accounts[0]
}

// 지갑 네트워크를 서명 도메인의 체인(Sepolia 등)으로 맞춘다. 서명만 하므로 잔액은 필요 없다
async function ensureChain(chainId: number) {
  const eth = provider()
  const current = parseInt((await eth.request({ method: 'eth_chainId' })) as string, 16)
  if (current === chainId) return
  const hex = `0x${chainId.toString(16)}`
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] })
  } catch (e) {
    if ((e as { code?: number }).code !== 4902) throw e
    await eth.request({
      method: 'wallet_addEthereumChain',
      params: [{ chainId: hex, chainName: `SafetyChain ${chainId}`, rpcUrls: [RPC_URL], nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 } }],
    })
  }
}

export async function signTyped(td: TypedData): Promise<{ address: Address; signature: Hex }> {
  const address = await connectWallet()
  await ensureChain(td.domain.chainId)
  const client = createWalletClient({ account: address, transport: custom(provider()) })
  const signature = await client.signTypedData({
    account: address,
    domain: td.domain,
    types: td.types,
    primaryType: td.primaryType,
    message: td.message,
  })
  return { address, signature }
}

export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
