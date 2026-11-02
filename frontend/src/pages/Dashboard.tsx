import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { DarkBox, hhmm, SitePicker, TitleBar } from '../components/kiosk'
import { ErrorText, Input, SecondaryButton } from '../components/ui'
import { AUDIT_URL, BACKEND_URL } from '../config'

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
  suspectCount: number
  emergencyCount: number
  noIncidentDays: number | null
  noIncidentSince: 'incident' | 'firstRecord' | null
  lastIncidentDate: string | null
  daily: Daily[]
}

// 날짜별 케이스(하루치 기록): 확정 상태와 그날 검사 목록 (수동 처리 사유별 집계, 오늘 반영된 기록에 씀)
type CaseCheckIn = { timestamp: number; overridden: boolean; overrideReason: string | null; entryStatus: string | null; helmetPass: boolean; shoesPass: boolean; alcoholPass: boolean }
type DayCase = {
  checkIns: CaseCheckIn[]
  state: { status: string; round: number }
  history: { action: string; actorName: string; anchoredAt: number; reason: string | null }[]
}
type AuditRecord = { deviceSeq: number; signedAt: number; audit: string }

const pct = (v: number) => `${Math.round(v * 100)}%`
const localDate = (sec: number) => new Date(sec * 1000).toLocaleDateString('sv-SE')
const dayLabel = (d: string) => `${d.slice(5).replace('-', '/')} ${'일월화수목금토'[new Date(`${d}T00:00:00`).getDay()]}`

// 하루 막대를 통과·지연·보류·차단으로 나눈다. 백엔드 일별 집계(온체인 기준)에서 계산:
// 차단 = 불합격 중 수동 처리로 통과되지 않은 것, 통과 = 나머지
function split(d: Daily) {
  const late = d.late
  const held = d.held
  const blocked = Math.max(0, d.failed - d.overrides)
  const pass = Math.max(0, d.checked - late - held - blocked)
  return { pass, late, held, blocked }
}

