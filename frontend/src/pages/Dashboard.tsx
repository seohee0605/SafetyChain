import { useState } from 'react'
import { Card, ErrorText, Input, PageTitle, SecondaryButton } from '../components/ui'
import { BACKEND_URL } from '../config'

type Daily = {
  date: string
  checked: number
  unchecked: number
  failed: number
  overrides: number
  held: number
  late: number
  rate: number | null
}

type DashboardData = {
  checkedCount: number
  uncheckedCount: number
  rate: number
  failedCount: number
  overrideCount: number
  overrideRate: number
  heldCount: number
  lateCount: number
  noIncidentDays: number | null
  noIncidentSince: 'incident' | 'firstRecord' | null
  lastIncidentDate: string | null
  daily: Daily[]
}

const pct = (v: number) => `${Math.round(v * 100)}%`

// 현장 단위 집계만. 누가 검사를 안 받았는지 같은 개인 지목 화면은 안 만든다.
// 검사·불합격·수동 처리 수와 일별 추이는 온체인 기록 기준이라 DB에서 줄일 수 없다.
export default function Dashboard() {
  const [siteId, setSiteId] = useState('')
  const [data, setData] = useState<DashboardData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [incidentDate, setIncidentDate] = useState(() => new Date().toISOString().slice(0, 10))

  async function load() {
    setError(null)
    const res = await fetch(`${BACKEND_URL}/dashboard/${encodeURIComponent(siteId)}`)
    if (!res.ok) {
      setError('조회 실패')
      return
    }
    setData(await res.json())
  }

  async function reportIncident() {
    if (!confirm(`${incidentDate}에 사고가 있었다고 기록할까요? 무사고 일수가 이 날짜부터 다시 계산됩니다.`)) return
    const res = await fetch(`${BACKEND_URL}/site/incident`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId, date: incidentDate }),
    })
    if (!res.ok) {
      setError('사고 기록 실패')
      return
    }
    await load()
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
        <>
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-hazard-green text-white border-2 border-charcoal p-5">
              <p className="text-sm uppercase font-display tracking-wide text-white/80">무사고</p>
              <p className="text-5xl font-display font-extrabold leading-none mt-1">
                {data.noIncidentDays ?? '-'}
                <span className="text-xl ml-1">일</span>
              </p>
              <p className="text-xs text-white/80 mt-2">
                {data.noIncidentSince === 'incident' && `마지막 사고 보고: ${data.lastIncidentDate}`}
                {data.noIncidentSince === 'firstRecord' && '사고 보고 없음 · 첫 출입 기록일부터'}
                {data.noIncidentSince === null && '아직 기록이 없어요'}
              </p>
            </div>
            <div className="bg-white border-2 border-charcoal p-5">
              <p className="text-sm uppercase font-display tracking-wide text-ink-muted">검사율</p>
              <p className="text-5xl font-display font-extrabold leading-none mt-1 text-charcoal">{pct(data.rate)}</p>
              <p className="text-xs text-ink-muted mt-2">
                검사 {data.checkedCount} · 미검사 {data.uncheckedCount}
              </p>
            </div>
          </div>

          <Card>
            <div className="flex justify-between items-baseline">
              <p className="font-display font-bold uppercase tracking-wide text-charcoal">최근 7일</p>
              <div className="flex gap-3 text-xs text-ink-muted">
                <span className="flex items-center gap-1"><span className="w-3 h-3 bg-hazard-green inline-block" />통과</span>
                <span className="flex items-center gap-1"><span className="w-3 h-3 bg-hazard-red inline-block" />불합격</span>
                <span className="flex items-center gap-1"><span className="w-3 h-3 bg-paper-dark border border-charcoal/30 inline-block" />미검사</span>
              </div>
            </div>
            <WeekChart daily={data.daily} />
          </Card>

          <Card>
            <div className="flex justify-between items-baseline border-b-2 border-charcoal/10 pb-3">
              <span className="text-ink-muted uppercase font-display tracking-wide text-sm">불합격 (누적)</span>
              <span className="text-3xl font-display font-extrabold text-hazard-red">{data.failedCount}건</span>
            </div>
            <div className="flex justify-between items-baseline">
              <span className="text-ink-muted uppercase font-display tracking-wide text-sm">감독자 수동 처리</span>
              <span className="text-3xl font-display font-extrabold text-charcoal">
                {data.overrideCount}건
                <span className="text-base text-ink-muted ml-2">(불합격의 {pct(data.overrideRate)})</span>
              </span>
            </div>
            <div className="flex justify-between items-baseline border-t-2 border-charcoal/10 pt-3">
              <span className="text-ink-muted uppercase font-display tracking-wide text-sm">위험성평가 전 출입 시도 (보류)</span>
              <span className="text-3xl font-display font-extrabold text-safety-orange">{data.heldCount}건</span>
            </div>
            <div className="flex justify-between items-baseline">
              <span className="text-ink-muted uppercase font-display tracking-wide text-sm">지연 도착 기록 (감사용)</span>
              <span className="text-3xl font-display font-extrabold text-charcoal">{data.lateCount}건</span>
            </div>
            <p className="text-xs text-ink-muted">보류·지연 기록도 검사 건수에는 포함되지만 출입 근거로는 쓰지 않습니다.</p>
          </Card>

          <details className="text-sm text-ink-muted">
            <summary className="cursor-pointer font-semibold select-none">사고 발생 기록 (무사고 일수 초기화)</summary>
            <div className="flex gap-2 mt-2">
              <Input type="date" value={incidentDate} onChange={(e) => setIncidentDate(e.target.value)} className="flex-1" />
              <SecondaryButton onClick={reportIncident}>기록</SecondaryButton>
            </div>
          </details>
        </>
      )}
    </div>
  )
}

function WeekChart({ daily }: { daily: Daily[] }) {
  const max = Math.max(1, ...daily.map((d) => d.checked + d.unchecked))
  return (
    <div className="grid grid-cols-7 gap-2 items-end pt-2">
      {daily.map((d) => {
        const passed = d.checked - d.failed
        const h = (n: number) => `${(n / max) * 160}px`
        return (
          <div key={d.date} className="flex flex-col items-center gap-1">
            <span className="text-xs font-semibold text-charcoal h-4">{d.rate === null ? '' : pct(d.rate)}</span>
            <div className="w-full flex flex-col-reverse border-b-2 border-charcoal" style={{ height: '160px' }}>
              {passed > 0 && <div className="bg-hazard-green" style={{ height: h(passed) }} title={`통과 ${passed}`} />}
              {d.failed > 0 && <div className="bg-hazard-red" style={{ height: h(d.failed) }} title={`불합격 ${d.failed}`} />}
              {d.unchecked > 0 && (
                <div className="bg-paper-dark border border-charcoal/20" style={{ height: h(d.unchecked) }} title={`미검사 ${d.unchecked}`} />
              )}
            </div>
            <span className="text-xs text-ink-muted">{d.date.slice(5).replace('-', '/')}</span>
            {d.overrides > 0 && <span className="text-[10px] text-ink-muted">수동 {d.overrides}</span>}
            {d.held > 0 && <span className="text-[10px] text-safety-orange">보류 {d.held}</span>}
            {d.late > 0 && <span className="text-[10px] text-ink-muted">지연 {d.late}</span>}
          </div>
        )
      })}
    </div>
  )
}
