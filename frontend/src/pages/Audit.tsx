import { useCallback, useEffect, useState } from 'react'
import { hhmm, hhmmss, SitePicker, TitleBar } from '../components/kiosk'
import { ErrorText, SecondaryButton, Select } from '../components/ui'
import { AUDIT_URL, BACKEND_URL } from '../config'
import { shortAddr, signTyped, type TypedData } from '../wallet'

// 감리가 보는 화면. 시공사 백엔드가 아니라 감리 감사 저장소(게이트가 직접 보낸 원본)와 체인을 대조한다. 목업 audit-mockup
type AuditState = 'anchored' | 'pending' | 'missing' | 'replaced' | 'mismatch'

type AuditRecord = {
  nonce: string
  deviceSeq: number
  device: string
  signedAt: number
  receivedAt: number
  passed: boolean
  audit: AuditState
  entryStatus: string | null
  anchoredAt: number | null
  inContractorDb: boolean | null
  // 미제출 기록을 감사 저장소가 체인에 직접 모의 실행한 결과
  chainCheck: { verdict: 'withheld' | 'rejected'; reason: string | null } | null
}

type ChainOnly = { nonce: string; deviceSeq: number; device: string; passed: boolean; anchoredAt: number }

type DeviceRow = {
  address: string
  active: boolean
  chainHighestSeq: number
  chainReceived: number
  chainMissing: number
  auditHighestSeq: number
  auditCount: number
}

type Revocation = {
  role: string
  account: string
  reason: string | null
  revokedAt: number
  lastSeq: number
  missingAtRevoke: number
}

type Summary = {
  graceSeconds: number
  counts: Record<AuditState | 'chainOnly' | 'auditTotal' | 'chainTotal' | 'withheld' | 'chainRejected', number>
  records: AuditRecord[]
  chainOnly: ChainOnly[]
  devices: DeviceRow[]
  revocations: Revocation[]
  conflicts: { device: string; deviceSeq: number; receivedAt: number }[]
  contractor: { hidden: number; contractorOnly: number; total: number } | null
  emergencies: { nonce: string; reason: string | null; supervisor: string; approver: string; anchoredAt: number }[]
}

type Reason = { code: number; label: string }
type Rejection = { kind: string; nonce: string | null; error: string; at: number }

const KIND_LABEL: Record<string, string> = { checkin: '출입 검사', override: '수동 처리', site_record: '위험성평가' }
const ERROR_LABEL: Record<string, string> = {
  StaleTimestamp: '허용 시간 밖의 서명 시각',
  NonceAlreadyUsed: '이미 쓰인 출입 권한(QR) 재사용',
  MissingRole: '등록되지 않았거나 해제된 서명자',
  CheckInNotOverridable: '수동 처리할 수 없는 기록',
  CheckInNotFailed: '불합격이 아닌 기록에 수동 처리',
  DuplicateSequence: '같은 기기 일련번호 재사용',
}
type RelayMode = 'normal' | 'paused' | 'drop_failed'

// 번호 띠 한 칸의 상태. 'late'는 체인에 늦게 올라와 감사용으로만 인정된 기록, 'gap'은 게이트도 체인도 모르는 번호
type Cell = AuditState | 'rejected' | 'chainOnly' | 'late' | 'gap'

const CELL_STYLE: Record<Cell, { cls: string; icon: string; label: string }> = {
  anchored: { cls: 'bg-hazard-green/70 text-white', icon: '✓', label: '체인 기록' },
  late: { cls: 'bg-ink-muted text-white', icon: '⟲', label: '지연 기록' },
  pending: { cls: 'bg-safety-yellow/20 text-safety-yellow-dark border-2 border-dashed border-safety-yellow-dark', icon: '…', label: '반영 대기' },
  missing: {
    cls: 'text-hazard-red border-2 border-hazard-red bg-[repeating-linear-gradient(135deg,#fdecea_0_8px,#fff_8px_16px)]',
    icon: '✕',
    label: '누락',
  },
  rejected: { cls: 'bg-hazard-red/15 text-hazard-red', icon: '⊘', label: '체인이 거부' },
  replaced: { cls: 'bg-charcoal text-safety-yellow', icon: '⇄', label: '바꿔치기' },
  mismatch: { cls: 'bg-charcoal text-safety-yellow', icon: '≠', label: '값 불일치' },
  chainOnly: { cls: 'bg-white text-charcoal border-2 border-dashed border-charcoal', icon: '?', label: '체인에만 있음' },
  gap: { cls: 'bg-paper-dark text-ink-muted', icon: '', label: '어디에도 없음' },
}