// 현장 단위 집계만. 누가 검사를 안 받았는지 같은 개인 지목 화면은 안 만든다. 목업 dashboard-mockup
export default function Dashboard() {
  const [siteId, setSiteId] = useState('')
  const [loadedSite, setLoadedSite] = useState<string | null>(null)
  const [data, setData] = useState<DashboardData | null>(null)
  const [cases, setCases] = useState<Record<string, DayCase>>({})
  const [audit, setAudit] = useState<AuditRecord[] | null>(null)
  const [detail, setDetail] = useState<'override' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [incidentDate, setIncidentDate] = useState(() => new Date().toISOString().slice(0, 10))

  const load = useCallback(async (site: string) => {
    setError(null)
    const res = await fetch(`${BACKEND_URL}/dashboard/${encodeURIComponent(site)}`)
    if (!res.ok) {
      setError('조회 실패')
      return
    }
    const d: DashboardData = await res.json()
    setData(d)
    setLoadedSite(site)
    // 날짜별 확정 상태·수동 처리 사유 (7일치)
    const entries = await Promise.all(
      d.daily.map((day) =>
        fetch(`${BACKEND_URL}/case/${encodeURIComponent(site)}/${day.date}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((c: DayCase | null) => [day.date, c] as const)
          .catch(() => [day.date, null] as const),
      ),
    )
    setCases(Object.fromEntries(entries.filter(([, c]) => c)) as Record<string, DayCase>)
    // 누락은 감리 감사 저장소 기준
    fetch(`${AUDIT_URL}/summary/${encodeURIComponent(site)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((s: { records: AuditRecord[] }) => setAudit(s.records))
      .catch(() => setAudit(null))
  }, [])

  // 시연 중 10초마다 갱신
  useEffect(() => {
    if (!loadedSite) return
    const id = setInterval(() => load(loadedSite), 10000)
    return () => clearInterval(id)
  }, [loadedSite, load])

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
    await load(siteId)
  }

  const daily = data?.daily ?? []
  const today = daily[daily.length - 1]?.date
  const missingByDay = (d: string) => (audit ?? []).filter((r) => r.audit === 'missing' && localDate(r.signedAt) === d).length
  const latesToday = today ? daily[daily.length - 1].late : 0
  const weekFailed = daily.reduce((s, d) => s + d.failed, 0)
  const weekOverrides = daily.reduce((s, d) => s + d.overrides, 0)
  const todayDaily = daily[daily.length - 1]

  return (
    <div className="space-y-4">
      <TitleBar title="현장 대시보드" sub="최근 7일">
        <SitePicker siteId={siteId} workDate={today ?? new Date().toISOString().slice(0, 10)} onSite={setSiteId} onDate={() => {}} onLoad={() => load(siteId)} />
        <span className="bg-charcoal text-white px-3.5 py-2.5 text-sm font-bold">개인 지목 없음 · 현장 단위 집계만 표시</span>
      </TitleBar>

      {error && <ErrorText>{error}</ErrorText>}
      {!data && <p className="text-ink-muted py-16 text-center text-lg">현장 ID를 넣고 조회를 누르세요.</p>}

      {data && detail === 'override' && (
        <OverrideDetail daily={daily} cases={cases} onBack={() => setDetail(null)} weekFailed={weekFailed} weekOverrides={weekOverrides} />
      )}

      {data && !detail && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <Kpi
              color="border-hazard-green"
              title="검사율"
              badge="정상+지연"
              value={pct(data.rate).replace('%', '')}
              unit="%"
              lines={[`QR ${data.checkedCount + data.uncheckedCount}장 중 ${data.checkedCount}건 검사 · 만료 QR ${data.uncheckedCount}`, `지연 ${data.lateCount} 포함 · 의심 ${data.suspectCount} (별도 표시)`]}
              spark={daily.map((d) => d.rate ?? 0)}
              sparkTone="bg-hazard-green"
            />
            <Kpi
              color="border-hazard-red"
              title="누락"
              badge="감리 저장소 기준"
              value={audit === null ? '?' : String(today ? missingByDay(today) : 0)}
              unit="건"
              lines={audit === null ? ['감사 저장소(8100)에 연결할 수 없어요'] : [`오늘 기준 · 7일 합계 ${daily.reduce((s, d) => s + missingByDay(d.date), 0)}건`, latesToday ? `다시 올린 기록은 지연 기록 ${latesToday}건으로 남음` : '게이트 원본이 체인에 모두 있음']}
              spark={daily.map((d) => missingByDay(d.date))}
              sparkTone="bg-hazard-red"
            />
            <Kpi
              color="border-safety-yellow-dark"
              title="출입 보류"
              badge="평가 전·미조치"
              value={String(todayDaily?.held ?? 0)}
              unit="건"
              lines={['오늘 기준', `7일 합계 ${daily.reduce((s, d) => s + d.held, 0)}건 · 누적 ${data.heldCount}건`]}
              spark={daily.map((d) => d.held)}
              sparkTone="bg-safety-yellow-dark"
            />
            <Kpi
              color="border-safety-yellow-dark"
              title="수동 처리 비율"
              badge="override"
              value={todayDaily && todayDaily.failed ? String(Math.round((todayDaily.overrides / todayDaily.failed) * 100)) : '0'}
              unit="%"
              lines={[
                `오늘 보호구 불합격 ${todayDaily?.failed ?? 0}건 중 ${todayDaily?.overrides ?? 0}건 통과`,
                `7일 평균 ${weekFailed ? pct(weekOverrides / weekFailed) : '0%'} (${weekFailed}건 중 ${weekOverrides}건)`,
              ]}
              spark={daily.map((d) => (d.failed ? d.overrides / d.failed : 0))}
              sparkTone="bg-safety-yellow-dark"
              onClick={() => setDetail('override')}
            />
            <Kpi
              color="border-charcoal"
              title="예외 출입"
              badge="공동서명"
              value={String(data.emergencyCount)}
              unit="건"
              lines={['장비 장애·응급·정전 때', '감독자 + 감리(발주처) 서명 · 누적']}
            />
          </div>

          <div className="flex flex-col lg:flex-row gap-4">
            <div className="flex-1 bg-white border-t-[5px] border-charcoal p-5">
              <div className="flex flex-wrap items-baseline gap-3">
                <p className="text-xl font-black">7일 게이트 판정 추이</p>
                <div className="ml-auto flex gap-3 text-sm font-bold">
                  <Legend cls="bg-hazard-green/60" label="통과" />
                  <Legend cls="bg-ink-muted" label="지연 기록" />
                  <Legend cls="bg-safety-yellow-dark" label="보류" />
                  <Legend cls="bg-hazard-red" label="차단" />
                </div>
              </div>
              <WeekChart daily={daily} cases={cases} />
            </div>
            <div className="lg:w-[340px] flex flex-col gap-3">
              <TodayFeed today={today} dayCase={today ? cases[today] : undefined} missing={(audit ?? []).filter((r) => r.audit === 'missing' && today && localDate(r.signedAt) === today)} />
              <div className="bg-hazard-green text-white p-4">
                <p className="text-sm font-bold text-white/80">무사고</p>
                <p className="text-4xl font-black">
                  {data.noIncidentDays ?? '-'}
                  <small className="text-lg ml-1">일</small>
                </p>
                <p className="text-xs text-white/80">
                  {data.noIncidentSince === 'incident' && `마지막 사고 보고: ${data.lastIncidentDate}`}
                  {data.noIncidentSince === 'firstRecord' && '사고 보고 없음 · 첫 출입 기록일부터'}
                  {data.noIncidentSince === null && '아직 기록이 없어요'}
                </p>
              </div>
            </div>
          </div>

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

function Legend({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <i className={`w-3 h-3 ${cls}`} />
      {label}
    </span>
  )
}

function Kpi(props: {
  color: string
  title: string
  badge: string
  value: string
  unit: string
  lines: string[]
  spark?: number[]
  sparkTone?: string
  onClick?: () => void
}) {
  const max = Math.max(1e-9, ...(props.spark ?? [0]))
  const Tag = props.onClick ? 'button' : 'div'
  return (
    <Tag onClick={props.onClick} className={`bg-white border-t-[5px] ${props.color} p-4 text-left flex flex-col ${props.onClick ? 'hover:bg-paper-dark/40 cursor-pointer' : ''}`}>
      <div className="flex items-center gap-2">
        <span className="font-bold">{props.title}</span>
        <span className="ml-auto bg-charcoal text-white text-[11px] font-bold px-1.5 py-0.5">{props.badge}</span>
      </div>
      <p className="text-4xl font-black leading-tight">
        {props.value}
        <small className="text-lg ml-1">{props.unit}</small>
      </p>
      {props.lines.map((l) => (
        <p key={l} className="text-xs text-ink-muted">
          {l}
        </p>
      ))}
      {props.spark && (
        <>
          <div className="flex items-end gap-1 h-8 mt-2">
            {props.spark.map((v, i) => (
              <i
                key={i}
                className={`flex-1 ${i === props.spark!.length - 1 ? props.sparkTone : 'bg-paper-dark'}`}
                style={{ height: `${Math.max(4, (v / max) * 100)}%` }}
              />
            ))}
          </div>
          <div className="flex justify-between text-[11px] text-ink-muted mt-0.5">
            <span>7일 전</span>
            <span>오늘</span>
          </div>
        </>
      )}
      {props.onClick && <span className="text-xs font-bold underline mt-1">자세히 ▸</span>}
    </Tag>
  )
}

function WeekChart({ daily, cases }: { daily: Daily[]; cases: Record<string, DayCase> }) {
  const max = Math.max(1, ...daily.map((d) => d.checked))
  const H = 300
  return (
    <div className="grid grid-cols-7 gap-3 items-end pt-6">
      {daily.map((d, i) => {
        const s = split(d)
        const isToday = i === daily.length - 1
        const status = cases[d.date]?.state.status
        const h = (n: number) => `${(n / max) * H}px`
        return (
          <div key={d.date} className="flex flex-col items-center gap-1.5 min-w-0">
            <span className="font-black">{d.checked || ''}</span>
            <div className="w-full flex flex-col-reverse border-b-2 border-charcoal" style={{ height: H }}>
              <div className={`w-full flex flex-col-reverse ${isToday ? 'outline-[3px] outline outline-charcoal' : ''}`}>
                {s.pass > 0 && <div className="bg-hazard-green/60" style={{ height: h(s.pass) }} title={`통과 ${s.pass}`} />}
                {s.late > 0 && <div className="bg-ink-muted" style={{ height: h(s.late) }} title={`지연 기록 ${s.late}`} />}
                {s.held > 0 && <div className="bg-safety-yellow-dark" style={{ height: h(s.held) }} title={`보류 ${s.held}`} />}
                {s.blocked > 0 && <div className="bg-hazard-red" style={{ height: h(s.blocked) }} title={`차단 ${s.blocked}`} />}
              </div>
            </div>
            <span className={`text-sm ${isToday ? 'font-black' : 'font-bold text-ink-muted'}`}>{isToday ? `오늘 ${d.date.slice(5).replace('-', '/')}` : dayLabel(d.date)}</span>
            <span
              className={`w-full text-center text-xs font-bold py-1 ${
                status === 'Finalized' ? 'bg-hazard-green/15 text-hazard-green' : status === 'Rejected' ? 'bg-hazard-red/15 text-hazard-red' : 'bg-paper-dark text-ink-muted'
              }`}
            >
              {status === 'Finalized'
                ? `✓ 확정${(cases[d.date]?.state.round ?? 1) > 1 ? ` (${cases[d.date].state.round}회차)` : ''}`
                : status === 'Rejected'
                  ? '반려'
                  : status === 'Submitted' || status === 'InspectorApproved'
                    ? '승인 중'
                    : d.checked
                      ? '미제출'
                      : '-'}
            </span>
          </div>
        )
      })}
    </div>
  )
}

const FEED_TAG: Record<string, string> = {
  '최종 확정': 'bg-charcoal text-white',
  반려: 'bg-hazard-red/15 text-hazard-red',
  '지연 기록': 'bg-paper-dark text-ink-muted',
  누락: 'bg-hazard-red/15 text-hazard-red',
  차단: 'bg-hazard-red/15 text-hazard-red',
  '수동 처리': 'bg-safety-yellow/30 text-safety-yellow-dark',
  보류: 'bg-safety-yellow/30 text-safety-yellow-dark',
}

// 오늘 반영된 기록 (개인 이름 없이 '근로자 1명'으로만)
function TodayFeed({ today, dayCase, missing }: { today?: string; dayCase?: DayCase; missing: AuditRecord[] }) {
  const items: { at: number; tag: string; text: ReactNode }[] = []
  dayCase?.history.forEach((h) => {
    if (h.action === 'reject') items.push({ at: h.anchoredAt, tag: '반려', text: `${h.actorName} 반려 · ${h.reason ?? ''}` })
  })
  if (dayCase?.state.status === 'Finalized') {
    const last = dayCase.history[dayCase.history.length - 1]
    if (last) items.push({ at: last.anchoredAt, tag: '최종 확정', text: `시공사 → 감리 → 발주처 서명${dayCase.history.some((h) => h.action === 'reject') ? ` · 반려 ${dayCase.history.filter((h) => h.action === 'reject').length}회` : ''}` })
  }
  missing.forEach((m) => items.push({ at: m.signedAt, tag: '누락', text: `게이트 일련번호 ${m.deviceSeq} · 체인에 없음` }))
  dayCase?.checkIns.forEach((c) => {
    const failed = [!c.helmetPass && '안전모', !c.shoesPass && '안전화', !c.alcoholPass && '음주'].filter(Boolean).join('·')
    if (c.overridden) items.push({ at: c.timestamp, tag: '수동 처리', text: `근로자 1명 · ${failed} · 사유 ${c.overrideReason}` })
    else if (c.entryStatus === 'HeldNoAssessment' || c.entryStatus === 'HeldHazardsOpen')
      items.push({ at: c.timestamp, tag: '보류', text: `근로자 1명 · ${c.entryStatus === 'HeldNoAssessment' ? '평가 전' : '위험요인 미조치'}` })
    else if (c.entryStatus === 'Denied') items.push({ at: c.timestamp, tag: '차단', text: `근로자 1명 · ${failed}` })
    else if (c.entryStatus === 'LateAuditOnly') items.push({ at: c.timestamp, tag: '지연 기록', text: '늦게 올라온 게이트 기록 · 감사용' })
  })
  items.sort((a, b) => b.at - a.at)
  return (
    <div className="bg-white border-t-[5px] border-charcoal p-5 flex-1">
      <div className="flex items-baseline">
        <p className="text-xl font-black">오늘 반영된 기록</p>
        <span className="ml-auto text-xs font-bold text-ink-muted">10초마다 갱신</span>
      </div>
      {!today || items.length === 0 ? (
        <p className="py-6 text-ink-muted text-sm">오늘은 정상 통과 외에 특별한 기록이 없어요.</p>
      ) : (
        items.slice(0, 8).map((it, i) => (
          <div key={i} className="flex gap-3 py-2.5 border-b border-charcoal/10 last:border-0">
            <span className="font-black w-12 shrink-0">{hhmm(it.at)}</span>
            <div className="min-w-0">
              <span className={`inline-block text-xs font-bold px-2 py-0.5 ${FEED_TAG[it.tag] ?? 'bg-paper-dark'}`}>{it.tag}</span>
              <p className="text-sm">{it.text}</p>
            </div>
          </div>
        ))
      )}
    </div>
  )
}

// 수동 처리 비율 자세히: 일별 비율 막대 + 사유 코드별
function OverrideDetail(props: { daily: Daily[]; cases: Record<string, DayCase>; onBack: () => void; weekFailed: number; weekOverrides: number }) {
  const { daily, cases, onBack, weekFailed, weekOverrides } = props
  const avg = weekFailed ? weekOverrides / weekFailed : 0
  const today = daily[daily.length - 1]
  const reasons = new Map<string, number>()
  Object.values(cases).forEach((c) =>
    c.checkIns.forEach((ci) => {
      if (ci.overridden && ci.overrideReason) reasons.set(ci.overrideReason, (reasons.get(ci.overrideReason) ?? 0) + 1)
    }),
  )
  const reasonTotal = [...reasons.values()].reduce((a, b) => a + b, 0)
  const H = 340
  return (
    <>
      <p className="text-sm font-bold">
        <button onClick={onBack} className="underline text-ink-muted">
          대시보드
        </button>{' '}
        › 수동 처리 비율
      </p>
      <div className="flex flex-col lg:flex-row gap-4">
        <div className="flex-1 bg-white border-t-[5px] border-safety-yellow-dark p-5">
          <p className="text-2xl font-black">
            수동 처리 비율 · 최근 7일 <small className="text-sm font-medium text-ink-muted">AI 보호구 불합격 중 감독자가 통과시킨 비율</small>
          </p>
          <p className="flex items-baseline gap-4">
            <span className="text-7xl font-black">
              {today?.failed ? Math.round((today.overrides / today.failed) * 100) : 0}
              <small className="text-2xl">%</small>
            </span>
            <span className="font-bold text-ink-muted">
              오늘 {today?.failed ?? 0}건 중 {today?.overrides ?? 0}건 · 7일 평균 {pct(avg)} (불합격 {weekFailed}건 중 {weekOverrides}건)
            </span>
          </p>
          <div className="relative grid grid-cols-7 gap-4 items-end mt-6" style={{ height: H + 60 }}>
            <div className="absolute left-0 right-0 border-t-2 border-dashed border-safety-yellow-dark" style={{ bottom: 32 + avg * H }}>
              <span className="absolute right-0 -top-5 text-xs font-bold text-safety-yellow-dark">7일 평균 {pct(avg)}</span>
            </div>
            {daily.map((d, i) => {
              const r = d.failed ? d.overrides / d.failed : 0
              const isToday = i === daily.length - 1
              return (
                <div key={d.date} className="flex flex-col items-center justify-end h-full">
                  <span className="font-black">{d.failed ? pct(r) : '-'}</span>
                  <span className="text-xs text-ink-muted">{d.failed ? `${d.overrides}/${d.failed}` : ''}</span>
                  <div className={`w-full ${isToday ? 'bg-safety-yellow-dark' : 'bg-paper-dark'}`} style={{ height: Math.max(2, r * H) }} />
                  <span className={`text-sm mt-2 h-6 ${isToday ? 'font-black' : 'font-bold text-ink-muted'}`}>{isToday ? `오늘 ${d.date.slice(5).replace('-', '/')}` : dayLabel(d.date)}</span>
                </div>
              )
            })}
          </div>
        </div>
        <div className="lg:w-[380px] flex flex-col gap-3">
          <div className="bg-white p-5">
            <p className="text-lg font-black mb-2">
              사유 코드별 (7일 · {reasonTotal}건)
            </p>
            {reasonTotal === 0 && <p className="text-sm text-ink-muted">수동 처리 기록이 없어요.</p>}
            {[...reasons.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([label, n]) => (
                <div key={label} className="mb-3">
                  <div className="flex justify-between font-bold">
                    <span>{label}</span>
                    <span>
                      {n}건 · {pct(n / reasonTotal)}
                    </span>
                  </div>
                  <div className="h-3 bg-paper-dark mt-1">
                    <div className="h-full bg-safety-yellow-dark" style={{ width: pct(n / reasonTotal) }} />
                  </div>
                </div>
              ))}
          </div>
          <DarkBox
            title="이 숫자를 누가 보나요"
            items={['감리·발주처가 하루치 기록을 승인할 때 수동 처리 건을 함께 검토해요', '비율이 높으면 AI가 무력화되고 있다는 신호예요', "'AI 오탐'이 많으면 카메라 위치·조명이나 모델을 점검해요"]}
          />
          <p className="bg-paper-dark p-3.5 text-sm font-bold flex gap-2.5">
            <span className="w-5 h-5 grid place-items-center bg-charcoal text-safety-yellow text-xs shrink-0">✕</span>
            누가 수동 처리했는지, 누가 차단됐는지는 이 화면에 나오지 않아요
          </p>
        </div>
      </div>
    </>
  )
}
