import { useState } from 'react'
import { isNonceUsedOnChain } from '../chain'
import { Card, ErrorText, Input, PageTitle, SecondaryButton, StatusBadge } from '../components/ui'
import { BACKEND_URL } from '../config'

type VerifyData = {
  onchain: boolean
  sigValid: boolean
  recordMatchesChain: boolean
  evidenceIntact: boolean
  modelHashMatch: boolean
  anchoredAt?: number
  overridden?: boolean
  overrideReason?: string | null
  overriddenBy?: string | null
}

export default function Verify() {
  const [nonce, setNonce] = useState('')
  const [data, setData] = useState<VerifyData | null>(null)
  const [directOnchain, setDirectOnchain] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function check() {
    setError(null)
    setData(null)
    setDirectOnchain(null)
    try {
      const res = await fetch(`${BACKEND_URL}/verify/${nonce}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.detail ?? '검증 실패')
      }
      setData(await res.json())

      // 백엔드를 거치지 않고 프론트가 직접 체인에 물어본 결과. 둘이 일치해야 신뢰할 수 있다.
      const direct = await isNonceUsedOnChain(nonce as `0x${string}`)
      setDirectOnchain(direct)
    } catch (e) {
      setError(e instanceof Error ? e.message : '알 수 없는 오류')
    }
  }

  return (
    <div className="space-y-5">
      <PageTitle title="검증뷰" subtitle="DB·사진 원본을 온체인 기록과 대조해 조작 여부를 확인합니다" />

      <div className="flex gap-2">
        <Input
          className="flex-1 font-mono text-sm"
          placeholder="0x... nonce"
          value={nonce}
          onChange={(e) => setNonce(e.target.value)}
        />
        <SecondaryButton onClick={check} disabled={!nonce}>
          검증
        </SecondaryButton>
      </div>

      {error && <ErrorText>{error}</ErrorText>}

      {data && (
        <Card>
          <StatusBadge ok={data.onchain} label="온체인 기록 존재 (nonce 소진)" />
          <StatusBadge ok={data.sigValid} label="서명 검증 (승인 등록된 게이트 기기)" />
          <StatusBadge ok={data.recordMatchesChain} label="DB 판정 결과 = 온체인 기록" />
          <StatusBadge ok={data.evidenceIntact} label="검사 사진 원본 무결 (SHA-256 일치)" />
          <StatusBadge ok={data.modelHashMatch} label="모델 해시 일치 (AI 모델 안 바뀜)" />
          {data.anchoredAt ? (
            <p className="text-xs text-ink-muted">
              블록 기록 시각: {new Date(data.anchoredAt * 1000).toLocaleString()} (서명 시각이 아닌 블록 시각 기준)
            </p>
          ) : null}
          {data.overridden && (
            <p className="text-xs bg-safety-yellow/20 border-2 border-charcoal p-2.5 text-ink">
              감독자 수동 처리: {data.overriddenBy} · 사유: {data.overrideReason}
            </p>
          )}
          {directOnchain !== null && (
            <p className="text-xs text-ink-muted pt-1 border-t-2 border-charcoal/10 mt-1 pt-3">
              프론트가 백엔드 없이 체인에 직접 물어본 결과: nonce 소진 = {directOnchain ? 'true' : 'false'}{' '}
              {directOnchain === data.onchain ? '(백엔드 응답과 일치 ✅)' : '(불일치 ⚠️)'}
            </p>
          )}
        </Card>
      )}
    </div>
  )
}