const cellOf = (r: AuditRecord): Cell =>
  r.chainCheck?.verdict === 'rejected' ? 'rejected' : r.audit === 'anchored' && r.entryStatus === 'LateAuditOnly' ? 'late' : r.audit

const short = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`

export default function Audit() {
  const [siteId, setSiteId] = useState('')
  const [loadedSite, setLoadedSite] = useState<string | null>(null)
  const [data, setData] = useState<Summary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState(true)
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [now, setNow] = useState(Date.now())
  const [rejections, setRejections] = useState<Rejection[]>([])
  const [showTools, setShowTools] = useState(false)
  const [showAll, setShowAll] = useState(false)

  const load = useCallback(async (site: string) => {
    try {
      const res = await fetch(`${AUDIT_URL}/summary/${encodeURIComponent(site)}`)
      if (!res.ok) throw new Error(`감사 저장소 응답 오류 (${res.status})`)
      setData(await res.json())
      setLoadedSite(site)
      setUpdatedAt(Date.now())
      setError(null)
      // 거부 로그는 시공사 백엔드가 남기는 참고 자료라 실패해도 대조 화면은 그대로 보여준다
      fetch(`${BACKEND_URL}/rejections/${encodeURIComponent(site)}`)
        .then((r) => (r.ok ? r.json() : []))
        .then(setRejections)
        .catch(() => setRejections([]))
    } catch (e) {
      setError(e instanceof Error && e.message.startsWith('감사') ? e.message : '감사 저장소에 연결할 수 없습니다. audit 서비스(8100)가 켜져 있는지 확인하세요')
    }
  }, [])

  // 시연 중에는 3초마다 다시 대조해서 누락이 쌓이는 걸 바로 보여준다
  useEffect(() => {
    if (!loadedSite || !live) return
    const id = setInterval(() => load(loadedSite), 3000)
    return () => clearInterval(id)
  }, [loadedSite, live, load])
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const c = data?.counts
  const k = data?.contractor
  const flagged = c ? c.withheld + c.replaced + c.mismatch + c.chainOnly + (k?.contractorOnly ?? 0) : 0
  const missingRecs = (data?.records ?? []).filter((r) => r.audit === 'missing' && r.chainCheck?.verdict === 'withheld').sort((a, b) => a.deviceSeq - b.deviceSeq)
  const pendingRecs = (data?.records ?? []).filter((r) => r.audit === 'pending')
  const lateCount = (data?.records ?? []).filter((r) => cellOf(r) === 'late').length
  // 다음 판정까지 남은 초 (가장 먼저 들어온 반영 대기 기록 기준)
  const nextJudge = pendingRecs.length && data ? Math.max(0, Math.min(...pendingRecs.map((r) => r.receivedAt + data.graceSeconds)) - Math.floor(now / 1000)) : null
  const rows = [...(data?.records ?? [])].sort((a, b) => b.deviceSeq - a.deviceSeq)

  return (
    <div className="space-y-3.5">
      <TitleBar title="감리 감사">
        <SitePicker siteId={siteId} onSite={setSiteId} onLoad={() => load(siteId)} loadLabel="전체 기간 대조" />
        {data && (
          <>
            <button onClick={() => setLive((v) => !v)} className="bg-charcoal text-white px-4 py-2.5 text-sm font-bold flex items-center gap-2">
              <i className={`w-2 h-2 rounded-full ${live ? 'bg-hazard-green' : 'bg-white/40'}`} />
              {live ? '감리 저장소 수신 중' : '실시간 대조 꺼짐'}
            </button>
            <span className="text-sm font-bold text-ink-muted">
              {nextJudge !== null ? `다음 판정까지 ${nextJudge}초` : updatedAt && now - updatedAt < 4000 ? '방금 갱신' : updatedAt ? `${Math.round((now - updatedAt) / 1000)}초 전 갱신` : ''}
            </span>
          </>
        )}
        <button onClick={() => setShowTools((v) => !v)} className="border-2 border-charcoal px-3 py-2 text-sm font-bold">
          시연 도구 {showTools ? '▾' : '▸'}
        </button>
      </TitleBar>

      {showTools && <DemoTools onChanged={() => loadedSite && load(loadedSite)} />}
      {error && <ErrorText>{error}</ErrorText>}
      {!data && !error && <p className="text-ink-muted py-16 text-center text-lg">현장 ID를 넣고 대조를 누르세요.</p>}

      {data && c && (
        <>
          {flagged > 0 ? (
            <>
              <div className="bg-hazard-red text-white px-6 py-5 flex items-center gap-5">
                <span className="w-16 h-16 shrink-0 rounded-full bg-white grid place-items-center text-4xl font-black text-hazard-red">✕</span>
                <div>
                  <p className="text-3xl font-black">
                    {missingRecs.length > 0 ? `기록 ${missingRecs.length}건이 체인에 올라오지 않았어요` : `누락·변조 의심 ${flagged}건`}
                  </p>
                  <p className="font-bold">
                    {missingRecs.length > 0
                      ? `게이트는 보냈고 감리는 받았는데 시공사가 올리지 않았어요 · ${missingRecs.map((r) => `#${r.deviceSeq}`).join(', ')}`
                      : '아래 칸에서 어떤 종류인지 확인하세요'}
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-3 lg:grid-cols-6 gap-2">
                <Stat n={c.withheld} label="받을 수 있었는데 안 냄" />
                <Stat n={c.chainRejected} label="체인이 거부 (사유 확인)" quiet />
                <Stat n={c.replaced} label="바꿔치기" />
                <Stat n={c.mismatch} label="값 불일치" />
                <Stat n={c.chainOnly} label="체인에만 있음" />
                <Stat n={k ? k.hidden : 0} label={k ? '시공사 DB에서도 사라짐' : '시공사 DB 연결 안 됨'} />
              </div>
            </>
          ) : (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <Kpi title="감리가 받은 원본" badge="게이트 직송" n={c.auditTotal} detail="게이트가 서명 직후 감리 저장소로 바로 보냄" />
              <Kpi
                title="체인에 올라간 기록"
                badge="시공사 릴레이"
                n={c.anchored}
                tone="text-hazard-green"
                border="border-hazard-green"
                detail={lateCount ? `정상 ${c.anchored - lateCount} · 지연 기록 ${lateCount}` : '시공사 서버가 가스비를 내고 제출'}
              />
              <Kpi
                title="반영 대기"
                badge={`유예 ${data.graceSeconds}초`}
                n={c.pending}
                tone="text-safety-yellow-dark"
                border="border-safety-yellow-dark"
                detail={`${data.graceSeconds}초가 지나도 체인에 없으면 미제출로 판정`}
              />
              <Kpi
                title="누락"
                badge="받을 수 있었는데 안 냄"
                n={c.withheld}
                tone="text-hazard-red"
                border="border-hazard-red"
                detail={lateCount ? `다시 올라온 ${lateCount}건은 지연 기록으로 영구 표시` : '체인 모의 실행으로 받아줄 기록인지 확인'}
              />
            </div>
          )}

          {data.devices.map((d) => (
            <SequenceStrip key={d.address} device={d} records={data.records} chainOnly={data.chainOnly} pendingIn={nextJudge} />
          ))}
          {data.devices.length === 0 && <p className="bg-white p-4 text-ink-muted">아직 게이트 기록이 없습니다.</p>}

          <div className="flex flex-col lg:flex-row gap-4">
            <div className="flex-1 bg-white border-t-[5px] border-charcoal flex flex-col">
              <div className="flex items-baseline px-5 py-3">
                <p className="text-xl font-black">3자 대조</p>
                <span className="ml-auto text-xs font-bold text-ink-muted">기준: 감리 원본 · 시공사 DB · 블록체인</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-charcoal text-white text-left">
                    <tr>
                      {['번호', '검사 시각', '감리 원본', '블록체인', '시공사 DB', '판정'].map((h) => (
                        <th key={h} className="px-4 py-2 font-bold">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(showAll ? rows : rows.slice(0, 8)).map((r) => (
                      <AuditRow key={r.nonce} r={r} grace={data.graceSeconds} now={now} />
                    ))}
                    {rows.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-4 py-6 text-ink-muted">
                          감리 저장소에 받은 원본이 없어요.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="mt-auto px-5 py-3 flex flex-wrap gap-2.5 justify-end">
                {data.conflicts.length > 0 && (
                  <span className="mr-auto text-xs text-ink-muted self-center">같은 일련번호로 덮어쓰려던 시도 {data.conflicts.length}건 (원본은 그대로 보존)</span>
                )}
                {rows.length > 8 && (
                  <button onClick={() => setShowAll((v) => !v)} className="border-2 border-charcoal px-4 py-2.5 font-bold">
                    {showAll ? '최근 8건만' : `전체 ${rows.length}건 보기`}
                  </button>
                )}
                {missingRecs.length > 0 && (
                  <a href="#/caseReview" className="bg-hazard-red text-white px-4 py-2.5 font-bold border-b-4 border-hazard-red-dark">
                    케이스 검토에서 반려하기 ▸
                  </a>
                )}
                {missingRecs.length === 0 && lateCount > 0 && (
                  <a href="#/caseReview" className="bg-safety-yellow px-4 py-2.5 font-bold border-b-4 border-charcoal">
                    케이스 검토에서 확인하기 ▸
                  </a>
                )}
              </div>
            </div>

            <div className="lg:w-[340px] flex flex-col gap-3">
              {missingRecs.length > 0 && (
                <div className="bg-white border-t-[5px] border-hazard-red p-5 text-sm">
                  <p className="font-black text-base mb-1">왜 '제출 보류'인가요?</p>
                  감리 저장소가 이 {missingRecs.length}건을 체인에 모의 실행해 봤더니 정상으로 받아들여졌어요. 즉 체인이 거부한 게 아니라 시공사가 내지 않은 기록이에요.
                </div>
              )}
              <PendingSignatures site={loadedSite ?? siteId} onDone={() => loadedSite && load(loadedSite)} />
              <div className="bg-charcoal text-white p-5 text-sm space-y-1.5">
                <p className="font-black text-base">기기 해제 이력</p>
                {data.revocations.length === 0 && <p className="text-white/70">해제된 서명자가 없어요.</p>}
                {data.revocations.map((r, i) => (
                  <p key={i} className="text-white/80">
                    {new Date(r.revokedAt * 1000).toLocaleDateString('ko-KR')} {r.role === 'device' ? '게이트 기기' : '감독자'} {short(r.account)} 해제 · {r.reason}
                    <br />
                    해제 직전 마지막 번호 #{r.lastSeq} · 그때 누락 {r.missingAtRevoke}건
                  </p>
                ))}
                <p className="text-white/60 text-xs">새 기기는 감리 승인 후에만 등록돼 번호를 다시 시작할 수 없어요</p>
              </div>
              {data.emergencies.length > 0 && (
                <div className="bg-white p-5 text-sm">
                  <p className="font-black text-base mb-1">예외 출입 · {data.emergencies.length}건</p>
                  {data.emergencies.map((e) => (
                    <p key={e.nonce} className="py-1 border-b border-charcoal/10 last:border-0">
                      {e.reason} <span className="text-ink-muted text-xs">· {hhmmss(e.anchoredAt)} · {short(e.supervisor)} + {short(e.approver)}</span>
                    </p>
                  ))}
                </div>
              )}
              {rejections.length > 0 && (
                <details className="bg-white p-4 text-sm">
                  <summary className="font-bold cursor-pointer">체인이 거부한 제출 · {rejections.length}건 (시공사 릴레이 로그)</summary>
                  {rejections.map((r, i) => (
                    <p key={i} className="py-1">
                      {KIND_LABEL[r.kind] ?? r.kind} · {ERROR_LABEL[r.error] ?? r.error} <span className="text-xs text-ink-muted">{new Date(r.at * 1000).toLocaleString()}</span>
                    </p>
                  ))}
                  <p className="text-xs text-ink-muted mt-1">미제출 기록의 실제 거부 여부는 감사 저장소가 체인에 직접 모의 실행한 결과가 기준이에요.</p>
                </details>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function Stat({ n, label, quiet }: { n: number; label: string; quiet?: boolean }) {
  const hot = n > 0 && !quiet
  return (
    <div className={`border-2 px-3 py-2.5 ${hot ? 'border-hazard-red bg-hazard-red/10' : 'border-charcoal/10 bg-white'}`}>
      <p className={`text-2xl font-black ${hot ? 'text-hazard-red' : ''}`}>{n}</p>
      <p className="text-xs font-bold text-ink-muted">{label}</p>
    </div>
  )
}

function Kpi({ title, badge, n, detail, tone = '', border = 'border-charcoal' }: { title: string; badge: string; n: number; detail: string; tone?: string; border?: string }) {
  return (
    <div className={`bg-white border-t-[5px] ${border} p-4`}>
      <p className="font-bold flex items-center gap-2">
        {title}
        <span className="ml-auto bg-charcoal text-white text-[11px] px-1.5 py-0.5">{badge}</span>
      </p>
      <p className={`text-5xl font-black ${tone}`}>{n}</p>
      <p className="text-xs text-ink-muted">{detail}</p>
    </div>
  )
}

function AuditRow({ r, grace, now }: { r: AuditRecord; grace: number; now: number }) {
  const cell = cellOf(r)
  const yes = <span className="text-hazard-green font-bold">✓ 있음</span>
  const no = <span className="text-hazard-red font-bold">✕ 없음</span>
  const left = Math.max(0, r.receivedAt + grace - Math.floor(now / 1000))
  const chainCol =
    cell === 'anchored' ? yes : cell === 'late' ? <span className="text-ink-muted font-bold">⟲ {r.anchoredAt ? hhmm(r.anchoredAt) : ''} 반영</span> : cell === 'pending' ? <span className="text-safety-yellow-dark font-bold">… 대기</span> : no
  const verdict: Record<Cell, React.ReactNode> = {
    anchored: <span className="text-hazard-green font-bold">✓ {r.inContractorDb === null ? '2곳' : '3곳'} 일치</span>,
    late: (
      <>
        <span className="text-ink-muted font-bold">지연 기록</span>
        <small className="block text-ink-muted">감사용으로만 인정 · 원래 시각 그대로</small>
      </>
    ),
    pending: <span className="text-safety-yellow-dark font-bold">… 반영 대기 {left}초</span>,
    missing: (
      <>
        <span className="text-hazard-red font-bold">✕ 누락 · 제출 보류</span>
        <small className="block text-ink-muted">체인 모의 실행: 받아줄 기록</small>
      </>
    ),
    rejected: (
      <>
        <span className="text-hazard-red font-bold">체인이 거부</span>
        <small className="block text-ink-muted">{ERROR_LABEL[r.chainCheck?.reason ?? ''] ?? r.chainCheck?.reason}</small>
      </>
    ),
    replaced: <span className="text-hazard-red font-bold">⇄ 다른 기록으로 바꿔치기</span>,
    mismatch: <span className="text-hazard-red font-bold">≠ 체인 값과 다름</span>,
    chainOnly: <span className="font-bold">체인에만 있음</span>,
    gap: null,
  }
  const bg = cell === 'missing' || cell === 'rejected' || cell === 'replaced' || cell === 'mismatch' ? 'bg-hazard-red/5' : cell === 'pending' ? 'bg-safety-yellow/10' : cell === 'late' ? 'bg-paper-dark/50' : ''
  return (
    <tr className={`border-b border-charcoal/10 ${bg}`}>
      <td className="px-4 py-2.5 font-black">#{r.deviceSeq}</td>
      <td className="px-4 py-2.5">{hhmmss(r.signedAt)}</td>
      <td className="px-4 py-2.5">{yes}</td>
      <td className="px-4 py-2.5">{chainCol}</td>
      <td className="px-4 py-2.5">{r.inContractorDb === null ? <span className="text-ink-muted">연결 안 됨</span> : r.inContractorDb ? yes : no}</td>
      <td className="px-4 py-2.5">
        {verdict[cell]}
        {r.entryStatus && (r.entryStatus === 'HeldNoAssessment' || r.entryStatus === 'HeldHazardsOpen') && <small className="block text-ink-muted">보류 · {r.entryStatus === 'HeldNoAssessment' ? '평가 전' : '위험요인 미조치'}</small>}
      </td>
    </tr>
  )
}

// 기기가 매긴 번호를 한 줄로 늘어놓는다. 빠진 칸이 곧 시공사가 체인에 내지 않은 기록이다
function SequenceStrip({ device, records, chainOnly, pendingIn }: { device: DeviceRow; records: AuditRecord[]; chainOnly: ChainOnly[]; pendingIn: number | null }) {
  const max = Math.max(device.chainHighestSeq, device.auditHighestSeq)
  const bySeq = new Map<number, Cell>()
  chainOnly.filter((c) => c.device === device.address).forEach((c) => bySeq.set(c.deviceSeq, 'chainOnly'))
  records.filter((r) => r.device === device.address).forEach((r) => bySeq.set(r.deviceSeq, cellOf(r)))
  // 최근 24칸만 (많으면 앞쪽은 생략). 감사 저장소·체인이 아는 가장 작은 번호보다 앞은 그리지 않는다
  const known = [...bySeq.keys()]
  const from = Math.max(known.length ? Math.min(...known) : 1, max - 23)
  const cells = Array.from({ length: max - from + 1 }, (_, i) => from + i)
  const pend = [...bySeq.values()].filter((v) => v === 'pending').length
  const late = [...bySeq.values()].filter((v) => v === 'late').length

  return (
    <div className="bg-white border-t-[5px] border-charcoal p-5 space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="text-lg font-black">게이트 일련번호 띠</p>
        <span className="text-xs text-ink-muted">
          기기 {short(device.address)} · <span className={device.active ? 'text-hazard-green' : 'text-hazard-red'}>{device.active ? '감리 승인됨' : '해제됨'}</span> · 번호는 게이트가 직접 매김 · 체인이 아는 빈 번호 {device.chainMissing}개
        </span>
        <div className="ml-auto flex flex-wrap gap-3 text-xs font-bold">
          {(['anchored', 'pending', 'missing', 'late'] as Cell[]).map((k) => (
            <span key={k} className="flex items-center gap-1">
              <i className={`w-3 h-3 ${CELL_STYLE[k].cls}`} />
              {CELL_STYLE[k].label}
            </span>
          ))}
        </div>
      </div>
      <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${Math.min(12, cells.length)}, minmax(0, 1fr))` }}>
        {cells.map((seq) => {
          const cell = bySeq.get(seq) ?? 'gap'
          return (
            <span key={seq} title={`#${seq} ${CELL_STYLE[cell].label}`} className={`h-12 flex flex-col items-center justify-center text-xs font-bold ${CELL_STYLE[cell].cls}`}>
              <b className="text-sm leading-none">{CELL_STYLE[cell].icon}</b>#{seq}
            </span>
          )
        })}
      </div>
      {pend > 0 && (
        <p className="bg-safety-yellow/20 p-3 text-sm font-bold">
          ! 최근 {pend}건이 감리에는 도착했지만 아직 체인에 올라오지 않았어요{pendingIn !== null ? ` · ${pendingIn}초 뒤 미제출로 판정` : ''}
        </p>
      )}
      {late > 0 && pend === 0 && (
        <p className="bg-paper-dark p-3 text-sm font-bold">⟲ 늦게 올라온 {late}건은 검사 시각이 원래대로 남고, 출입 근거가 아닌 감사용 지연 기록으로만 인정돼요.</p>
      )}
    </div>
  )
}

