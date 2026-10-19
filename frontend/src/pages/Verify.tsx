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

type SiteVerify = {
  onchain: boolean
  sigValid: boolean
  contentIntact: boolean
  anchoredAt?: number
  submittedBy: string | null
}

type Mode = 'checkin' | 'site'

export default function Verify() {
  const [mode, setMode] = useState<Mode>('checkin')
  const [nonce, setNonce] = useState('')
  const [data, setData] = useState<VerifyData | null>(null)
  const [site, setSite] = useState<SiteVerify | null>(null)
  const [directOnchain, setDirectOnchain] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function check() {
    setError(null)
    setData(null)
    setSite(null)
    setDirectOnchain(null)
    try {
      const res = await fetch(`${BACKEND_URL}/verify/${mode === 'site' ? 'site/' : ''}${nonce}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.detail ?? '검증 실패')
      }
      if (mode === 'site') setSite(await res.json())
      else setData(await res.json())

      // 백엔드 안 거치고 체인에 직접 물어본 값 (백엔드 응답과 같아야 함)
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
        {(['checkin', 'site'] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`px-3 py-1.5 text-sm font-display font-bold uppercase border-2 border-charcoal ${
              mode === m ? 'bg-safety-yellow text-charcoal' : 'bg-white text-ink-muted'
            }`}
          >
            {m === 'checkin' ? '게이트 검사' : '위험성평가'}
          </button>
        ))}
      </div>

      <div className="flex gap-2">
        <Input
          className="flex-1 font-mono text-sm"
          placeholder="검증 코드 (0x로 시작)"
          value={nonce}
          onChange={(e) => setNonce(e.target.value)}
        />
        <SecondaryButton onClick={check} disabled={!nonce}>
          검증
        </SecondaryButton>
      </div>

      {error && <ErrorText>{error}</ErrorText>}

      {site && (
        <Card>
          <StatusBadge ok={site.onchain} label="블록체인에 기록돼 있음" />
          <StatusBadge ok={site.sigValid} label="등록된 감독자가 서명함" />
          <StatusBadge ok={site.contentIntact} label="위험성평가 원문이 바뀌지 않음" />
          {site.submittedBy && <p className="text-xs text-ink-muted">제출: {site.submittedBy}</p>}
          {directOnchain !== null && (
            <p className="text-xs text-ink-muted pt-3 border-t-2 border-charcoal/10">
              서버를 거치지 않고 블록체인에 직접 확인: {directOnchain ? '기록 있음' : '기록 없음'}{' '}
              {directOnchain === site.onchain ? '(서버 응답과 일치 ✅)' : '(서버 응답과 불일치 ⚠️)'}
            </p>
          )}
        </Card>
      )}

      {data && (
        <Card>
          <StatusBadge ok={data.onchain} label="블록체인에 기록돼 있음" />
          <StatusBadge ok={data.sigValid} label="승인 등록된 게이트 기기가 서명함" />
          <StatusBadge ok={data.recordMatchesChain} label="서버에 저장된 판정 = 블록체인 기록" />
          <StatusBadge ok={data.evidenceIntact} label="검사 사진 원본이 바뀌지 않음" />
          <StatusBadge ok={data.modelHashMatch} label="판정에 쓴 AI 모델이 그대로임" />
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
              서버를 거치지 않고 블록체인에 직접 확인: {directOnchain ? '기록 있음' : '기록 없음'}{' '}
              {directOnchain === data.onchain ? '(서버 응답과 일치 ✅)' : '(서버 응답과 불일치 ⚠️)'}
            </p>
          )}
        </Card>
      )}
    </div>
  )
}
