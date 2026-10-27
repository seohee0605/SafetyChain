import { useCallback, useEffect, useState } from 'react'
import { Card, ErrorText, Input, PageTitle, SecondaryButton, Select } from '../components/ui'
import { AUDIT_URL, BACKEND_URL } from '../config'
import { shortAddr, signTyped, type TypedData } from '../wallet'

// 감리가 보는 화면. 시공사 백엔드가 아니라 감리 감사 저장소(게이트가 직접 보낸 원본)와 체인을 대조한다.
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

// 번호 띠 한 칸의 상태. 'gap'은 게이트도 체인도 모르는 번호 (게이트가 서명했지만 어디에도 전달되지 않음)
type Cell = AuditState | 'rejected' | 'chainOnly' | 'gap'

const CELL_STYLE: Record<Cell, { cls: string; label: string }> = {
  anchored: { cls: 'bg-hazard-green text-white', label: '체인 확인' },
  pending: { cls: 'bg-safety-yellow text-charcoal', label: '체인 반영 대기' },
  missing: { cls: 'bg-hazard-red text-white', label: '받을 수 있었는데 제출 안 됨' },
  rejected: { cls: 'bg-hazard-red/15 text-hazard-red', label: '체인이 거부' },
  replaced: { cls: 'bg-charcoal text-safety-yellow', label: '다른 기록으로 바꿔치기' },
  mismatch: { cls: 'bg-charcoal text-safety-yellow', label: '체인 값과 다름' },
  chainOnly: { cls: 'bg-white text-charcoal border-dashed', label: '체인에만 있음' },
  gap: { cls: 'bg-paper-dark text-ink-muted', label: '어디에도 없음' },
}

const PROBLEM: AuditState[] = ['missing', 'replaced', 'mismatch', 'pending']

