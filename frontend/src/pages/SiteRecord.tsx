import { useEffect, useState } from 'react'
import { Card, ErrorText, Input, PageTitle, PrimaryButton, SecondaryButton, Select, StepHeading, Textarea } from '../components/ui'
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
  processSummary: string
  hazards: Hazard[]
  changeReason: string | null
  hazardsControlled: boolean
  recordHash: string
  timestamp: number
  adminName: string
}

const emptyHazard = (): Hazard => ({ hazard: '', riskBasis: '', controlMeasure: '', completed: false })
const today = () => new Date().toISOString().slice(0, 10)

export default function SiteRecord() {
  const [admins, setAdmins] = useState<Admin[]>([])
  const [adminName, setAdminName] = useState('')
  const [siteId, setSiteId] = useState('')
  const [workDate, setWorkDate] = useState(today())
  const [processSummary, setProcessSummary] = useState('')
  const [changeReason, setChangeReason] = useState('')
  const [hazards, setHazards] = useState<Hazard[]>([emptyHazard()])
  const [result, setResult] = useState<RecordSubmitResult | null>(null)
  const [records, setRecords] = useState<SiteRecordRow[]>([])
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

  function updateHazard(i: number, patch: Partial<Hazard>) {
    setHazards((prev) => prev.map((h, idx) => (idx === i ? { ...h, ...patch } : h)))
  }

  async function submit() {
    setError(null)
    setLoading(true)
    try {
      const res = await fetch(`${BACKEND_URL}/site/record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          siteId,
          processSummary,
          hazards,
          hazardsControlled: hazards.every((h) => h.completed),
          changeReason: changeReason || null,
          adminName,
          workDate,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.detail ?? '제출 실패')
      }
      setResult(await res.json())
      await loadRecords()
    } catch (e) {
      setError(e instanceof Error ? e.message : '알 수 없는 오류')
    } finally {
      setLoading(false)
    }
  }

  async function loadRecords() {
    if (!siteId) return
    const res = await fetch(`${BACKEND_URL}/site/records/${encodeURIComponent(siteId)}`)
    if (res.ok) setRecords(await res.json())
  }

  return (
    <div className="space-y-5">
      <PageTitle
        title="일일 현장 위험성평가 기록"
        subtitle="공정·위험요인·조치 내용은 오프체인에 남고, 해시와 조치완료 여부만 온체인에 앵커링됩니다"
      />

      <Card>
        <StepHeading step={1}>작성자</StepHeading>
        <div className="space-y-2.5">
          <Select value={adminName} onChange={(e) => setAdminName(e.target.value)}>
            {admins.length === 0 && <option value="">등록된 안전관리자 없음</option>}
            {admins.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
              </option>
            ))}
          </Select>
          <p className="text-xs text-ink-muted">
            로그인 없이 이름만 선택합니다 — 선택한 이름에 미리 등록된 서명 키로 온체인에 기록되어, 이후 누구도
            제출자를 바꿔치기할 수 없습니다.
          </p>
        </div>
      </Card>

      <Card>
        <StepHeading step={2}>오늘 공정</StepHeading>
        <div className="space-y-2.5">
          <Input placeholder="현장 ID" value={siteId} onChange={(e) => setSiteId(e.target.value)} onBlur={loadRecords} />
          <Input type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)} />
          <Textarea
            placeholder="오늘 공정 / 작업순서 / 장비투입 / 동선 / 작업방법 변경사항"
            rows={3}
            value={processSummary}
            onChange={(e) => setProcessSummary(e.target.value)}
          />
          <Input
            placeholder="공정 · 작업방법 변경 사유 (변경 없으면 비워둠)"
            value={changeReason}
            onChange={(e) => setChangeReason(e.target.value)}
          />
        </div>
      </Card>

      <Card>
        <StepHeading step={3}>위험요인 목록</StepHeading>
        <div className="space-y-3">
          {hazards.map((h, i) => (
            <div key={i} className="border-2 border-charcoal/30 p-4 space-y-2.5 bg-paper-dark/40">
              <Input placeholder="위험요인" value={h.hazard} onChange={(e) => updateHazard(i, { hazard: e.target.value })} />
              <Input
                placeholder="위험성 결정 근거"
                value={h.riskBasis}
                onChange={(e) => updateHazard(i, { riskBasis: e.target.value })}
              />
              <Input
                placeholder="통제조치"
                value={h.controlMeasure}
                onChange={(e) => updateHazard(i, { controlMeasure: e.target.value })}
              />
              <label className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={h.completed}
                  onChange={(e) => updateHazard(i, { completed: e.target.checked })}
                  className="w-4 h-4 accent-safety-yellow"
                />
                조치 완료
              </label>
            </div>
          ))}
          <SecondaryButton onClick={() => setHazards((prev) => [...prev, emptyHazard()])} className="text-sm py-2">
            + 위험요인 추가
          </SecondaryButton>
        </div>
      </Card>

      <PrimaryButton disabled={!siteId || !processSummary || !adminName || loading} onClick={submit} className="w-full">
        {loading ? '앵커링 중...' : '위험성평가 기록 제출'}
      </PrimaryButton>

      {error && <ErrorText>{error}</ErrorText>}
      {result && (
        <Card>
          <p className="text-xs font-mono break-all text-ink-muted">tx: {result.txHash}</p>
          <p className="text-xs font-mono break-all text-ink-muted">recordHash: {result.recordHash}</p>
        </Card>
      )}

      {records.length > 0 && (
        <div className="space-y-2.5">
          <h2 className="font-display font-bold uppercase tracking-wide text-charcoal text-lg">최근 기록</h2>
          {records.map((r) => (
            <Card key={r.nonce}>
              <div className="flex justify-between items-center">
                <span className="text-sm text-ink-muted">{new Date(r.timestamp * 1000).toLocaleString()}</span>
                <span
                  className={`text-xs font-display font-bold uppercase px-2.5 py-1 border-2 border-charcoal text-white ${
                    r.hazardsControlled ? 'bg-hazard-green' : 'bg-hazard-red'
                  }`}
                >
                  {r.hazardsControlled ? '조치완료' : '미조치'}
                </span>
              </div>
              <p className="text-xs text-ink-muted">작성자: {r.adminName}</p>
              <p className="text-ink text-sm">{r.processSummary}</p>
              {r.changeReason && <p className="text-ink-muted text-xs">변경 사유: {r.changeReason}</p>}
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