// 시공사 쪽 동작을 시연하는 도구 (백엔드 DEMO_CONTROLS=1일 때만 동작)
function DemoTools({ onChanged }: { onChanged: () => void }) {
  const [enabled, setEnabled] = useState(false)
  const [mode, setMode] = useState<RelayMode>('normal')
  const [reasons, setReasons] = useState<Reason[]>([])
  const [reasonCode, setReasonCode] = useState(1)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    fetch(`${BACKEND_URL}/demo/relay`)
      .then((r) => r.json())
      .then((d: { mode: RelayMode; demoControls: boolean }) => {
        setEnabled(d.demoControls)
        setMode(d.mode)
      })
      .catch(() => {})
    fetch(`${BACKEND_URL}/reasons`)
      .then((r) => r.json())
      .then((d: { revoke: Reason[] }) => setReasons(d.revoke ?? []))
      .catch(() => {})
  }, [])

  async function post(path: string, body: object, done: string) {
    setMessage(null)
    const res = await fetch(`${BACKEND_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    setMessage(res.ok ? done : (data.detail ?? '요청 실패'))
    onChanged()
    return res.ok
  }

  async function changeMode(next: RelayMode) {
    if (await post('/demo/relay', { mode: next }, '릴레이 설정을 바꿨습니다')) setMode(next)
  }

  async function register() {
    setMessage(null)
    const res = await fetch(`${BACKEND_URL}/signers/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'device' }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) setMessage(data.detail ?? '요청 실패')
    else if (data.pendingApproval) setMessage('시공사가 재등록을 제안했습니다. 위 "지갑 서명 대기"에서 감리·발주처가 승인해야 등록됩니다')
    else setMessage('게이트 기기를 다시 등록했습니다 (백업 모드: 서버가 감리 키로 승인)')
    onChanged()
  }

  if (!enabled) return <p className="bg-white p-4 text-sm text-ink-muted">시연 도구는 백엔드를 DEMO_CONTROLS=1로 켰을 때만 동작해요.</p>

  const modes: { key: RelayMode; label: string }[] = [
    { key: 'normal', label: '정상 제출' },
    { key: 'paused', label: '릴레이 중단' },
    { key: 'drop_failed', label: '불합격만 빼고 제출' },
  ]

  return (
    <details open className="border-2 border-dashed border-charcoal/50 bg-white p-4 text-sm">
      <summary className="cursor-pointer font-semibold select-none text-ink">시연 도구: 시공사 쪽 동작 재현</summary>
      <div className="mt-3 space-y-4">
        <div className="space-y-1.5">
          <p className="text-ink-muted text-xs">
            시공사 릴레이만 바꿉니다. 게이트는 계속 감사 저장소로 원본을 보냅니다.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {modes.map((m) => (
              <button
                key={m.key}
                onClick={() => changeMode(m.key)}
                aria-pressed={mode === m.key}
                className={`px-3 py-1.5 border-2 border-charcoal font-semibold ${
                  mode === m.key ? 'bg-safety-yellow text-charcoal' : 'bg-white text-ink-muted'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-1.5">
          <p className="text-ink-muted text-xs">게이트 기기 해제는 즉시 반영되고, 사유와 해제 시점 번호가 체인에 남습니다.</p>
          <div className="flex flex-wrap gap-1.5">
            <Select value={reasonCode} onChange={(e) => setReasonCode(Number(e.target.value))} className="w-auto flex-1">
              {reasons.map((r) => (
                <option key={r.code} value={r.code}>
                  {r.label}
                </option>
              ))}
            </Select>
            <SecondaryButton onClick={() => post('/signers/revoke', { role: 'device', reasonCode }, '게이트 기기를 해제했습니다')}>
              기기 해제
            </SecondaryButton>
            <button
              onClick={register}
              className="px-3 py-1.5 border-2 border-charcoal bg-white font-semibold"
            >
              재등록
            </button>
          </div>
        </div>
        {message && <p className="text-xs font-semibold text-ink">{message}</p>}
      </div>
    </details>
  )
}

type Proposal = { proposalId: number; role: string; account: string; accountName: string; typedData: TypedData }
type PendingEmergency = { nonce: string; createdAt: number; supervisor: string; reason: string | null; typedData: TypedData }

// 감리·발주처가 자기 지갑으로 서명할 일: 서명자(게이트 기기·감독자) 등록 승인, 예외 출입 공동 서명.
// 서버는 서명할 내용만 내려주고, 서명은 지갑에서 만들어진다.
function PendingSignatures({ site, onDone }: { site: string; onDone: () => void }) {
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [emergencies, setEmergencies] = useState<PendingEmergency[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [p, e] = await Promise.all([
        fetch(`${BACKEND_URL}/signers/proposals`).then((r) => (r.ok ? r.json() : [])),
        fetch(`${BACKEND_URL}/gate/emergency/pending/${encodeURIComponent(site)}`).then((r) => (r.ok ? r.json() : [])),
      ])
      setProposals(p)
      setEmergencies(e)
    } catch {
      // 시공사 백엔드가 꺼져 있어도 감사 화면은 그대로 보인다
    }
  }, [site])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 4000)
    return () => clearInterval(id)
  }, [refresh])

  async function sign(key: string, typedData: TypedData, path: string, body: (sig: string) => object, done: string) {
    setBusy(key)
    setMessage(null)
    try {
      const { address, signature } = await signTyped(typedData)
      const res = await fetch(`${BACKEND_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body(signature)),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.detail ?? '제출 실패')
      setMessage(`${done} · 서명 지갑 ${shortAddr(address)}`)
      await refresh()
      onDone()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '서명 실패')
    } finally {
      setBusy(null)
    }
  }

  if (proposals.length === 0 && emergencies.length === 0 && !message)
    return (
      <div className="bg-white border-t-[5px] border-safety-yellow-dark p-5">
        <p className="text-lg font-black">내 지갑 서명 대기 · 0건</p>
        <p className="text-sm text-ink-muted">기기 등록 승인이나 예외 출입 공동 서명 요청이 오면 여기에 떠요.</p>
      </div>
    )

  return (
    <div className="bg-white border-t-[5px] border-safety-yellow-dark p-5 space-y-1">
      <p className="text-lg font-black">내 지갑 서명 대기 · {proposals.length + emergencies.length}건</p>
      <p className="text-xs text-ink-muted">감리 또는 발주처 지갑으로 서명 · 가스비는 시공사 부담</p>
      <div className="divide-y divide-charcoal/10">
        {proposals.map((p) => (
          <div key={`p${p.proposalId}`} className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-sm">
            <span className="text-ink">
              {p.role === 'device' ? '게이트 기기' : '감독자'} 등록 승인 요청 · {p.accountName === p.account ? shortAddr(p.account) : p.accountName}
              <span className="block text-xs text-ink-muted">시공사가 제안했고, 감리·발주처가 승인해야 서명 권한이 생깁니다</span>
            </span>
            <SecondaryButton
              className="!px-3 !py-1.5 !text-sm !bg-safety-yellow-dark !text-charcoal !border-0"
              disabled={busy !== null}
              onClick={() =>
                sign(`p${p.proposalId}`, p.typedData, '/signers/approve', (signature) => ({ proposalId: p.proposalId, signature }), '등록을 승인했습니다')
              }
            >
              {busy === `p${p.proposalId}` ? '지갑 서명 대기...' : '지갑으로 승인'}
            </SecondaryButton>
          </div>
        ))}
        {emergencies.map((e) => (
          <div key={e.nonce} className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-sm">
            <span className="text-ink">
              예외 출입 공동 서명 요청 · {e.reason}
              <span className="block text-xs text-ink-muted">
                감독자 {e.supervisor} 서명 완료 · {new Date(e.createdAt * 1000).toLocaleTimeString()} 요청 (1시간 안에 서명)
              </span>
            </span>
            <SecondaryButton
              className="!px-3 !py-1.5 !text-sm !bg-safety-yellow-dark !text-charcoal !border-0"
              disabled={busy !== null}
              onClick={() =>
                sign(e.nonce, e.typedData, '/gate/emergency/cosign', (signature) => ({ nonce: e.nonce, signature }), '예외 출입을 공동 서명했습니다')
              }
            >
              {busy === e.nonce ? '지갑 서명 대기...' : '지갑으로 공동 서명'}
            </SecondaryButton>
          </div>
        ))}
      </div>
      {message && <p className="text-xs font-semibold text-ink">{message}</p>}
    </div>
  )
}
