import { useEffect, useState } from 'react'
import { Card, ErrorText, Input, PageTitle, PrimaryButton, SecondaryButton, Select, StatusBadge, StepHeading, TechDetails } from '../components/ui'
import { BACKEND_URL } from '../config'
import { shortAddr, signTyped, type TypedData } from '../wallet'

type Admin = { name: string; address: string }
type Reviewer = { role: 'inspector' | 'owner'; name: string; address: string }
type Reason = { code: number; label: string }
type CaseVerify = { scopeIntact: boolean; recordsPresent: boolean; addedAfterSubmit: number }

type CheckInRow = {
  nonce: string
  txHash: string
  helmetPass: boolean
  shoesPass: boolean
  alcoholPass: boolean
  timestamp: number
  overridden: boolean
  overrideReason: string | null
  entryStatus: 'Granted' | 'Denied' | 'HeldNoAssessment' | 'HeldHazardsOpen' | 'LateAuditOnly' | 'SuspectTimestamp' | null
}

type SiteRecordRow = {
  nonce: string
  txHash: string
  processSummary: string
  hazardsControlled: boolean
  timestamp: number
}

type CaseStatus = 'None' | 'Submitted' | 'InspectorApproved' | 'Finalized' | 'Rejected'

type HistoryRow = {
  action: 'submit' | 'approve' | 'reject'
  reasonCode: number
  reason: string | null
  actorName: string
  anchoredAt: number
}

type CaseBundle = {
  caseId: string
  siteRecords: SiteRecordRow[]
  checkIns: CheckInRow[]
  emergencies?: { nonce: string; reason: string | null; timestamp: number; supervisor: string; approver: string }[]
  state: { status: CaseStatus; scopeHash: string; round: number }
  history: HistoryRow[]
}

const today = () => new Date().toISOString().slice(0, 10)

const STEPS: { key: CaseStatus[]; label: string }[] = [
  { key: ['Submitted', 'InspectorApproved', 'Finalized'], label: '시공사 제출' },
  { key: ['InspectorApproved', 'Finalized'], label: '감리 승인' },
  { key: ['Finalized'], label: '발주처 승인 · 확정' },
]

const ACTION_LABEL = { submit: '제출', approve: '승인', reject: '반려' }

