import { useState } from 'react'
import { Card, ErrorText, Input, PageTitle, SecondaryButton } from '../components/ui'
import { BACKEND_URL } from '../config'

type DashboardData = {
  checkedCount: number
  uncheckedCount: number
  rate: number
  failedCount: number
  overrideCount: number
  overrideRate: number
}

// 설계 원칙: 감시 대상은 노동자가 아니라 회사다. 이 페이지는 현장 단위 집계만 보여주고
// 개인을 지목하는 화면(누가 검사를 안 받았는지)은 만들지 않는다.
// 불합격·수동 처리 건수는 온체인 집계(getSiteStats)라서 시공사가 DB에서 줄일 수 없다.
export default function Dashboard() {
  const [siteId, setSiteId] = useState('')
  const [data, setData] = useState<DashboardData | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setError(null)
    const res = await fetch(`${BACKEND_URL}/dashboard/${encodeURIComponent(siteId)}`)
    if (!res.ok) {
      setError('조회 실패')
      return
    }
    setData(await res.json())
  }

  return (
    <div className="space-y-5">
      <PageTitle title="현장 대시보드" subtitle="현장 단위 집계만 표시합니다 (개인 지목 없음)" />

      <div className="flex gap-2">
        <Input placeholder="현장 ID" value={siteId} onChange={(e) => setSiteId(e.target.value)} className="flex-1" />
        <SecondaryButton onClick={load} disabled={!siteId}>
          조회
        </SecondaryButton>
      </div>

      {error && <ErrorText>{error}</ErrorText>}

      {data && (
        <Card>
          <div className="flex justify-between items-baseline border-b-2 border-charcoal/10 pb-3">
            <span className="text-ink-muted uppercase font-display tracking-wide text-sm">검사 완료</span>
            <span className="text-3xl font-display font-extrabold text-charcoal">{data.checkedCount}명</span>
          </div>
          <div className="flex justify-between items-baseline border-b-2 border-charcoal/10 pb-3">
            <span className="text-ink-muted uppercase font-display tracking-wide text-sm">미검사 입장</span>
            <span className="text-3xl font-display font-extrabold text-hazard-red">{data.uncheckedCount}명</span>
          </div>
          <div className="flex justify-between items-baseline border-b-2 border-charcoal/10 pb-3">
            <span className="text-ink-muted uppercase font-display tracking-wide text-sm">AI·음주 불합격</span>
            <span className="text-3xl font-display font-extrabold text-charcoal">{data.failedCount}건</span>
          </div>
          <div className="flex justify-between items-baseline border-b-2 border-charcoal/10 pb-3">
            <span className="text-ink-muted uppercase font-display tracking-wide text-sm">감독자 수동 처리</span>
            <span className="text-3xl font-display font-extrabold text-hazard-red">
              {data.overrideCount}건
              <span className="text-sm text-ink-muted font-medium ml-1.5">
                (불합격의 {Math.round(data.overrideRate * 100)}%)
              </span>
            </span>
          </div>
          <div className="w-full bg-paper-dark h-4 border-2 border-charcoal overflow-hidden">
            <div className="bg-hazard-green h-full" style={{ width: `${Math.round(data.rate * 100)}%` }} />
          </div>
          <p className="text-right text-sm text-ink-muted font-medium">검사율 {Math.round(data.rate * 100)}%</p>
        </Card>
      )}
    </div>
  )
}
