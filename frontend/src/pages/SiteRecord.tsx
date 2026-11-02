import { useEffect, useState } from 'react'
import { caseIdOf } from '../chain'
import {
  Bar,
  BottomBar,
  DarkBox,
  Hint,
  hhmm,
  Label,
  NavButton,
  ResultPanel,
  SitePicker,
  StepBar,
  TitleBar,
  TxDetail,
  openVerify,
  Warn,
} from '../components/kiosk'
import { ErrorText, Input, Textarea } from '../components/ui'
import { BACKEND_URL } from '../config'

type Admin = { name: string; address: string }

type Hazard = {
  hazard: string
  riskBasis: string
  controlMeasure: string
  completed: boolean
}

type RecordSubmitResult = { txHash: string; nonce: string; recordHash: string }

type SiteRecordRow = {
  nonce: string
  txHash: string
  caseId: string
  processSummary: string
  hazards: Hazard[]
  changeReason: string | null
  hazardsControlled: boolean
  recordHash: string
  timestamp: number
  adminName: string
}

type Screen = 'author' | 'process' | 'hazards' | 'review' | 'result' | 'fix'

const STEPS = ['작성자', '오늘 공정', '위험요인', '검토·제출']
const SCREEN_STEP: Record<Screen, number> = { author: 0, process: 1, hazards: 2, review: 3, result: 4, fix: 4 }
const DRAFT_KEY = 'safetychain.siteRecordDraft'

const emptyHazard = (): Hazard => ({ hazard: '', riskBasis: '', controlMeasure: '', completed: false })
const today = () => new Date().toISOString().slice(0, 10)
const nowHHMM = () => new Date().toTimeString().slice(0, 5)
const weekday = (d: string) => '일월화수목금토'[new Date(`${d}T00:00:00`).getDay()] ?? ''

// 작업 구역·평가 실시 시각은 백엔드에 따로 칸이 없어서 '오늘 공정' 원문 앞에 붙여 함께 해시한다
// 예: "[작업 구역: A동] [평가 실시: 07:50] 3층 거푸집 설치 → 철근 배근"