const time = (ts: number) => new Date(ts * 1000).toLocaleTimeString()
const short = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`

export default function Audit() {
  const [siteId, setSiteId] = useState('')
  const [loadedSite, setLoadedSite] = useState<string | null>(null)
  const [data, setData] = useState<Summary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState(true)
  const [rejections, setRejections] = useState<Rejection[]>([])

  const load = useCallback(async (site: string) => {
    try {
      const res = await fetch(`${AUDIT_URL}/summary/${encodeURIComponent(site)}`)
      if (!res.ok) throw new Error(`감사 저장소 응답 오류 (${res.status})`)
      setData(await res.json())
      setLoadedSite(site)
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

  const problems = (data?.records.filter((r) => PROBLEM.includes(r.audit)) ?? []).sort((a, b) => a.deviceSeq - b.deviceSeq)

  return (
    <div className="space-y-5">
      <PageTitle
        title="감리 감사"
        subtitle="게이트가 서명 직후 감리에 직접 보낸 원본과 블록체인 기록을 대조합니다"
      />

      <div className="flex gap-2">
        <Input placeholder="현장 ID" value={siteId} onChange={(e) => setSiteId(e.target.value)} className="flex-1" />
        <SecondaryButton onClick={() => load(siteId)} disabled={!siteId}>
          대조
        </SecondaryButton>
      </div>

      {error && <ErrorText>{error}</ErrorText>}

      {data && (
        <>
          <Verdict data={data} live={live} onToggleLive={() => setLive((v) => !v)} />

          <Card>
            <div className="flex flex-wrap justify-between items-baseline gap-2">
              <p className="font-display font-bold uppercase tracking-wide text-charcoal">게이트 기기 일련번호</p>
              <Legend />
            </div>
            {data.devices.length === 0 && <p className="text-sm text-ink-muted">아직 게이트 기록이 없습니다.</p>}
            {data.devices.map((d) => (
              <SequenceStrip key={d.address} device={d} records={data.records} chainOnly={data.chainOnly} />
            ))}
          </Card>

          {problems.length > 0 && (
            <Card>
              <p className="font-display font-bold uppercase tracking-wide text-charcoal">확인이 필요한 기록</p>
              <div className="divide-y-2 divide-charcoal/10">
                {problems.map((r) => (
                  <div key={r.nonce} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                    <span className="font-display font-extrabold text-lg w-12 text-charcoal">#{r.deviceSeq}</span>
                    <span className="flex-1 text-ink">
                      {r.passed ? '검사 통과' : '검사 불합격'}
                      <span className="text-ink-muted"> · 게이트 서명 {time(r.signedAt)}</span>
                      {r.chainCheck?.verdict === 'withheld' && (
                        <span className="block text-xs text-hazard-red font-semibold">
                          체인에 직접 모의 실행: 받을 수 있는 기록인데 제출되지 않음
                        </span>
                      )}
                      {r.chainCheck?.verdict === 'rejected' && (
                        <span className="block text-xs text-ink-muted">
                          체인에 직접 모의 실행: 거부됨 · {ERROR_LABEL[r.chainCheck.reason ?? ''] ?? r.chainCheck.reason}
                        </span>
                      )}
                    </span>
                    {r.inContractorDb !== null && (
                      <span className="shrink-0 text-xs text-ink-muted">시공사 DB {r.inContractorDb ? '있음' : '없음'}</span>
                    )}
                    {(() => {
                      const cell: Cell = r.chainCheck?.verdict === 'rejected' ? 'rejected' : r.audit
                      return (
                        <span className={`shrink-0 px-2 py-1 border-2 border-charcoal text-xs font-semibold ${CELL_STYLE[cell].cls}`}>
                          {CELL_STYLE[cell].label}
                        </span>
                      )
                    })()}
                  </div>
                ))}
              </div>
              {data.conflicts.length > 0 && (
                <p className="text-xs text-ink-muted">
                  같은 일련번호로 다른 기록을 감사 저장소에 덮어쓰려던 시도 {data.conflicts.length}건 (원본은 그대로 보존)
                </p>
              )}
            </Card>
          )}

          <PendingSignatures site={loadedSite ?? siteId} onDone={() => loadedSite && load(loadedSite)} />

          <Card>
            <p className="font-display font-bold uppercase tracking-wide text-charcoal">긴급·장비 장애 예외 출입</p>
            {data.emergencies.length === 0 ? (
              <p className="text-sm text-ink-muted">예외 출입 기록이 없습니다.</p>
            ) : (
              <div className="divide-y-2 divide-charcoal/10">
                {data.emergencies.map((e) => (
                  <div key={e.nonce} className="flex justify-between gap-3 py-2 text-sm">
                    <span className="text-ink">{e.reason}</span>
                    <span className="shrink-0 text-ink-muted text-xs">
                      {new Date(e.anchoredAt * 1000).toLocaleString()} · 감독자 {short(e.supervisor)} + {short(e.approver)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <p className="font-display font-bold uppercase tracking-wide text-charcoal">서명자 해제 이력</p>
            {data.revocations.length === 0 ? (
              <p className="text-sm text-ink-muted">해제된 서명자가 없습니다.</p>
            ) : (
              <div className="divide-y-2 divide-charcoal/10">
                {data.revocations.map((r, i) => (
                  <div key={i} className="py-2.5 text-sm space-y-0.5">
                    <p className="text-ink font-semibold">
                      {r.role === 'device' ? '게이트 기기' : '감독자'} {short(r.account)} 해제 · {r.reason}
                    </p>
                    <p className="text-ink-muted text-xs">
                      {new Date(r.revokedAt * 1000).toLocaleString()} · 해제 직전 마지막 번호 #{r.lastSeq} · 그 시점 체인 누락 {r.missingAtRevoke}건
                    </p>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <div className="flex flex-wrap justify-between items-baseline gap-2">
              <p className="font-display font-bold uppercase tracking-wide text-charcoal">체인이 거부한 제출</p>
              <span className="text-xs text-ink-muted">시공사 릴레이 로그</span>
            </div>
            {rejections.length === 0 ? (
              <p className="text-sm text-ink-muted">거부된 제출이 없습니다.</p>
            ) : (
              <div className="divide-y-2 divide-charcoal/10">
                {rejections.map((r, i) => (
                  <div key={i} className="flex justify-between gap-3 py-2 text-sm">
                    <span className="text-ink">
                      {KIND_LABEL[r.kind] ?? r.kind} · {ERROR_LABEL[r.error] ?? r.error}
                    </span>
                    <span className="shrink-0 text-ink-muted text-xs">{new Date(r.at * 1000).toLocaleString()}</span>
                  </div>
                ))}
              </div>
            )}
            <p className="text-xs text-ink-muted">
              시공사 릴레이가 스스로 남긴 기록입니다. 미제출 기록의 실제 거부 여부·사유는 감사 저장소가 체인에 직접 모의 실행해 위 목록에 표시하므로, 이 로그와 다르면 위 결과가 기준입니다.
            </p>
          </Card>

          <DemoTools onChanged={() => loadedSite && load(loadedSite)} />
        </>
      )}
    </div>
  )
}

function Verdict({ data, live, onToggleLive }: { data: Summary; live: boolean; onToggleLive: () => void }) {
  const c = data.counts
  // 체인이 거부한 기록은 정상적인 거부라 누락·변조 의심에서 뺀다 (사유는 목록에 표시)
  const flagged = c.withheld + c.replaced + c.mismatch
  const k = data.contractor
  const ok = flagged === 0 && c.chainOnly === 0 && (!k || k.contractorOnly === 0)
  return (
    <div className={`border-2 border-charcoal p-5 ${ok ? 'bg-white' : 'bg-hazard-red text-white'}`}>
      <div className="flex justify-between items-start gap-3">
        <div>
          <p className="text-4xl font-display font-extrabold leading-none">
            {ok ? '누락 없음' : `누락·변조 의심 ${flagged + c.chainOnly}건`}
          </p>
          <p className={`text-sm mt-2 ${ok ? 'text-ink-muted' : 'text-white/85'}`}>
            게이트 원본 {c.auditTotal}건 중 체인 확인 {c.anchored}건
            {c.pending > 0 && ` · 반영 대기 ${c.pending}건 (${data.graceSeconds}초 지나면 미제출로 판정)`}
          </p>
          <p className={`text-xs mt-1 ${ok ? 'text-ink-muted' : 'text-white/85'}`}>
            {k
              ? `3자 대조: 게이트 원본 ${c.auditTotal} · 시공사 DB ${k.total} · 블록체인 ${c.chainTotal}`
              : '시공사 DB에 연결할 수 없어 게이트 원본과 블록체인만 대조했습니다'}
          </p>
        </div>
        <button
          onClick={onToggleLive}
          className={`shrink-0 text-xs font-semibold border-2 px-2 py-1 ${ok ? 'border-charcoal text-charcoal' : 'border-white text-white'}`}
        >
          {live ? '실시간 대조 중' : '실시간 대조 꺼짐'}
        </button>
      </div>
      {!ok && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4 text-sm">
          <Stat n={c.withheld} label="받을 수 있었는데 안 냄" />
          <Stat n={c.replaced} label="바꿔치기" />
          <Stat n={c.mismatch} label="값 불일치" />
          <Stat n={c.chainRejected} label="체인이 거부 (사유 확인)" />
          <Stat n={c.chainOnly} label="체인에만 있음" />
          {k && <Stat n={k.hidden} label="시공사 DB에서도 사라짐" />}
          {k && <Stat n={k.contractorOnly} label="시공사 DB에만 있음" />}
        </div>
      )}
    </div>
  )
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div className="border-2 border-white/60 px-3 py-2">
      <p className="text-2xl font-display font-extrabold leading-none">{n}</p>
      <p className="text-xs text-white/85 mt-1">{label}</p>
    </div>
  )
}

function Legend() {
  const keys: Cell[] = ['anchored', 'pending', 'missing', 'rejected', 'replaced', 'chainOnly', 'gap']
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-muted">
      {keys.map((k) => (
        <span key={k} className="flex items-center gap-1">
          <span className={`w-3 h-3 inline-block border border-charcoal ${CELL_STYLE[k].cls}`} />
          {CELL_STYLE[k].label}
        </span>
      ))}
    </div>
  )
}

// 기기가 매긴 번호를 한 줄로 늘어놓는다. 빠진 칸이 곧 시공사가 체인에 내지 않은 기록이다
function SequenceStrip({ device, records, chainOnly }: { device: DeviceRow; records: AuditRecord[]; chainOnly: ChainOnly[] }) {
  const max = Math.max(device.chainHighestSeq, device.auditHighestSeq)
  const bySeq = new Map<number, Cell>()
  chainOnly.filter((c) => c.device === device.address).forEach((c) => bySeq.set(c.deviceSeq, 'chainOnly'))
  records
    .filter((r) => r.device === device.address)
    .forEach((r) => bySeq.set(r.deviceSeq, r.chainCheck?.verdict === 'rejected' ? 'rejected' : r.audit))
  const cells = Array.from({ length: max }, (_, i) => i + 1)

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap justify-between gap-2 text-sm">
        <span className="font-semibold text-ink">
          기기 {short(device.address)}{' '}
          <span className={device.active ? 'text-hazard-green' : 'text-hazard-red'}>{device.active ? '등록됨' : '해제됨'}</span>
        </span>
        <span className="text-ink-muted">
          체인이 아는 빈 번호 <b className="text-charcoal">{device.chainMissing}</b>개 · 감사 저장소 원본 {device.auditCount}건
        </span>
      </div>
      <div className="flex flex-wrap gap-1" role="list" aria-label="일련번호별 상태">
        {cells.map((seq) => {
          const cell = bySeq.get(seq) ?? 'gap'
          return (
            <span
              key={seq}
              role="listitem"
              title={`#${seq} ${CELL_STYLE[cell].label}`}
              className={`w-9 h-9 flex items-center justify-center border-2 border-charcoal text-xs font-display font-bold ${CELL_STYLE[cell].cls}`}
            >
              {seq}
            </span>
          )
        })}
      </div>
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

  if (!enabled) return null

  const modes: { key: RelayMode; label: string }[] = [
    { key: 'normal', label: '정상 제출' },
    { key: 'paused', label: '릴레이 중단' },
    { key: 'drop_failed', label: '불합격만 빼고 제출' },
  ]

  return (
    <details className="border-2 border-dashed border-charcoal/50 p-4 text-sm">
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

  if (proposals.length === 0 && emergencies.length === 0 && !message) return null

  return (
    <Card>
      <div className="flex flex-wrap justify-between items-baseline gap-2">
        <p className="font-display font-bold uppercase tracking-wide text-charcoal">지갑 서명 대기</p>
        <span className="text-xs text-ink-muted">감리 또는 발주처 지갑으로 서명 · 가스비는 시공사 부담</span>
      </div>
      <div className="divide-y-2 divide-charcoal/10">
        {proposals.map((p) => (
          <div key={`p${p.proposalId}`} className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-sm">
            <span className="text-ink">
              {p.role === 'device' ? '게이트 기기' : '감독자'} 등록 승인 요청 · {p.accountName === p.account ? shortAddr(p.account) : p.accountName}
              <span className="block text-xs text-ink-muted">시공사가 제안했고, 감리·발주처가 승인해야 서명 권한이 생깁니다</span>
            </span>
            <SecondaryButton
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
    </Card>
  )
}
