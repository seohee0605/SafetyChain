import { useEffect, useState } from 'react'
import { Card, ErrorText, Input, PageTitle, PrimaryButton, SecondaryButton, Select, StepHeading } from '../components/ui'
import { BACKEND_URL } from '../config'

type Admin = { name: string; address: string }

type CheckInRow = {
  nonce: string
  txHash: string
  helmetPass: boolean
  shoesPass: boolean
  alcoholPass: boolean
  timestamp: number
}

type SiteRecordRow = {
  nonce: string
  txHash: string
  processSummary: string
  hazardsControlled: boolean
  timestamp: number
}

type CaseBundle = { caseId: string; siteRecords: SiteRecordRow[]; checkIns: CheckInRow[] }

type ReviewRow = {
  nonce: string
  txHash: string
  reviewResult: boolean
  reviewedSiteRecordNonces: string[]
  reviewedCheckinNonces: string[]
  adminName: string
  timestamp: number
}

const today = () => new Date().toISOString().slice(0, 10)

// 감독자 최종 검토·서명: 위험성평가(SiteRecord)와 근로자 검사(CheckIn)를 caseId로
// 하나로 묶어서 보여주고, 감독자가 그 범위 전체를 검토했다는 서명을 온체인에 남긴다.
export default function CaseReview() {
  const [admins, setAdmins] = useState<Admin[]>([])
  const [adminName, setAdminName] = useState('')
  const [siteId, setSiteId] = useState('')
  const [workDate, setWorkDate] = useState(today())
  const [bundle, setBundle] = useState<CaseBundle | null>(null)
  const [reviews, setReviews] = useState<ReviewRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    fetch(`${BACKEND_URL}/admins`)
      .then((res) => res.json())
      .then((list: Admin[]) => {
        setAdmins(list)
        if (list.length > 0) setAdminName(list[0].name)
      })
      .catch(() => {})
  }, [])

  async function loadCase() {
    if (!siteId || !workDate) return
    setError(null)
    const [caseRes, reviewRes] = await Promise.all([
      fetch(`${BACKEND_URL}/case/${encodeURIComponent(siteId)}/${workDate}`),
      fetch(`${BACKEND_URL}/case/reviews/${encodeURIComponent(siteId)}/${workDate}`),
    ])
    if (caseRes.ok) setBundle(await caseRes.json())
    if (reviewRes.ok) setReviews(await reviewRes.json())
  }

  async function submitReview(reviewResult: boolean) {
    setError(null)
    setLoading(true)
    try {
      const res = await fetch(`${BACKEND_URL}/case/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId, workDate, adminName, reviewResult }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.detail ?? '제출 실패')
      }
      await loadCase()
    } catch (e) {
      setError(e instanceof Error ? e.message : '알 수 없는 오류')
    } finally {
      setLoading(false)
    }
  }

  const hasRecords = bundle && (bundle.siteRecords.length > 0 || bundle.checkIns.length > 0)

  return (
    <div className="space-y-5">
      <PageTitle
        title="케이스 검토 · 최종 서명"
        subtitle="같은 현장·같은 작업일의 위험성평가와 근로자 검사를 하나로 묶어 감독자가 최종 확인합니다"
      />

      <Card>
        <StepHeading step={1}>케이스 조회</StepHeading>
        <div className="space-y-2.5">
          <Input placeholder="현장 ID" value={siteId} onChange={(e) => setSiteId(e.target.value)} />
          <Input type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)} />
          <SecondaryButton onClick={loadCase} disabled={!siteId || !workDate}>
            조회
          </SecondaryButton>
        </div>
      </Card>

      {bundle && (
        <Card>
          <StepHeading step={2}>이 케이스에 걸린 기록</StepHeading>
          <p className="text-xs font-mono break-all text-ink-muted">caseId: {bundle.caseId}</p>

          <div>
            <p className="font-display font-bold uppercase text-sm text-charcoal mb-2">
              위험성평가 ({bundle.siteRecords.length}건)
            </p>
            {bundle.siteRecords.length === 0 && <p className="text-sm text-ink-muted">없음</p>}
            {bundle.siteRecords.map((r) => (
              <div key={r.nonce} className="border-2 border-charcoal/20 p-2.5 mb-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-ink">{r.processSummary}</span>
                  <span className={r.hazardsControlled ? 'text-hazard-green font-semibold' : 'text-hazard-red font-semibold'}>
                    {r.hazardsControlled ? '조치완료' : '미조치'}
                  </span>
                </div>
              </div>
            ))}
          </div>

          <div>
            <p className="font-display font-bold uppercase text-sm text-charcoal mb-2">
              근로자 검사 ({bundle.checkIns.length}건)
            </p>
            {bundle.checkIns.length === 0 && <p className="text-sm text-ink-muted">없음</p>}
            {bundle.checkIns.map((c) => {
              const allPassed = c.helmetPass && c.shoesPass && c.alcoholPass
              return (
                <div key={c.nonce} className="border-2 border-charcoal/20 p-2.5 mb-2 text-sm flex justify-between">
                  <span className="text-ink-muted font-mono text-xs">{c.nonce.slice(0, 10)}...</span>
                  <span className={allPassed ? 'text-hazard-green font-semibold' : 'text-hazard-red font-semibold'}>
                    {allPassed ? '통과' : '미통과'}
                  </span>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {bundle && (
        <Card>
          <StepHeading step={3}>감독자 최종 검토</StepHeading>
          <Select value={adminName} onChange={(e) => setAdminName(e.target.value)}>
            {admins.length === 0 && <option value="">등록된 안전관리자 없음</option>}
            {admins.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
              </option>
            ))}
          </Select>
          <p className="text-xs text-ink-muted">
            지금 위에 보이는 위험성평가·검사 기록 전체를 검토 범위로 고정해서 서명합니다. 서명 이후 추가되는
            기록은 이 서명에 포함되지 않습니다.
          </p>
          <div className="flex gap-2">
            <PrimaryButton onClick={() => submitReview(true)} disabled={!hasRecords || !adminName || loading} className="flex-1">
              {loading ? '서명 중...' : '승인 서명'}
            </PrimaryButton>
            <SecondaryButton onClick={() => submitReview(false)} disabled={!hasRecords || !adminName || loading} className="flex-1">
              보류
            </SecondaryButton>
          </div>
        </Card>
      )}

      {error && <ErrorText>{error}</ErrorText>}

      {reviews.length > 0 && (
        <div className="space-y-2.5">
          <h2 className="font-display font-bold uppercase tracking-wide text-charcoal text-lg">검토 이력</h2>
          {reviews.map((r) => (
            <Card key={r.nonce}>
              <div className="flex justify-between items-center">
                <span className="text-sm text-ink-muted">{new Date(r.timestamp * 1000).toLocaleString()}</span>
                <span
                  className={`text-xs font-display font-bold uppercase px-2.5 py-1 border-2 border-charcoal text-white ${
                    r.reviewResult ? 'bg-hazard-green' : 'bg-hazard-red'
                  }`}
                >
                  {r.reviewResult ? '승인' : '보류'}
                </span>
              </div>
              <p className="text-xs text-ink-muted">
                검토자: {r.adminName} · 위험성평가 {r.reviewedSiteRecordNonces.length}건 · 검사{' '}
                {r.reviewedCheckinNonces.length}건
              </p>
              <p className="text-xs font-mono break-all text-ink-muted">tx: {r.txHash}</p>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