// 오늘의 위험성평가: 작성자 → 오늘 공정 → 위험요인 → 검토·제출 (목업 risk-mockup)
// 미조치가 있으면 그 현장 출입이 모두 보류되고, 조치를 마치면 덮어쓰지 않고 새 버전으로 다시 제출한다
export default function SiteRecord() {
  const [admins, setAdmins] = useState<Admin[]>([])
  const [adminName, setAdminName] = useState('')
  const [siteId, setSiteId] = useState('')
  const [workDate, setWorkDate] = useState(today())
  const [processSummary, setProcessSummary] = useState('')
  const [changeReason, setChangeReason] = useState('')
  const [hazards, setHazards] = useState<Hazard[]>([])
  const [draftHazard, setDraftHazard] = useState<Hazard>(emptyHazard())
  const [screen, setScreen] = useState<Screen>('author')
  const [result, setResult] = useState<RecordSubmitResult | null>(null)
  const [records, setRecords] = useState<SiteRecordRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  // 조치 완료 처리 화면
  const [fixChecked, setFixChecked] = useState<Set<number>>(new Set())
  const [fixAt, setFixAt] = useState(nowHHMM())
  const [fixNote, setFixNote] = useState('')

  useEffect(() => {
    fetch(`${BACKEND_URL}/admins`)
      .then((res) => res.json())
      .then((list: Admin[]) => {
        setAdmins(list)
        if (list.length > 0) setAdminName((n) => n || list[0].name)
      })
      .catch(() => {})
    // 쓰다 만 내용 불러오기 (이 브라우저에만 저장)
    try {
      const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null')
      if (d) {
        setSiteId(d.siteId ?? '')
        setProcessSummary(d.processSummary ?? '')
        setChangeReason(d.changeReason ?? '')
        setHazards(d.hazards ?? [])
        if (d.adminName) setAdminName(d.adminName)
      }
    } catch {
      /* 저장소를 못 쓰는 브라우저면 그냥 빈 칸으로 시작 */
    }
  }, [])

  // 입력 중인 내용 자동 저장
  useEffect(() => {
    if (screen === 'result' || screen === 'fix') return
    if (!processSummary && hazards.length === 0) return
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ siteId, processSummary, changeReason, hazards, adminName }))
      setSavedAt(nowHHMM())
    } catch {
      /* 무시 */
    }
  }, [siteId, processSummary, changeReason, hazards, adminName, screen])

  async function loadRecords() {
    if (!siteId) return
    const res = await fetch(`${BACKEND_URL}/site/records/${encodeURIComponent(siteId)}`)
    if (res.ok) setRecords(await res.json())
  }
  useEffect(() => {
    loadRecords()
  }, [siteId])

  // 오늘(이 현장·이 날짜) 제출된 버전들, 오래된 것부터
  const caseId = siteId ? caseIdOf(siteId, workDate).toLowerCase() : ''
  const versions = records.filter((r) => r.caseId.toLowerCase() === caseId).sort((a, b) => a.timestamp - b.timestamp)
  const latest = versions[versions.length - 1]

  async function submitRecord(body: { processSummary: string; hazards: Hazard[]; changeReason: string | null }) {
    setError(null)
    setLoading(true)
    try {
      const res = await fetch(`${BACKEND_URL}/site/record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId, adminName, workDate, ...body, hazardsControlled: body.hazards.every((h) => h.completed) }),
      })
      if (!res.ok) {
        const b = await res.json().catch(() => ({}))
        throw new Error(b.detail ?? '제출 실패')
      }
      setResult(await res.json())
      await loadRecords()
      setScreen('result')
      try {
        localStorage.removeItem(DRAFT_KEY)
      } catch {
        /* 무시 */
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '알 수 없는 오류')
    } finally {
      setLoading(false)
    }
  }

  function submitFirst() {
    submitRecord({ processSummary, hazards, changeReason: changeReason || null })
  }

  // 미조치 항목을 조치 완료로 바꿔 다음 버전으로 제출. 이전 버전은 그대로 남는다
  function submitFix() {
    if (!latest) return
    const fixed = latest.hazards.map((h, i) =>
      fixChecked.has(i) ? { ...h, completed: true } : h,
    )
    const names = latest.hazards.filter((_, i) => fixChecked.has(i)).map((h) => h.hazard)
    submitRecord({ processSummary: latest.processSummary, hazards: fixed, changeReason: `조치 완료 처리: ${names.join(', ')}${fixNote ? ` (${fixAt} ${fixNote})` : ''}` })
  }

  function openFix() {
    if (!latest) return
    setFixChecked(new Set(latest.hazards.map((h, i) => (h.completed ? -1 : i)).filter((i) => i >= 0)))
    setFixAt(nowHHMM())
    setFixNote('')
    setScreen('fix')
  }

  function addHazard() {
    setHazards((prev) => [...prev, draftHazard])
    setDraftHazard(emptyHazard())
  }

  const openCount = hazards.filter((h) => !h.completed).length
  const step = SCREEN_STEP[screen]
  const stepStates = STEPS.map((label, i) => ({ label, state: i < step ? ('done' as const) : i === step ? ('now' as const) : ('todo' as const) }))

  return (
    <div className="space-y-4 pb-2">
      <TitleBar title="오늘의 위험성평가" sub={`${workDate} (${weekday(workDate)})`}>
        <SitePicker siteId={siteId} workDate={workDate} onSite={setSiteId} onDate={setWorkDate} />
        {savedAt && screen !== 'result' && screen !== 'fix' && <span className="text-sm font-bold text-ink-muted">✓ 자동 저장됨 {savedAt}</span>}
      </TitleBar>

      {screen !== 'fix' && <StepBar steps={stepStates} />}

      {screen === 'author' && (
        <TwoCol
          left={
            <>
              <h2 className="text-3xl font-black">누가 작성하나요?</h2>
              <p className="text-lg text-ink-muted leading-relaxed">
                이름을 고르면 그 사람의 서명 키로 기록돼요.
                <br />
                제출한 뒤에는 누구도 작성자를 바꿀 수 없어요.
              </p>
            </>
          }
          right={
            <>
              {admins.length === 0 && <p className="text-ink-muted">등록된 감독자가 없어요</p>}
              {admins.map((a) => (
                <button
                  key={a.name}
                  onClick={() => setAdminName(a.name)}
                  className={`flex items-center gap-3 border-2 px-5 py-4 text-xl font-black text-left ${adminName === a.name ? 'border-charcoal bg-safety-yellow/20' : 'border-charcoal/20 bg-white'}`}
                >
                  <span className={`w-7 h-7 grid place-items-center border-2 border-charcoal text-sm ${adminName === a.name ? 'bg-charcoal text-white' : ''}`}>
                    {adminName === a.name ? '✓' : ''}
                  </span>
                  {a.name}
                  <small className="ml-auto text-sm font-medium text-ink-muted font-mono">{a.address.slice(0, 8)}…</small>
                </button>
              ))}
              <div className="flex-1" />
              <Hint icon="⚿">서명 키가 등록된 감독자만 목록에 나와요</Hint>
            </>
          }
        />
      )}

      {screen === 'process' && (
        <TwoCol
          left={
            <>
              <h2 className="text-3xl font-black">오늘 어떤 작업을 하나요?</h2>
              <p className="text-lg text-ink-muted leading-relaxed">작업순서, 장비 투입, 동선을 짧게 적어 주세요. 어제와 바뀐 점이 있으면 사유도 남겨 주세요.</p>
            </>
          }
          right={
            <>
              <div>
                <Label>오늘 공정 · 작업순서</Label>
                <Textarea
                  rows={3}
                  placeholder="예: 3층 거푸집 설치 → 철근 배근. 타워크레인 1대, 09시 자재 반입."
                  value={processSummary}
                  onChange={(e) => setProcessSummary(e.target.value)}
                />
              </div>
              <div>
                <Label note="없으면 비워 두세요">어제와 바뀐 점</Label>
                <Input placeholder="예: 우천으로 외벽 → 내부 작업" value={changeReason} onChange={(e) => setChangeReason(e.target.value)} />
              </div>
            </>
          }
        />
      )}

      {screen === 'hazards' && (
        <div className="flex flex-col lg:flex-row gap-5">
          <div className="flex-[1.4] flex flex-col gap-3">
            <div className="flex items-baseline">
              <span className="text-2xl sm:text-3xl font-black">오늘의 위험요인 {hazards.length}건</span>
              {openCount > 0 && <span className="ml-auto font-black text-safety-yellow-dark">미조치 {openCount}건</span>}
            </div>
            {hazards.length === 0 && <p className="text-ink-muted">오른쪽에서 위험요인을 추가해 주세요.</p>}
            {hazards.map((h, i) => (
              <HazardRow
                key={i}
                n={i + 1}
                hazard={h}
                right={
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setHazards((prev) => prev.map((x, j) => (j === i ? { ...x, completed: !x.completed } : x)))}
                      className={`px-3 py-1.5 text-sm font-black ${h.completed ? 'bg-hazard-green/15 text-hazard-green' : 'bg-safety-yellow/25 text-safety-yellow-dark'}`}
                    >
                      {h.completed ? '✓ 조치 완료' : '○ 미조치'}
                    </button>
                    <button onClick={() => setHazards((prev) => prev.filter((_, j) => j !== i))} className="text-sm text-ink-muted underline">
                      삭제
                    </button>
                  </div>
                }
              />
            ))}
            <div className="flex-1" />
            {openCount > 0 && (
              <Warn>
                미조치 위험요인이 하나라도 있으면 오늘 <b>{siteId || '이'} 현장 출입이 모두 보류</b>돼요. 조치를 마친 뒤 '조치 완료'로 다시 제출해 주세요.
              </Warn>
            )}
          </div>
          <div className="lg:w-[380px] bg-white border-t-[5px] border-charcoal p-5 space-y-2.5">
            <p className="font-black text-lg">+ 위험요인 추가</p>
            <Label>무엇이 위험한가요?</Label>
            <Input placeholder="예: 개구부 추락" value={draftHazard.hazard} onChange={(e) => setDraftHazard({ ...draftHazard, hazard: e.target.value })} />
            <Label note="(결정 근거)">왜 위험한가요?</Label>
            <Input placeholder="예: 바닥 개구부 4곳" value={draftHazard.riskBasis} onChange={(e) => setDraftHazard({ ...draftHazard, riskBasis: e.target.value })} />
            <Label note="(통제조치)">어떻게 막나요?</Label>
            <Input
              placeholder="예: 안전난간 설치"
              value={draftHazard.controlMeasure}
              onChange={(e) => setDraftHazard({ ...draftHazard, controlMeasure: e.target.value })}
            />
            <label className="flex items-center gap-2 text-sm font-bold">
              <input
                type="checkbox"
                checked={draftHazard.completed}
                onChange={(e) => setDraftHazard({ ...draftHazard, completed: e.target.checked })}
                className="w-4 h-4 accent-safety-yellow"
              />
              이미 조치 완료
            </label>
            <button onClick={addHazard} disabled={!draftHazard.hazard} className="w-full bg-charcoal text-white py-3.5 font-black disabled:opacity-35">
              목록에 추가
            </button>
          </div>
        </div>
      )}

      {screen === 'review' && (
        <div className="flex flex-col lg:flex-row gap-5">
          <div className="flex-1 bg-white p-6">
            <h3 className="text-2xl font-black mb-2">이대로 제출할까요?</h3>
            <SummaryRow label="작성자" value={adminName} onEdit={() => setScreen('author')} />
            <SummaryRow label="현장 · 날짜" value={`${siteId || '(현장 ID를 입력하세요)'} · ${workDate}`} />
            <SummaryRow label="오늘 공정" value={processSummary} onEdit={() => setScreen('process')} />
            {changeReason && <SummaryRow label="어제와 바뀐 점" value={changeReason} onEdit={() => setScreen('process')} />}
            <SummaryRow
              label="위험요인"
              value={
                <>
                  {hazards.length}건 · <span className="text-hazard-green">조치 {hazards.length - openCount}</span>
                  {openCount > 0 && (
                    <>
                      {' '}
                      ·{' '}
                      <span className="text-safety-yellow-dark">
                        미조치 {openCount} ({hazards.filter((h) => !h.completed).map((h) => h.hazard).join(', ')})
                      </span>
                    </>
                  )}
                </>
              }
              onEdit={() => setScreen('hazards')}
            />
          </div>
          <div className="lg:w-[400px] flex flex-col gap-3">
            <DarkBox
              title="제출하면 이렇게 남아요"
              items={[
                '내용 전체: 회사 서버 (비공개)',
                '내용의 지문(해시)·조치 여부: 블록체인',
                '나중에 내용을 고치면 지문이 달라져 바로 드러나요',
                '고칠 때는 덮어쓰지 않고 새 버전으로 쌓여요',
              ]}
            />
            {openCount > 0 && (
              <Warn>
                {hazards.filter((h) => !h.completed).map((h) => h.hazard).join(', ')} 조치가 끝날 때까지 <b>오늘 {siteId} 현장 출입이 모두 보류</b>돼요.
              </Warn>
            )}
          </div>
        </div>
      )}

      {screen === 'result' && latest && (
        <ResultView latest={latest} version={versions.length} txHash={result?.txHash ?? latest.txHash} siteId={siteId} />
      )}

      {screen === 'fix' && latest && (
        <div className="flex flex-col lg:flex-row gap-5">
          <div className="flex-[1.4] flex flex-col gap-3">
            <p className="text-2xl sm:text-3xl font-black">미조치 항목 조치 완료 처리</p>
            {latest.hazards.map((h, i) =>
              h.completed ? null : (
                <HazardRow
                  key={i}
                  n={i + 1}
                  hazard={h}
                  open
                  right={
                    <button
                      onClick={() =>
                        setFixChecked((prev) => {
                          const next = new Set(prev)
                          if (next.has(i)) next.delete(i)
                          else next.add(i)
                          return next
                        })
                      }
                      className={`px-3 py-1.5 text-sm font-black ${fixChecked.has(i) ? 'bg-hazard-green/15 text-hazard-green' : 'bg-safety-yellow/25 text-safety-yellow-dark'}`}
                    >
                      {fixChecked.has(i) ? '✓ 조치 완료로 변경' : '○ 미조치 유지'}
                    </button>
                  }
                />
              ),
            )}
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <Label>조치 확인 시각</Label>
                <Input type="time" value={fixAt} onChange={(e) => setFixAt(e.target.value)} />
              </div>
              <div>
                <Label>확인한 사람</Label>
                <Input value={adminName} readOnly />
              </div>
            </div>
            <div>
              <Label>조치 내용</Label>
              <Textarea rows={3} placeholder="예: 가설 분전반 누전차단기 교체, 시험 버튼 작동 확인" value={fixNote} onChange={(e) => setFixNote(e.target.value)} />
            </div>
          </div>
          <div className="lg:w-[400px] flex flex-col gap-3">
            <VersionHistory versions={versions} pendingLabel={`조치 ${latest.hazards.length - latest.hazards.filter((h, i) => !h.completed && !fixChecked.has(i)).length} · 미조치 ${latest.hazards.filter((h, i) => !h.completed && !fixChecked.has(i)).length}`} />
            <DarkBox
              title={`${versions.length}번째 버전은 그대로 남아요`}
              items={[`${hhmm(latest.timestamp)}부터 지금까지 보류였다는 사실도 기록으로 남아요`, '감리·발주처가 하루치 기록을 승인할 때 두 버전을 함께 봐요']}
            />
          </div>
        </div>
      )}

      {error && <ErrorText>{error}</ErrorText>}

      <BottomBar>
        {screen === 'author' && (
          <NavButton primary className="ml-auto" disabled={!adminName} onClick={() => setScreen('process')}>
            다음 → 오늘 공정
          </NavButton>
        )}
        {screen === 'process' && (
          <>
            <NavButton onClick={() => setScreen('author')}>← 작성자</NavButton>
            <NavButton primary className="ml-auto" disabled={!processSummary} onClick={() => setScreen('hazards')}>
              다음 → 위험요인
            </NavButton>
          </>
        )}
        {screen === 'hazards' && (
          <>
            <NavButton onClick={() => setScreen('process')}>← 오늘 공정</NavButton>
            <NavButton primary className="ml-auto" disabled={hazards.length === 0} onClick={() => setScreen('review')}>
              다음 → 검토·제출
            </NavButton>
          </>
        )}
        {screen === 'review' && (
          <>
            <NavButton onClick={() => setScreen('hazards')}>← 위험요인</NavButton>
            <span className="ml-auto text-sm font-bold text-ink-muted">{adminName} 님 서명 키로 서명돼요</span>
            <NavButton primary disabled={!siteId || !processSummary || !adminName || loading} onClick={submitFirst}>
              {loading ? '기록하는 중…' : '서명하고 제출하기'}
            </NavButton>
          </>
        )}
        {screen === 'result' && latest && (
          <>
            <a href="#/gate">
              <NavButton>게이트로 가기</NavButton>
            </a>
            {!latest.hazardsControlled ? (
              <NavButton primary className="ml-auto" onClick={openFix}>
                {latest.hazards.filter((h) => !h.completed).map((h) => h.hazard).join(', ')} 조치 완료 처리
              </NavButton>
            ) : (
              <NavButton primary className="ml-auto" onClick={() => openVerify(latest.txHash)}>
                검증 탭에서 확인 ▸
              </NavButton>
            )}
          </>
        )}
        {screen === 'fix' && (
          <>
            <NavButton onClick={() => setScreen('result')}>취소</NavButton>
            <span className="ml-auto text-sm font-bold text-ink-muted">
              {adminName} 님 서명 키로 {versions.length + 1}번째 버전을 서명해요
            </span>
            <NavButton primary disabled={fixChecked.size === 0 || loading} onClick={submitFix}>
              {loading ? '기록하는 중…' : '서명하고 다시 제출'}
            </NavButton>
          </>
        )}
      </BottomBar>

      {screen === 'author' && versions.length > 0 && latest && (
        <div className="bg-white p-4 flex flex-wrap items-center gap-3">
          <span className="font-bold">
            오늘 이미 {versions.length}개 버전이 제출돼 있어요 · {latest.hazardsControlled ? '조치 완료' : '미조치 있음'}
          </span>
          <button onClick={() => setScreen('result')} className="ml-auto underline font-bold">
            최신 버전 보기
          </button>
        </div>
      )}
    </div>
  )
}

function ResultView({ latest, version, txHash, siteId }: { latest: SiteRecordRow; version: number; txHash: string; siteId: string }) {
  const done = latest.hazards.filter((h) => h.completed).length
  const open = latest.hazards.filter((h) => !h.completed)
  const bar = (
    <Bar
      title={`블록체인에 기록 완료 · ${version}번째 버전 · 작성자 ${latest.adminName} 서명`}
      detail={<TxDetail txHash={txHash} />}
      right={
        <button type="button" onClick={() => openVerify(txHash)} className="text-safety-yellow font-bold">
          검증 탭에서 확인 ▸
        </button>
      }
    />
  )
  if (open.length > 0) {
    return (
      <ResultPanel
        tone="orange"
        icon="!"
        title="제출했어요 · 출입 보류 중"
        sub={`미조치 위험요인이 있어 오늘 ${siteId} 현장 출입이 모두 보류돼요`}
        chips={[{ label: `조치 완료 ${done}건`, ok: true }, { label: `○ 미조치 ${open.length}건 · ${open.map((h) => h.hazard).join(', ')}`, ok: undefined }]}
        bar={bar}
      />
    )
  }
  return (
    <ResultPanel
      tone="green"
      icon="✓"
      title={version > 1 ? '조치 완료 · 출입 가능' : '제출했어요 · 출입 가능'}
      sub={`오늘 ${siteId} 현장 게이트 검사에 바로 적용돼요`}
      chips={[{ label: `조치 완료 ${done}건`, ok: true }, ...(version > 1 ? [{ label: `버전 ${version} · 이전 버전 보존` }] : [])]}
      bar={bar}
    />
  )
}

function TwoCol({ left, right }: { left: React.ReactNode; right: React.ReactNode }) {
  return (
    <div className="flex flex-col lg:flex-row gap-6 min-h-[420px]">
      <div className="flex-1 flex flex-col justify-center gap-3">{left}</div>
      <div className="lg:w-[520px] bg-white p-6 flex flex-col gap-4">{right}</div>
    </div>
  )
}

function HazardRow({ n, hazard, right, open }: { n: number; hazard: Hazard; right: React.ReactNode; open?: boolean }) {
  return (
    <div className={`bg-white border-2 px-4 py-3.5 flex items-center gap-4 ${open || !hazard.completed ? 'border-safety-yellow-dark' : 'border-charcoal/15'}`}>
      <span className="w-9 h-9 shrink-0 grid place-items-center bg-charcoal text-white font-black">{n}</span>
      <div className="min-w-0">
        <p className="text-lg font-black">{hazard.hazard}</p>
        <p className="text-sm text-ink-muted">
          근거: {hazard.riskBasis || '-'} · 조치: {hazard.controlMeasure || '-'}
        </p>
      </div>
      <div className="ml-auto shrink-0">{right}</div>
    </div>
  )
}

function SummaryRow({ label, value, onEdit }: { label: string; value: React.ReactNode; onEdit?: () => void }) {
  return (
    <div className="flex gap-4 py-3 border-b border-charcoal/10 last:border-0">
      <span className="w-32 shrink-0 text-ink-muted font-bold">{label}</span>
      <b className="flex-1">{value}</b>
      {onEdit && (
        <button onClick={onEdit} className="text-sm underline text-ink-muted">
          수정
        </button>
      )}
    </div>
  )
}

function VersionHistory({ versions, pendingLabel }: { versions: SiteRecordRow[]; pendingLabel: string }) {
  return (
    <div className="bg-white p-5">
      <p className="text-xs font-bold text-ink-muted mb-2">버전 이력 · 덮어쓰지 않고 쌓여요</p>
      {versions.map((v, i) => {
        const open = v.hazards.filter((h) => !h.completed).length
        return (
          <div key={v.nonce} className="flex items-center gap-3 py-2 border-b border-charcoal/10">
            <span className="w-7 h-7 grid place-items-center bg-charcoal text-white text-sm font-black">{i + 1}</span>
            {hhmm(v.timestamp)} 제출
            <span className="ml-auto text-sm text-ink-muted">
              조치 {v.hazards.length - open} · 미조치 {open}
            </span>
          </div>
        )
      })}
      <div className="flex items-center gap-3 py-2">
        <span className="w-7 h-7 grid place-items-center bg-safety-yellow text-charcoal text-sm font-black">{versions.length + 1}</span>
        지금 제출
        <span className="ml-auto text-sm text-ink-muted">{pendingLabel}</span>
      </div>
    </div>
  )
}
