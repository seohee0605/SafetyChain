import { useEffect, useState, type ReactNode } from 'react'
import {
  BottomBar,
  hhmm,
  Label,
  NavButton,
  ResultPanel,
  shortHex,
  SitePicker,
  StepBar,
  todayLocal,
  TitleBar,
  Warn,
  type StepState,
} from '../components/kiosk'
import { ErrorText, Select, Textarea } from '../components/ui'
import { AUDIT_URL, BACKEND_URL } from '../config'
import { OptionList } from './gate/Modal'
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
  deviceSeq?: number
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

// 감리 감사 저장소(8100)가 아는 게이트 원본 중 체인에 없는 것 = 누락
type AuditRecord = { nonce: string; deviceSeq: number; signedAt: number; passed: boolean; audit: string }

const localDate = (sec: number) => new Date(sec * 1000).toLocaleDateString('sv-SE')
const ZERO_HASH = /^0x0*$/
const ROLE_LABEL = { contractor: '시공사', inspector: '감리', owner: '발주처' }

// 하루치 기록(case) 확정: 시공사 제출 → 감리 승인 → 발주처 승인 (순서는 컨트랙트가 강제). 목업 case-mockup
export default function CaseReview() {
  const [admins, setAdmins] = useState<Admin[]>([])
  const [reviewers, setReviewers] = useState<Reviewer[]>([])
  const [rejectReasons, setRejectReasons] = useState<Reason[]>([])
  const [adminName, setAdminName] = useState('')
  const [rejectCode, setRejectCode] = useState(1)
  const [rejectMemo, setRejectMemo] = useState('')
  const [rejecting, setRejecting] = useState(false)
  const [siteId, setSiteId] = useState('')
  const [workDate, setWorkDate] = useState(todayLocal())
  const [bundle, setBundle] = useState<CaseBundle | null>(null)
  const [check, setCheck] = useState<CaseVerify | null>(null)
  const [missing, setMissing] = useState<AuditRecord[] | null>(null) // null: 감사 저장소에 연결 못 함
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [walletPrompt, setWalletPrompt] = useState<'approve' | 'reject' | null>(null)
  const [signingMode, setSigningMode] = useState<'wallet' | 'server'>('wallet')

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
    const [res, verifyRes] = await Promise.all([fetch(`${BACKEND_URL}/case/${path}`), fetch(`${BACKEND_URL}/verify/case/${path}`)])
    if (res.ok) setBundle(await res.json())
    if (verifyRes.ok) setCheck(await verifyRes.json())
    // 누락은 시공사 백엔드가 아니라 감리 감사 저장소 기준으로 센다
    fetch(`${AUDIT_URL}/summary/${encodeURIComponent(siteId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((s: { records: AuditRecord[] }) => setMissing(s.records.filter((r) => r.audit === 'missing' && localDate(r.signedAt) === workDate)))
      .catch(() => setMissing(null))
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
      setRejecting(false)
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
    setLoading(true)
    setWalletPrompt(decision)
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
      setRejecting(false)
      await loadCase()
    } catch (e) {
      setError(e instanceof Error ? e.message : '알 수 없는 오류')
    } finally {
      setLoading(false)
      setWalletPrompt(null)
    }
  }

  const status = bundle?.state.status ?? 'None'
  const round = bundle?.state.round ?? 0
  const hasRecords = bundle && (bundle.siteRecords.length > 0 || bundle.checkIns.length > 0)
  const canSubmit = status === 'None' || status === 'Rejected'
  const turn: Reviewer['role'] | null = status === 'Submitted' ? 'inspector' : status === 'InspectorApproved' ? 'owner' : null
  const reviewer = reviewers.find((r) => r.role === turn)
  const admin = admins.find((a) => a.name === adminName)
  const scopeHash = bundle && !ZERO_HASH.test(bundle.state.scopeHash) ? bundle.state.scopeHash : null

  // 이번 회차의 이력만 (마지막 제출부터)
  const history = bundle?.history ?? []
  const lastSubmit = history.map((h) => h.action).lastIndexOf('submit')
  const roundHistory = lastSubmit >= 0 ? history.slice(lastSubmit) : []
  const submitted = roundHistory[0]
  const inspectorAct = roundHistory[1]
  const ownerAct = roundHistory[2]
  const rejectedBy = status === 'Rejected' ? (ownerAct?.action === 'reject' ? 'owner' : 'inspector') : null

  const actSub = (h?: HistoryRow, fallback = '대기') => (h ? `${h.actorName} · ${hhmm(h.anchoredAt)}${h.action === 'reject' ? ' · 반려' : ''}` : fallback)
  const steps: { label: string; sub?: string; state: StepState }[] = [
    { label: '시공사 제출', sub: status === 'Rejected' ? `${round}회차 반려 · 재제출 필요` : actSub(submitted, '제출 전'), state: canSubmit ? 'now' : 'done' },
    {
      label: '감리 승인',
      sub: actSub(inspectorAct, turn === 'inspector' ? reviewer?.name ?? '서명 대기' : '대기'),
      state: rejectedBy === 'inspector' ? 'rejected' : inspectorAct ? 'done' : turn === 'inspector' ? 'now' : 'todo',
    },
    {
      label: '발주처 승인',
      sub: actSub(ownerAct, turn === 'owner' ? reviewer?.name ?? '서명 대기' : '대기'),
      state: rejectedBy === 'owner' ? 'rejected' : ownerAct ? 'done' : turn === 'owner' ? 'now' : 'todo',
    },
    { label: '최종 확정', sub: status === 'Finalized' ? '확정' : '대기', state: status === 'Finalized' ? 'done' : 'todo' },
  ]

  // 카드 숫자
  const checkIns = bundle?.checkIns ?? []
  const granted = checkIns.filter((c) => c.entryStatus === 'Granted').length
  const overridden = checkIns.filter((c) => c.overridden).length
  const held = checkIns.filter((c) => c.entryStatus === 'HeldNoAssessment' || c.entryStatus === 'HeldHazardsOpen').length
  const late = checkIns.filter((c) => c.entryStatus === 'LateAuditOnly' || c.entryStatus === 'SuspectTimestamp').length
  const denied = checkIns.filter((c) => c.entryStatus === 'Denied' && !c.overridden).length
  const emergencies = bundle?.emergencies ?? []
  const missCount = missing?.length ?? 0

  const walletRole = canSubmit ? 'contractor' : turn
  const walletAddr = canSubmit ? admin?.address : reviewer?.address

  return (
    <div className="space-y-3.5 pb-2">
      <TitleBar title="하루치 기록 확정">
        <SitePicker siteId={siteId} workDate={workDate} onSite={setSiteId} onDate={setWorkDate} onLoad={loadCase} />
        {bundle && walletRole && walletAddr && (
          <span className="bg-charcoal text-white px-4 py-2.5 text-sm font-bold flex items-center gap-2">
            <i className="w-2 h-2 rounded-full bg-hazard-green" />
            {ROLE_LABEL[walletRole]} {signingMode === 'wallet' && walletRole !== 'contractor' ? '지갑' : '서명 키'}
            <span className="font-mono font-medium text-white/70">{shortAddr(walletAddr)}</span>
          </span>
        )}
      </TitleBar>

      {!bundle && <p className="text-ink-muted py-16 text-center text-lg">현장 ID와 날짜를 고르고 조회를 누르세요.</p>}

      {bundle && <StepBar steps={steps} />}

      {bundle && status === 'Finalized' && (
        <ResultPanel
          tone="green"
          icon="✓"
          title="최종 확정됐어요"
          sub={`${workDate} ${siteId} 현장 기록은 이제 바꿀 수 없어요`}
          chips={[
            { label: `게이트 검사 ${checkIns.length}` },
            { label: missing ? `누락 ${missCount}${late ? ` (지연 기록 ${late})` : ''}` : `지연 기록 ${late}` },
            { label: `수동 처리 ${overridden}` },
            { label: `예외 출입 ${emergencies.length}` },
            { label: `${round}회차 확정${history.filter((h) => h.action === 'reject').length ? ` · ${history.filter((h) => h.action === 'reject').length}회 반려` : ''}` },
          ]}
          note={
            scopeHash && (
              <span className="text-sm">
                제출 범위 해시 <code className="bg-black/20 px-2 py-0.5">{shortHex(scopeHash)}</code>
              </span>
            )
          }
          bar={
            <div className="bg-charcoal text-white grid sm:grid-cols-3">
              {roundHistory.map((h, i) => (
                <div key={i} className="px-5 py-3 border-r border-white/10">
                  <p className="font-bold">✓ {['시공사', '감리', '발주처'][i]} · {h.actorName}</p>
                  <p className="text-xs text-white/60">블록 포함 {hhmm(h.anchoredAt)}</p>
                </div>
              ))}
            </div>
          }
        />
      )}

      {bundle && status !== 'Finalized' && rejecting && (
        <div className="flex flex-col lg:flex-row gap-5">
          <div className="flex-1 space-y-2">
            <p className="text-3xl font-black">반려 사유를 골라 주세요</p>
            <p className="text-sm text-ink-muted">체인에는 사유 번호만 올라가고, 반려 기록도 지워지지 않아요.</p>
            <OptionList
              options={rejectReasons.map((r) => ({ value: r.code, label: r.label, note: `code ${r.code}` }))}
              value={rejectCode}
              onChange={setRejectCode}
            />
          </div>
          <div className="flex-1 flex flex-col gap-2">
            <Label note="(오프체인 메모 · 지금은 이 화면에만 보여요)">시공사에게 남길 말</Label>
            <Textarea
              rows={8}
              value={rejectMemo}
              onChange={(e) => setRejectMemo(e.target.value)}
              placeholder={missCount ? `게이트 일련번호 ${missing?.map((m) => m.deviceSeq).join(', ')} 검사 기록이 체인에 없습니다. 다시 올린 뒤 재제출해 주세요.` : ''}
            />
            <Warn danger>반려되면 시공사가 보완해서 {round + 1}회차로 다시 제출해요. {round}회차 제출과 반려 이력은 그대로 남아요.</Warn>
          </div>
        </div>
      )}

      {bundle && status !== 'Finalized' && !rejecting && (
        <>
          <div className="bg-white border-l-[5px] border-charcoal px-5 py-3 flex flex-wrap items-center gap-3 text-sm">
            <b className="text-base">제출 범위 해시</b>
            <code className="bg-paper-dark px-2 py-0.5 font-mono">{scopeHash ? shortHex(scopeHash) : '제출 전'}</code>
            {round > 0 && <span className="font-bold">{round}회차 제출</span>}
            <span className="ml-auto text-ink-muted">
              {canSubmit
                ? '제출하면 이 범위에 감리·발주처가 그대로 서명해야 확정돼요'
                : check
                  ? `${submitted ? `시공사가 ${hhmm(submitted.anchoredAt)}에 이 해시로 제출` : ''} · 체인 값 ${check.scopeIntact ? '일치 ✓' : '불일치 ✕'} · 기록 ${check.recordsPresent ? '모두 체인에 있음 ✓' : '일부 없음 ✕'}`
                  : ''}
            </span>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard
              title="게이트 검사"
              n={checkIns.length}
              detail={[
                granted && `통과 ${granted}`,
                overridden && `수동 처리 후 통과 ${overridden}`,
                held && `보류 ${held}`,
                denied && `불합격 ${denied}`,
                late && `지연 기록 ${late}`,
                missCount && `누락 ${missCount}`,
              ]
                .filter(Boolean)
                .join(' · ') || '기록 없음'}
            />
            <StatCard
              title="누락"
              badge="감리 저장소 기준"
              n={missing === null ? '?' : missCount}
              tone={missing === null ? undefined : missCount > 0 ? 'red' : 'ok'}
              detail={missing === null ? '감사 저장소(8100)에 연결할 수 없어요' : missCount > 0 ? '감리 저장소엔 있는데 체인에 없음' : late ? `다시 올린 ${late}건은 지연 기록으로 남음` : '게이트 원본이 모두 체인에 있음'}
            />
            <StatCard title="수동 처리" n={overridden} tone={overridden ? 'amber' : undefined} detail="AI 보호구 불합격을 감독자가 override" />
            <StatCard title="예외 출입" n={emergencies.length} detail="장비 장애·응급 · 감독자+감리 공동서명" muted={emergencies.length === 0} />
          </div>

          <div className="flex flex-col lg:flex-row gap-4">
            <div className="flex-1 bg-white border-t-[5px] border-charcoal p-5">
              <ItemList bundle={bundle} missing={missing ?? []} />
            </div>
            <div className="lg:w-[360px] flex flex-col gap-3">
              <div className="bg-charcoal text-white p-5">
                <p className="font-black">
                  서명 기록 <small className="font-medium text-white/50">· 세 기관이 같은 범위 해시에 서명</small>
                </p>
                {(['시공사', '감리', '발주처'] as const).map((role, i) => {
                  const h = roundHistory[i]
                  const isNow = (i === 0 && canSubmit) || (i === 1 && turn === 'inspector') || (i === 2 && turn === 'owner')
                  return (
                    <div key={role} className="flex justify-between py-2 border-b border-white/10 last:border-0">
                      <span className="font-bold">{role}</span>
                      <span className={h ? (h.action === 'reject' ? 'text-hazard-red font-bold' : 'text-hazard-green font-mono text-sm') : isNow ? 'text-safety-yellow font-bold' : 'text-white/50'}>
                        {h ? `${h.action === 'reject' ? '반려' : '서명'} ${hhmm(h.anchoredAt)} · ${h.actorName}` : isNow ? '서명 전' : '대기'}
                      </span>
                    </div>
                  )
                })}
              </div>
              {missCount > 0 && canSubmit && (
                <Warn>누락 {missCount}건은 감리 화면에 그대로 보여요. 그대로 제출하면 감리가 반려할 수 있어요.</Warn>
              )}
              {missCount > 0 && turn && (
                <Warn danger>
                  게이트가 감리 저장소로 보낸 원본 중 {missCount}건이 체인에 없어요. 일련번호 {missing?.map((m) => m.deviceSeq).join('·')}.
                </Warn>
              )}
              {turn === 'owner' && <Warn>발주처가 승인하면 하루치 기록이 최종 확정돼요. 이후에는 누구도 바꿀 수 없어요.</Warn>}
              {check && check.addedAfterSubmit > 0 && <Warn>제출 이후 추가된 기록 {check.addedAfterSubmit}건은 이번 승인 범위 밖이에요.</Warn>}
              {history.some((h) => h.action === 'reject') && (
                <div className="bg-white p-4 text-sm space-y-1">
                  <p className="text-xs font-bold text-ink-muted">제출 이력</p>
                  {history.map((h, i) => (
                    <p key={i} className={h.action === 'reject' ? 'text-hazard-red font-bold' : ''}>
                      {hhmm(h.anchoredAt)} · {h.actorName} {h.action === 'submit' ? '제출' : h.action === 'approve' ? '승인' : `반려 (${h.reason})`}
                    </p>
                  ))}
                </div>
              )}
              {signingMode === 'server' && <p className="text-xs text-hazard-red font-bold">백업 모드: 감리·발주처 서명을 서버가 보관한 키로 대신 만듭니다 (데모 장애 대비)</p>}
            </div>
          </div>
        </>
      )}

      {error && <ErrorText>{error}</ErrorText>}

      {bundle && (
        <BottomBar>
          {status === 'Finalized' ? (
            <a href="#/verify" className="ml-auto">
              <NavButton primary>검증 탭에서 확인 ▸</NavButton>
            </a>
          ) : rejecting ? (
            <>
              <NavButton onClick={() => setRejecting(false)}>← 돌아가기</NavButton>
              <NavButton danger className="ml-auto !bg-hazard-red !text-white" disabled={loading} onClick={() => review('reject')}>
                {signingMode === 'wallet' ? 'MetaMask로 반려 서명' : '반려 기록'}
              </NavButton>
            </>
          ) : canSubmit ? (
            <>
              <Select value={adminName} onChange={(e) => setAdminName(e.target.value)} className="!w-auto">
                {admins.map((a) => (
                  <option key={a.name} value={a.name}>
                    제출 감독자 {a.name}
                  </option>
                ))}
              </Select>
              <span className="ml-auto text-sm font-bold text-ink-muted">지금 보이는 기록 전체를 범위로 고정해 제출해요</span>
              <NavButton primary disabled={!hasRecords || !adminName || loading} onClick={() => post('/case/submit', { supervisorName: adminName })}>
                {loading ? '서명 중…' : status === 'Rejected' ? '보완해서 다시 제출' : missCount ? '그대로 서명하고 제출' : '서명하고 제출'}
              </NavButton>
            </>
          ) : turn ? (
            <>
              <NavButton danger disabled={!reviewer || loading} onClick={() => setRejecting(true)}>
                반려하기
              </NavButton>
              <span className="ml-auto text-sm font-bold text-ink-muted">
                {ROLE_LABEL[turn]} {reviewer ? `${reviewer.name} ${shortAddr(reviewer.address)}` : '서명자 설정 안 됨'}
              </span>
              <NavButton primary disabled={!reviewer || loading} onClick={() => review('approve')}>
                {loading ? '서명 대기 중…' : signingMode === 'wallet' ? (turn === 'owner' ? 'MetaMask로 승인하고 확정' : 'MetaMask로 승인') : '승인'}
              </NavButton>
            </>
          ) : null}
        </BottomBar>
      )}

      {walletPrompt && bundle && (
        <div className="fixed inset-0 z-50 bg-charcoal/60 grid place-items-center p-4">
          <div className="bg-white w-full max-w-xl border-t-8 border-safety-yellow p-7 space-y-3">
            <h2 className="text-2xl font-black">지갑 창에서 서명해 주세요</h2>
            <p className="text-ink-muted">MetaMask에 뜬 내용이 아래와 같은지 확인하고 '서명'을 눌러 주세요.</p>
            <div className="bg-paper-dark p-4 space-y-1.5 text-sm">
              <KV k="케이스" v={`${siteId} · ${workDate}`} />
              <KV k="제출 회차" v={`${round}회차`} />
              <KV k="제출 범위 해시" v={<code>{scopeHash ? shortHex(scopeHash) : '-'}</code>} />
              <KV k="동작" v={`${turn ? ROLE_LABEL[turn] : ''} ${walletPrompt === 'approve' ? '승인 (APPROVE)' : '반려 (REJECT)'}`} />
            </div>
            <p className="text-sm text-ink-muted">해시가 시공사 제출본과 한 글자라도 다르면 컨트랙트가 승인을 거부해요.</p>
            <p className="font-bold flex items-center gap-2.5">
              <span className="w-4 h-4 border-[3px] border-safety-yellow border-r-transparent rounded-full animate-spin" />
              서명을 기다리는 중…
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

function KV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-ink-muted">{k}</span>
      <b>{v}</b>
    </div>
  )
}

function StatCard(props: { title: string; badge?: string; n: number | string; detail: string; tone?: 'red' | 'amber' | 'ok'; muted?: boolean }) {
  const look =
    props.tone === 'red'
      ? 'border-hazard-red bg-hazard-red/10'
      : props.tone === 'amber'
        ? 'border-safety-yellow-dark bg-safety-yellow/15'
        : props.tone === 'ok'
          ? 'border-hazard-green bg-hazard-green/10'
          : 'border-charcoal/15 bg-white'
  const num = props.tone === 'red' ? 'text-hazard-red' : props.tone === 'amber' ? 'text-safety-yellow-dark' : props.muted ? 'text-ink-muted/50' : 'text-charcoal'
  return (
    <div className={`border-2 p-4 ${look}`}>
      <p className="text-sm font-bold flex items-center gap-2">
        {props.title}
        {props.badge && <span className="bg-charcoal text-white text-[11px] px-1.5 py-0.5">{props.badge}</span>}
      </p>
      <p className={`text-5xl font-black leading-tight ${num}`}>
        {props.n}
        <small className="text-lg ml-1">건</small>
      </p>
      <p className="text-xs text-ink-muted">{props.detail}</p>
    </div>
  )
}

const TAG = {
  red: 'bg-hazard-red/15 text-hazard-red',
  amber: 'bg-safety-yellow/30 text-safety-yellow-dark',
  gray: 'bg-paper-dark text-ink-muted',
}

// 감리·발주처가 승인 전에 봐야 할 기록: 누락, 수동 처리, 보류, 불합격, 지연·의심, 예외 출입
function ItemList({ bundle, missing }: { bundle: CaseBundle; missing: AuditRecord[] }) {
  const items: { tag: string; tone: keyof typeof TAG; title: string; sub: string; at: number }[] = []
  missing.forEach((m) =>
    items.push({ tag: '누락', tone: 'red', title: `게이트 일련번호 ${m.deviceSeq} · ${hhmm(m.signedAt)} 검사`, sub: '감리 저장소에만 있음 · 시공사가 체인에 올리지 않음', at: m.signedAt }),
  )
  bundle.checkIns.forEach((c) => {
    const seq = c.deviceSeq ? `일련번호 ${c.deviceSeq} · ` : ''
    const failed = [!c.helmetPass && '안전모', !c.shoesPass && '안전화', !c.alcoholPass && '음주'].filter(Boolean).join('·')
    if (c.overridden)
      items.push({ tag: '수동 처리', tone: 'amber', title: `${seq}${hhmm(c.timestamp)} · ${failed} AI 불합격 → 통과`, sub: `사유: ${c.overrideReason} · 원래 판정 보존`, at: c.timestamp })
    else if (c.entryStatus === 'HeldNoAssessment' || c.entryStatus === 'HeldHazardsOpen')
      items.push({ tag: '보류', tone: 'amber', title: `${seq}${hhmm(c.timestamp)} · ${c.entryStatus === 'HeldNoAssessment' ? '위험성평가 전' : '위험요인 미조치'}`, sub: '출입 시도는 기록됨', at: c.timestamp })
    else if (c.entryStatus === 'Denied')
      items.push({ tag: '불합격', tone: 'gray', title: `${seq}${hhmm(c.timestamp)} · ${failed} 불합격`, sub: '출입 거부로 기록됨', at: c.timestamp })
    else if (c.entryStatus === 'LateAuditOnly' || c.entryStatus === 'SuspectTimestamp')
      items.push({
        tag: c.entryStatus === 'LateAuditOnly' ? '지연 기록' : '시각 의심',
        tone: 'gray',
        title: `${seq}${hhmm(c.timestamp)} 검사`,
        sub: '감사용으로만 인정, 원래 시각 그대로',
        at: c.timestamp,
      })
  })
  bundle.emergencies?.forEach((e) =>
    items.push({ tag: '예외 출입', tone: 'gray', title: `${hhmm(e.timestamp)} · ${e.reason}`, sub: `감독자 ${e.supervisor} + ${e.approver} 공동 서명`, at: e.timestamp }),
  )
  bundle.siteRecords
    .filter((r) => !r.hazardsControlled)
    .forEach((r) => items.push({ tag: '미조치 평가', tone: 'amber', title: `${hhmm(r.timestamp)} 위험성평가 제출 · 미조치 있음`, sub: '이후 버전에서 조치 완료됐는지 확인', at: r.timestamp }))
  items.sort((a, b) => a.at - b.at)

  return (
    <>
      <p className="font-bold pb-2 border-b border-charcoal/10">확인이 필요한 기록 · {items.length}건</p>
      {items.length === 0 && <p className="py-6 text-ink-muted">특별히 확인할 기록이 없어요. 모두 정상 통과예요.</p>}
      {items.map((it, i) => (
        <div key={i} className="flex items-center gap-4 py-3 border-b border-charcoal/10 last:border-0">
          <span className={`w-24 shrink-0 text-center py-1.5 text-sm font-bold ${TAG[it.tone]}`}>{it.tag}</span>
          <div className="min-w-0">
            <p className="font-bold">{it.title}</p>
            <p className="text-sm text-ink-muted">{it.sub}</p>
          </div>
        </div>
      ))}
    </>
  )
}