// 하루치 기록(case) 확정: 시공사 제출 -> 감리 승인 -> 발주처 승인 (순서는 컨트랙트가 강제)
export default function CaseReview() {
  const [admins, setAdmins] = useState<Admin[]>([])
  const [reviewers, setReviewers] = useState<Reviewer[]>([])
  const [rejectReasons, setRejectReasons] = useState<Reason[]>([])
  const [adminName, setAdminName] = useState('')
  const [rejectCode, setRejectCode] = useState(1)
  const [siteId, setSiteId] = useState('')
  const [workDate, setWorkDate] = useState(today())
  const [bundle, setBundle] = useState<CaseBundle | null>(null)
  const [check, setCheck] = useState<CaseVerify | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [signingMode, setSigningMode] = useState<'wallet' | 'server'>('wallet')
  const [signedBy, setSignedBy] = useState<string | null>(null)

  useEffect(() => {
    fetch(`${BACKEND_URL}/admins`)
      .then((res) => res.json())
      .then((list: Admin[]) => {
        setAdmins(list)
        if (list.length > 0) setAdminName(list[0].name)
      })
      .catch(() => {})
    fetch(`${BACKEND_URL}/reviewers`)
      .then((res) => res.json())
      .then(setReviewers)
      .catch(() => {})
    fetch(`${BACKEND_URL}/reasons`)
      .then((res) => res.json())
      .then((r: { reject: Reason[] }) => setRejectReasons(r.reject))
      .catch(() => {})
    fetch(`${BACKEND_URL}/signing-mode`)
      .then((res) => res.json())
      .then((m: { mode: 'wallet' | 'server' }) => setSigningMode(m.mode))
      .catch(() => {})
  }, [])

  async function loadCase() {
    if (!siteId || !workDate) return
    setError(null)
    const path = `${encodeURIComponent(siteId)}/${workDate}`
    const [res, verifyRes] = await Promise.all([
      fetch(`${BACKEND_URL}/case/${path}`),
      fetch(`${BACKEND_URL}/verify/case/${path}`),
    ])
    if (res.ok) setBundle(await res.json())
    if (verifyRes.ok) setCheck(await verifyRes.json())
  }

  async function post(path: string, body: object) {
    setError(null)
    setLoading(true)
    try {
      const res = await fetch(`${BACKEND_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId, workDate, ...body }),
      })
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error(b.detail ?? '제출 실패')
      }
      await loadCase()
    } catch (e) {
      setError(e instanceof Error ? e.message : '알 수 없는 오류')
    } finally {
      setLoading(false)
    }
  }

  // 감리·발주처 검토: 지갑 모드에서는 서버가 서명할 내용만 주고, 서명은 검토자의 지갑에서 만든다
  async function review(decision: 'approve' | 'reject') {
    if (!turn) return
    const body = { reviewer: turn, decision, reasonCode: decision === 'reject' ? rejectCode : 0 }
    if (signingMode === 'server') return post('/case/review', body)
    setError(null)
    setSignedBy(null)
    setLoading(true)
    try {
      const prep = await fetch(`${BACKEND_URL}/case/review/prepare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId, workDate, ...body }),
      })
      const p = await prep.json().catch(() => ({}))
      if (!prep.ok) throw new Error(p.detail ?? '서명 준비 실패')
      const { address, signature } = await signTyped(p.typedData as TypedData)
      if (reviewer && address.toLowerCase() !== reviewer.address.toLowerCase()) {
        throw new Error(`연결된 지갑(${shortAddr(address)})이 ${reviewer.name} 주소(${shortAddr(reviewer.address)})가 아닙니다. 지갑 계정을 바꿔 주세요`)
      }
      const res = await fetch(`${BACKEND_URL}/case/review/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce: p.nonce, signature }),
      })
      const r = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(r.detail ?? '제출 실패')
      setSignedBy(address)
      await loadCase()
    } catch (e) {
      setError(e instanceof Error ? e.message : '알 수 없는 오류')
    } finally {
      setLoading(false)
    }
  }

  const status = bundle?.state.status ?? 'None'
  const hasRecords = bundle && (bundle.siteRecords.length > 0 || bundle.checkIns.length > 0)
  const canSubmit = status === 'None' || status === 'Rejected'
  const turn: Reviewer['role'] | null =
    status === 'Submitted' ? 'inspector' : status === 'InspectorApproved' ? 'owner' : null
  const reviewer = reviewers.find((r) => r.role === turn)

  return (
    <div className="space-y-5">
      <PageTitle
        title="케이스 확정 · 다중 서명"
        subtitle="시공사 제출 → 감리 승인 → 발주처 승인을 모두 거쳐야 하루치 기록이 확정됩니다"
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
          <div className="flex gap-1.5">
            {STEPS.map((s) => (
              <div
                key={s.label}
                className={`flex-1 text-center text-xs font-display font-bold uppercase py-2 border-2 border-charcoal ${
                  s.key.includes(status) ? 'bg-hazard-green text-white' : 'bg-paper-dark text-ink-muted'
                }`}
              >
                {s.label}
              </div>
            ))}
          </div>
          {status === 'Rejected' && (
            <p className="text-sm text-hazard-red font-semibold">반려됨 · 보완 후 재제출 필요 (제출 {bundle.state.round}회차)</p>
          )}
          {status === 'Finalized' && <p className="text-sm text-hazard-green font-semibold">최종 확정 · 더 이상 변경할 수 없습니다</p>}
        </Card>
      )}

      {bundle && (
        <Card>
          <StepHeading step={2}>이 케이스에 걸린 기록</StepHeading>
          <TechDetails rows={[['caseId', bundle.caseId], ['제출 범위 해시', bundle.state.scopeHash]]} />

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
              근로자 검사 ({bundle.checkIns.length}건 · 수동 처리 {bundle.checkIns.filter((c) => c.overridden).length}건)
            </p>
            {bundle.checkIns.length === 0 && <p className="text-sm text-ink-muted">없음</p>}
            {bundle.checkIns.map((c) => {
              const allPassed = c.helmetPass && c.shoesPass && c.alcoholPass
              return (
                <div key={c.nonce} className="border-2 border-charcoal/20 p-2.5 mb-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-ink-muted text-xs">{new Date(c.timestamp * 1000).toLocaleTimeString()} 출입 검사</span>
                    {c.entryStatus === 'HeldNoAssessment' ? (
                      <span className="text-safety-orange font-semibold">위험성평가 전 · 출입 보류</span>
                    ) : c.entryStatus === 'HeldHazardsOpen' ? (
                      <span className="text-safety-orange font-semibold">위험요인 미조치 · 출입 보류</span>
                    ) : c.entryStatus === 'SuspectTimestamp' ? (
                      <span className="text-ink-muted font-semibold">기록 시각 의심 · 감사용</span>
                    ) : c.entryStatus === 'LateAuditOnly' ? (
                      <span className="text-ink-muted font-semibold">지연 도착 · 감사용</span>
                    ) : (
                      <span className={allPassed ? 'text-hazard-green font-semibold' : 'text-hazard-red font-semibold'}>
                        {allPassed ? '통과' : c.overridden ? '불합격 → 수동 승인' : '불합격'}
                      </span>
                    )}
                  </div>
                  {c.overridden && <p className="text-xs text-ink-muted mt-1">수동 처리 사유: {c.overrideReason}</p>}
                </div>
              )
            })}
          </div>

          {bundle.emergencies && bundle.emergencies.length > 0 && (
            <div>
              <p className="font-display font-bold uppercase text-sm text-charcoal mb-2">
                긴급·장비 장애 예외 출입 ({bundle.emergencies.length}건)
              </p>
              {bundle.emergencies.map((e) => (
                <div key={e.nonce} className="border-2 border-charcoal/20 p-2.5 mb-2 text-sm flex justify-between gap-2">
                  <span className="text-ink">{e.reason}</span>
                  <span className="text-ink-muted text-xs">
                    {new Date(e.timestamp * 1000).toLocaleTimeString()} · {e.supervisor} + {e.approver}
                  </span>
                </div>
              ))}
            </div>
          )}

          {check && bundle.state.round > 0 && (
            <div className="space-y-2 pt-2">
              <StatusBadge ok={check.scopeIntact} label="제출한 기록 목록이 블록체인 값과 일치" />
              <StatusBadge ok={check.recordsPresent} label="제출한 기록이 전부 블록체인에 있음" />
              {check.addedAfterSubmit > 0 && (
                <p className="text-xs text-ink-muted">제출 이후 추가된 기록 {check.addedAfterSubmit}건 (이번 승인 범위 밖)</p>
              )}
            </div>
          )}
        </Card>
      )}

      {bundle && canSubmit && (
        <Card>
          <StepHeading step={3}>시공사 감독자 제출</StepHeading>
          <Select value={adminName} onChange={(e) => setAdminName(e.target.value)}>
            {admins.length === 0 && <option value="">등록된 감독자 없음</option>}
            {admins.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
              </option>
            ))}
          </Select>
          <p className="text-xs text-ink-muted">
            지금 보이는 기록 전체를 검토 범위로 고정해 제출합니다. 제출만으로는 확정되지 않고 감리·발주처 승인이 필요합니다.
          </p>
          <PrimaryButton
            onClick={() => post('/case/submit', { supervisorName: adminName })}
            disabled={!hasRecords || !adminName || loading}
            className="w-full"
          >
            {loading ? '서명 중...' : status === 'Rejected' ? '보완 후 재제출' : '제출'}
          </PrimaryButton>
        </Card>
      )}

      {bundle && turn && (
        <Card>
          <StepHeading step={3}>{turn === 'inspector' ? '감리 검토' : '발주처 최종 검토'}</StepHeading>
          <p className="text-xs text-ink-muted">
            서명자: {reviewer ? `${reviewer.name} (${shortAddr(reviewer.address)})` : '설정되지 않음'} · 시공사가 제출한 범위 그대로 승인 또는 반려합니다.
          </p>
          {signingMode === 'wallet' ? (
            <p className="text-xs bg-paper-dark border-2 border-charcoal/30 p-2.5 text-ink">
              {turn === 'inspector' ? '감리' : '발주처'} 담당자의 지갑(MetaMask)으로 서명합니다. 서버는 이 서명을 대신 만들 수 없고,
              가스비는 시공사가 냅니다.
            </p>
          ) : (
            <p className="text-xs text-hazard-red">백업 모드: 서버가 보관한 키로 대신 서명합니다 (데모 장애 대비용)</p>
          )}
          <PrimaryButton onClick={() => review('approve')} disabled={!reviewer || loading} className="w-full">
            {loading ? '지갑 서명 대기 중...' : signingMode === 'wallet' ? '지갑으로 서명해 승인' : '승인'}
          </PrimaryButton>
          <div className="flex gap-2">
            <Select value={rejectCode} onChange={(e) => setRejectCode(Number(e.target.value))} className="flex-1">
              {rejectReasons.map((r) => (
                <option key={r.code} value={r.code}>
                  {r.label}
                </option>
              ))}
            </Select>
            <SecondaryButton onClick={() => review('reject')} disabled={!reviewer || loading}>
              {signingMode === 'wallet' ? '지갑으로 반려' : '반려'}
            </SecondaryButton>
          </div>
          {signedBy && <p className="text-xs text-hazard-green font-semibold">{shortAddr(signedBy)} 지갑 서명으로 기록됐습니다</p>}
        </Card>
      )}

      {error && <ErrorText>{error}</ErrorText>}

      {bundle && bundle.history.length > 0 && (
        <div className="space-y-2.5">
          <h2 className="font-display font-bold uppercase tracking-wide text-charcoal text-lg">온체인 이력 (삭제 불가)</h2>
          {bundle.history.map((h, i) => (
            <Card key={i}>
              <div className="flex justify-between items-center">
                <span className="text-sm text-ink-muted">{new Date(h.anchoredAt * 1000).toLocaleString()}</span>
                <span
                  className={`text-xs font-display font-bold uppercase px-2.5 py-1 border-2 border-charcoal text-white ${
                    h.action === 'reject' ? 'bg-hazard-red' : 'bg-hazard-green'
                  }`}
                >
                  {ACTION_LABEL[h.action]}
                </span>
              </div>
              <p className="text-xs text-ink-muted">
                서명자: {h.actorName}
                {h.reason ? ` · 반려 사유: ${h.reason}` : ''}
              </p>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
