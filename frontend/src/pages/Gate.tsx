import jsQR from 'jsqr'
import QRCode from 'qrcode'
import { useEffect, useRef, useState } from 'react'
import { Card, ChainLink, ErrorText, Input, PageTitle, SecondaryButton, Select, StepHeading, SuccessButton } from '../components/ui'
import { BACKEND_URL, GATE_URL } from '../config'

type QrIssue = { nonce: string; expiresAt: number }
type EntryStatus = 'Granted' | 'Denied' | 'HeldNoAssessment' | 'HeldHazardsOpen' | 'LateAuditOnly' | 'SuspectTimestamp'
type GateResult = {
  anchored: boolean
  txHash: string | null
  verdict: boolean
  nonce: string
  helmetPass: boolean
  shoesPass: boolean
  alcoholPass: boolean
  overridable: boolean
  entryStatus: EntryStatus | null
  entryAllowed: boolean
  deviceSeq: number
  auditDelivered: boolean
}
type Reason = { code: number; label: string }
type Admin = { name: string; address: string }
type OverrideResult = { txHash: string; reason: string }
type EmergencyResult = { reason: string; pending: boolean }
type Stage = 'inspecting' | 'signing' | 'auditing' | 'anchoring' | 'confirmed' | 'not_anchored'

const STAGES: { key: Stage; label: string }[] = [
  { key: 'inspecting', label: '검사 중' },
  { key: 'signing', label: '기기 서명' },
  { key: 'auditing', label: '감리 감사 저장소 전달' },
  { key: 'anchoring', label: '블록체인 기록 중' },
  { key: 'confirmed', label: '확정' },
]

// 한 브라우저에서 "인부 화면"(QR 발급)과 "게이트 화면"(스캔·촬영)을 같이 시뮬레이션한다.
// 실제로는 QR은 근로자 폰(#/worker)에, 스캔·촬영은 게이트 태블릿에서 일어난다.
const today = () => new Date().toISOString().slice(0, 10)

// 데모 영상 촬영용: 주소 끝에 ?demo 를 붙이면 웹캠 대신 준비된 사진을 쓴다 (판정은 실제 백엔드)
const DEMO_MODE = new URLSearchParams(window.location.search).has('demo')
const DEMO_CAPTURE_IMAGE = '/demo-helmet.jpg'

export default function Gate() {
  const [workerId, setWorkerId] = useState('')
  const [siteId, setSiteId] = useState('')
  const [workDate, setWorkDate] = useState(today())
  const [needsConsent, setNeedsConsent] = useState(false)
  const [consentPersonal, setConsentPersonal] = useState(false)
  const [consentSensitive, setConsentSensitive] = useState(false)
  const [qr, setQr] = useState<QrIssue | null>(null)
  const [qrImageUrl, setQrImageUrl] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scannedNonce, setScannedNonce] = useState<string | null>(null)
  const [alcoholPass, setAlcoholPass] = useState(true)
  const [capturedBlob, setCapturedBlob] = useState<Blob | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [stage, setStage] = useState<Stage | null>(null)
  const [result, setResult] = useState<GateResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reasons, setReasons] = useState<Reason[]>([])
  const [supervisors, setSupervisors] = useState<Admin[]>([])
  const [reasonCode, setReasonCode] = useState(1)
  const [supervisorName, setSupervisorName] = useState('')
  const [showOverride, setShowOverride] = useState(false)
  const [overrideResult, setOverrideResult] = useState<OverrideResult | null>(null)
  const [overriding, setOverriding] = useState(false)
  // 시연: 게이트가 오프라인이라 N분 전에 서명해 둔 기록을 지금 보내는 상황
  const [delayMinutes, setDelayMinutes] = useState(0)
  const [emergencyReasons, setEmergencyReasons] = useState<Reason[]>([])
  const [emergencyReason, setEmergencyReason] = useState(1)
  const [emergencyReviewer, setEmergencyReviewer] = useState<'inspector' | 'owner'>('inspector')
  const [emergencyResult, setEmergencyResult] = useState<EmergencyResult | null>(null)
  const [emergencyError, setEmergencyError] = useState<string | null>(null)
  const [signingMode, setSigningMode] = useState<'wallet' | 'server'>('wallet')

  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const scanCanvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const scanFrameRef = useRef<number | null>(null)

  useEffect(() => {
    fetch(`${BACKEND_URL}/reasons`)
      .then((res) => res.json())
      .then((r: { override: Reason[]; emergency?: Reason[] }) => {
        setReasons(r.override)
        setEmergencyReasons(r.emergency ?? [])
      })
      .catch(() => {})
    fetch(`${BACKEND_URL}/signing-mode`)
      .then((res) => res.json())
      .then((m: { mode: 'wallet' | 'server' }) => setSigningMode(m.mode))
      .catch(() => {})
    fetch(`${BACKEND_URL}/admins`)
      .then((res) => res.json())
      .then((list: Admin[]) => {
        setSupervisors(list)
        if (list.length > 0) setSupervisorName(list[0].name)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    return () => {
      if (scanFrameRef.current) cancelAnimationFrame(scanFrameRef.current)
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  function resetForNext() {
    setQr(null)
    setQrImageUrl(null)
    setScannedNonce(null)
    setCapturedBlob(null)
    setPreviewUrl(null)
    setStage(null)
    setResult(null)
    setOverrideResult(null)
    setShowOverride(false)
    setAlcoholPass(true)
    setError(null)
  }

  async function issueQr() {
    resetForNext()
    const res = await fetch(`${BACKEND_URL}/qr/issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerId, siteId }),
    })
    if (res.status === 403) {
      setNeedsConsent(true)
      return
    }
    if (!res.ok) {
      setError('QR 발급 실패')
      return
    }
    const data: QrIssue = await res.json()
    setNeedsConsent(false)
    setQr(data)
    setQrImageUrl(await QRCode.toDataURL(data.nonce, { margin: 1, width: 220 }))
  }

  async function giveConsent() {
    const res = await fetch(`${BACKEND_URL}/consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerId, siteId, personal: consentPersonal, sensitive: consentSensitive }),
    })
    if (!res.ok) {
      setError('동의 저장 실패')
      return
    }
    await issueQr()
  }

  async function startCamera() {
    if (DEMO_MODE) return
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true })
      streamRef.current = stream
      if (videoRef.current) videoRef.current.srcObject = stream
    } catch {
      setError('웹캠 접근 실패 (권한을 확인하세요)')
    }
  }

  function startScan() {
    setError(null)
    setScanning(true)

    if (DEMO_MODE) {
      setTimeout(() => {
        if (qr) setScannedNonce(qr.nonce)
        setScanning(false)
      }, 1200)
      return
    }

    function tick() {
      const video = videoRef.current
      const canvas = scanCanvasRef.current
      if (!video || !canvas || video.videoWidth === 0) {
        scanFrameRef.current = requestAnimationFrame(tick)
        return
      }
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const code = jsQR(imageData.data, imageData.width, imageData.height)

      if (code && /^0x[0-9a-fA-F]{64}$/.test(code.data)) {
        setScannedNonce(code.data)
        setScanning(false)
        return
      }
      scanFrameRef.current = requestAnimationFrame(tick)
    }
    scanFrameRef.current = requestAnimationFrame(tick)
  }

  async function capture() {
    if (DEMO_MODE) {
      const res = await fetch(DEMO_CAPTURE_IMAGE)
      const blob = await res.blob()
      setCapturedBlob(blob)
      setPreviewUrl(URL.createObjectURL(blob))
      return
    }
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d')?.drawImage(video, 0, 0)
    canvas.toBlob((blob) => {
      if (!blob) return
      setCapturedBlob(blob)
      setPreviewUrl(URL.createObjectURL(blob))
    }, 'image/jpeg')
  }

  // 백엔드가 단계(검사 → 서명 → 온체인 기록 → 확정)를 끝낼 때마다 한 줄씩 보내준다
  async function submitCheck() {
    if (!scannedNonce || !capturedBlob) return
    setError(null)
    setResult(null)
    setStage('inspecting')
    try {
      const form = new FormData()
      form.append('image', capturedBlob, 'capture.jpg')
      form.append('nonce', scannedNonce)
      form.append('alcoholPass', String(alcoholPass))
      form.append('workerId', workerId)
      form.append('siteId', siteId)
      form.append('workDate', workDate)
      if (delayMinutes > 0) form.append('signedMinutesAgo', String(delayMinutes))

      // 검사는 게이트 기기 서비스로 보낸다 (기기 키는 시공사 백엔드에 없음)
      const res = await fetch(`${GATE_URL}/check/stream`, { method: 'POST', body: form })
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.detail ?? '제출 실패')
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          const msg = JSON.parse(line)
          if (msg.stage === 'error') throw new Error(msg.detail)
          setStage(msg.stage)
          if (msg.stage === 'confirmed' || msg.stage === 'not_anchored') setResult(msg.result)
        }
      }
    } catch (e) {
      setStage(null)
      setError(e instanceof Error ? e.message : '알 수 없는 오류')
    }
  }

  // 게이트 고장·응급 상황 등 정상 검사를 못 할 때의 별도 절차. 감독자 + 감리(또는 발주처) 둘 다 서명해야 기록된다
  async function submitEmergency() {
    setEmergencyError(null)
    setEmergencyResult(null)
    // 지갑 모드: 감독자 서명으로 요청만 올린다. 감리·발주처가 감리 화면에서 자기 지갑으로 공동 서명해야 기록된다
    const path = signingMode === 'wallet' ? '/gate/emergency/request' : '/gate/emergency'
    const res = await fetch(`${BACKEND_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId, workerId, workDate, reasonCode: emergencyReason, supervisorName, reviewer: emergencyReviewer }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) setEmergencyError(body.detail ?? '예외 출입 요청 실패')
    else setEmergencyResult({ reason: body.reason, pending: signingMode === 'wallet' })
  }

  // AI 보호구 불합격을 감독자가 사유 코드와 함께 수동 처리. 원래 판정은 그대로 남고 override 기록이 추가된다
  async function submitOverride() {
    if (!result) return
    setOverriding(true)
    setError(null)
    try {
      const res = await fetch(`${BACKEND_URL}/gate/override`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce: result.nonce, reasonCode, supervisorName }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.detail ?? '수동 처리 실패')
      }
      setOverrideResult(await res.json())
      setShowOverride(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : '알 수 없는 오류')
    } finally {
      setOverriding(false)
    }
  }

  return (
    <div className="space-y-5">
      <PageTitle title="게이트 키오스크" subtitle="QR 스캔 → 촬영 → 기기 서명 → 블록체인 확정 후 출입 판정" />

      <Card>
        <StepHeading step={1}>근로자 QR 발급</StepHeading>
        <p className="text-xs text-ink-muted">
          실제로는 근로자가 폰에서 <a href="#/worker" className="underline font-semibold">근로자 앱</a>을 열어 QR을 띄웁니다.
          여기서는 같은 화면에서 시뮬레이션합니다.
        </p>
        <div className="space-y-2.5">
          <Input placeholder="사번" value={workerId} onChange={(e) => setWorkerId(e.target.value)} />
          <Input placeholder="현장 ID" value={siteId} onChange={(e) => setSiteId(e.target.value)} />
          <Input type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)} />
          <SecondaryButton disabled={!workerId || !siteId} onClick={issueQr}>
            QR 발급
          </SecondaryButton>

          {needsConsent && (
            <div className="border-2 border-charcoal bg-safety-yellow/20 p-3 space-y-2 text-sm">
              <p className="font-semibold">이 근로자는 아직 정보 수집 동의를 하지 않았어요.</p>
              <label className="flex gap-2 items-start">
                <input type="checkbox" checked={consentPersonal} onChange={(e) => setConsentPersonal(e.target.checked)} className="mt-1 w-4 h-4 accent-safety-yellow" />
                <span>[필수] 개인정보(사번) 수집·이용 동의</span>
              </label>
              <label className="flex gap-2 items-start">
                <input type="checkbox" checked={consentSensitive} onChange={(e) => setConsentSensitive(e.target.checked)} className="mt-1 w-4 h-4 accent-safety-yellow" />
                <span>[필수·별도] 민감정보(검사 사진, 음주 측정 통과 여부) 수집·이용 동의</span>
              </label>
              <SecondaryButton disabled={!consentPersonal || !consentSensitive} onClick={giveConsent}>
                동의 후 QR 발급
              </SecondaryButton>
            </div>
          )}

          {qrImageUrl && (
            <div className="flex items-center gap-4 bg-paper-dark border-2 border-charcoal p-3">
              <img src={qrImageUrl} alt="발급된 QR" className="w-28 h-28 border-2 border-charcoal" />
              <p className="text-xs text-ink-muted">
                1회용 출입 QR
                <br />
                만료: {qr && new Date(qr.expiresAt * 1000).toLocaleTimeString()}
              </p>
            </div>
          )}
        </div>
      </Card>

      <Card>
        <StepHeading step={2}>QR 스캔 + 촬영</StepHeading>
        {DEMO_MODE ? (
          <div className="w-full bg-charcoal border-2 border-charcoal aspect-video flex items-center justify-center">
            {qrImageUrl && (
              <img src={qrImageUrl} alt="게이트 카메라가 보는 QR" className="h-4/5 aspect-square object-contain" />
            )}
          </div>
        ) : (
          <video ref={videoRef} autoPlay muted className="w-full bg-charcoal border-2 border-charcoal aspect-video object-cover" />
        )}
        <canvas ref={canvasRef} className="hidden" />
        <canvas ref={scanCanvasRef} className="hidden" />
        <div className="flex gap-2 flex-wrap">
          {!DEMO_MODE && <SecondaryButton onClick={startCamera}>웹캠 시작</SecondaryButton>}
          <SecondaryButton onClick={startScan} disabled={!qr || scanning}>
            {scanning ? 'QR 스캔 중...' : 'QR 스캔 시작'}
          </SecondaryButton>
          <SecondaryButton onClick={capture} disabled={!scannedNonce}>
            촬영
          </SecondaryButton>
        </div>
        {scannedNonce && (
          <p className="text-sm bg-hazard-green/10 border-2 border-hazard-green text-hazard-green font-semibold p-3">
            ✅ 출입 QR 확인됨 (1회용)
          </p>
        )}
        {previewUrl && <img src={previewUrl} alt="촬영 미리보기" className="w-32 border-2 border-charcoal" />}
      </Card>

      <Card>
        <StepHeading step={3}>음주 측정</StepHeading>
        <label className="flex items-center gap-2.5 text-ink">
          <input
            type="checkbox"
            checked={alcoholPass}
            onChange={(e) => setAlcoholPass(e.target.checked)}
            className="w-4 h-4 accent-safety-yellow"
          />
          측정 통과
        </label>
        <details className="text-sm text-ink-muted">
          <summary className="cursor-pointer font-semibold select-none">시연: 늦게 도착한 기록 만들기</summary>
          <label className="flex items-center gap-2 mt-2">
            <Input
              type="number"
              min={0}
              max={2880}
              value={delayMinutes}
              onChange={(e) => setDelayMinutes(Math.max(0, Number(e.target.value)))}
              className="w-24"
            />
            분 전에 서명해 둔 기록을 지금 전송 (0이면 정상)
          </label>
        </details>
      </Card>

      <SuccessButton disabled={!scannedNonce || !capturedBlob || stage !== null} onClick={submitCheck} className="w-full text-lg py-4">
        게이트 통과 제출
      </SuccessButton>

      {error && <ErrorText>{error}</ErrorText>}

      <details className="border-2 border-dashed border-charcoal/50 p-4 text-sm">
        <summary className="cursor-pointer font-semibold select-none text-ink">긴급·장비 장애 예외 출입</summary>
        <div className="mt-3 space-y-2.5">
          <p className="text-xs text-ink-muted">
            게이트 고장·응급 대응처럼 정상 검사를 할 수 없을 때만 씁니다. 감독자 서명과 감리(또는 발주처) 서명이 함께 있어야 기록되고,
            현장 통계와 감리 화면에 따로 집계됩니다. 위의 사번·현장 ID를 사용합니다.
          </p>
          <Select value={emergencyReason} onChange={(e) => setEmergencyReason(Number(e.target.value))}>
            {emergencyReasons.map((r) => (
              <option key={r.code} value={r.code}>
                {r.label}
              </option>
            ))}
          </Select>
          <div className="flex gap-2">
            <Select value={supervisorName} onChange={(e) => setSupervisorName(e.target.value)} className="flex-1">
              {supervisors.map((a) => (
                <option key={a.name} value={a.name}>
                  감독자 {a.name}
                </option>
              ))}
            </Select>
            {signingMode === 'server' && (
              <Select
                value={emergencyReviewer}
                onChange={(e) => setEmergencyReviewer(e.target.value as 'inspector' | 'owner')}
                className="flex-1"
              >
                <option value="inspector">감리 공동 서명</option>
                <option value="owner">발주처 공동 서명</option>
              </Select>
            )}
          </div>
          <SecondaryButton disabled={!workerId || !siteId || !supervisorName} onClick={submitEmergency}>
            {signingMode === 'wallet' ? '감독자 서명으로 예외 출입 요청' : '두 기관 서명으로 예외 출입 기록'}
          </SecondaryButton>
          {emergencyResult && (
            <p className="text-sm bg-safety-yellow/20 border-2 border-charcoal p-2.5">
              {emergencyResult.pending
                ? `요청을 올렸습니다 · 사유: ${emergencyResult.reason}. 감리 또는 발주처가 감리 감사 화면에서 자기 지갑으로 공동 서명하면 기록됩니다 (1시간 안)`
                : `예외 출입이 기록됐습니다 · 사유: ${emergencyResult.reason}`}
            </p>
          )}
          {emergencyError && <ErrorText>{emergencyError}</ErrorText>}
        </div>
      </details>

      {stage && (
        <ResultScreen
          stage={stage}
          result={result}
          overrideResult={overrideResult}
          showOverride={showOverride}
          onShowOverride={() => setShowOverride(true)}
          onNext={resetForNext}
          error={error}
          overridePanel={
            <div className="bg-white text-ink border-2 border-charcoal p-4 space-y-2.5 text-left">
              <p className="font-display font-bold uppercase text-charcoal">감독자 확인 (AI 오판 대응)</p>
              <p className="text-xs text-ink-muted">
                AI 판정은 그대로 남고, 사유 코드와 감독자 서명이 추가로 블록체인에 기록됩니다. 현장 통계와 감리·발주처 검토에도 집계됩니다.
              </p>
              <Select value={reasonCode} onChange={(e) => setReasonCode(Number(e.target.value))}>
                {reasons.map((r) => (
                  <option key={r.code} value={r.code}>
                    {r.label}
                  </option>
                ))}
              </Select>
              <Select value={supervisorName} onChange={(e) => setSupervisorName(e.target.value)}>
                {supervisors.length === 0 && <option value="">등록된 감독자 없음</option>}
                {supervisors.map((a) => (
                  <option key={a.name} value={a.name}>
                    {a.name}
                  </option>
                ))}
              </Select>
              <button
                onClick={submitOverride}
                disabled={!supervisorName || overriding}
                className="w-full bg-safety-yellow border-2 border-charcoal py-3 font-display font-bold uppercase text-charcoal disabled:opacity-40"
              >
                {overriding ? '서명 중...' : '사유를 남기고 출입 허용'}
              </button>
            </div>
          }
        />
      )}
    </div>
  )
}

function ResultScreen(props: {
  stage: Stage
  result: GateResult | null
  overrideResult: OverrideResult | null
  showOverride: boolean
  onShowOverride: () => void
  onNext: () => void
  error: string | null
  overridePanel: React.ReactNode
}) {
  const { stage, result, overrideResult, showOverride, onShowOverride, onNext, error, overridePanel } = props
  const done = (stage === 'confirmed' || stage === 'not_anchored') && result
  const stageIndex = STAGES.findIndex((s) => s.key === stage)

  let tone = 'bg-charcoal text-white'
  let icon = ''
  let title = '처리 중'
  let message = ''
  if (done && !result.anchored) {
    tone = 'bg-charcoal-light text-white'
    icon = '?'
    title = '기록 미확정'
    message = '블록체인 기록이 확정되지 않아 출입할 수 없습니다. 게이트 기록은 감리 감사 저장소에 남았습니다'
  } else if (done && result.entryStatus === 'Granted') {
    tone = 'bg-hazard-green text-white'
    icon = '✓'
    title = '출입 허용'
    message = '오늘 위험성평가가 등록돼 있고, 안전 검사를 모두 통과했습니다'
  } else if (done && overrideResult) {
    tone = 'bg-safety-yellow text-charcoal'
    icon = '!'
    title = '감독자 확인 후 출입 허용'
    message = `사유: ${overrideResult.reason}`
  } else if (done && result.entryStatus === 'HeldNoAssessment') {
    tone = 'bg-safety-orange text-white'
    icon = '‖'
    title = '출입 보류'
    message = '오늘 위험성평가가 아직 등록되지 않았습니다. 평가가 등록된 뒤 다시 검사받으세요. 출입 시도는 기록됐습니다'
  } else if (done && result.entryStatus === 'HeldHazardsOpen') {
    tone = 'bg-safety-orange text-white'
    icon = '‖'
    title = '출입 보류'
    message = '오늘 위험성평가에 아직 조치되지 않은 위험요인이 있습니다. 조치 완료가 등록된 뒤 다시 검사받으세요. 출입 시도는 기록됐습니다'
  } else if (done && result.entryStatus === 'SuspectTimestamp') {
    tone = 'bg-ink-muted text-white'
    icon = '⚠'
    title = '기록 시각 의심'
    message = '게이트 기기 시계가 블록체인 시각보다 앞서 있습니다. 출입 근거로 쓰지 않고 의심 기록으로 남겼습니다. 관리자에게 기기 시계 확인을 요청하세요'
  } else if (done && result.entryStatus === 'LateAuditOnly') {
    tone = 'bg-ink-muted text-white'
    icon = '⧗'
    title = '지연 도착 기록'
    message = '늦게 전송된 기록이라 출입 근거로 쓰지 않습니다. 검사 사실은 감사용으로 남았습니다'
  } else if (done) {
    tone = 'bg-hazard-red text-white'
    icon = '✕'
    title = '출입 불가'
    message = !result.alcoholPass
      ? '음주 측정 불합격입니다. 감독자 확인으로도 출입할 수 없습니다'
      : '보호구 착용을 확인해 주세요'
  }

  return (
    <div className={`fixed inset-0 z-50 flex flex-col items-center justify-center p-6 transition-colors duration-300 ${tone}`}>
      <div className="w-full max-w-xl text-center space-y-6">
        {!done && (
          <>
            <div className="mx-auto w-16 h-16 border-4 border-white/30 border-t-safety-yellow rounded-full animate-spin" />
            <ol className="space-y-2 text-left max-w-xs mx-auto">
              {STAGES.map((s, i) => (
                <li key={s.key} className={`flex items-center gap-3 text-lg ${i <= stageIndex ? 'text-white' : 'text-white/35'}`}>
                  <span className="w-6 text-center">{i < stageIndex ? '✓' : i === stageIndex ? '●' : '○'}</span>
                  <span className="font-display font-bold uppercase tracking-wide">{s.label}</span>
                </li>
              ))}
            </ol>
            {error && <p className="text-safety-yellow font-semibold">{error}</p>}
          </>
        )}

        {done && (
          <>
            <div className="text-8xl font-display font-extrabold leading-none">{icon}</div>
            <p className="text-5xl font-display font-extrabold uppercase tracking-wide">{title}</p>
            <p className="text-lg opacity-90">{message}</p>
            <div className="flex justify-center gap-2 text-sm font-semibold">
              {[
                ['안전모', result.helmetPass],
                ['안전화', result.shoesPass],
                ['음주', result.alcoholPass],
              ].map(([label, ok]) => (
                <span key={label as string} className="px-3 py-1.5 border-2 border-current">
                  {label} {ok ? '통과' : '불합격'}
                </span>
              ))}
            </div>

            {result.overridable && !overrideResult && !showOverride && (
              <button onClick={onShowOverride} className="underline underline-offset-4 font-semibold">
                AI 판정이 틀렸나요? 감독자 확인
              </button>
            )}
            {result.overridable && !overrideResult && showOverride && overridePanel}

            <div className="space-y-3">
              <button
                onClick={onNext}
                className="w-full bg-white text-charcoal border-2 border-charcoal py-4 text-xl font-display font-bold uppercase tracking-wide"
              >
                다음 작업자
              </button>
              <p className="text-xs opacity-80">
                게이트 기록 #{result.deviceSeq} · 감리 감사 저장소 {result.auditDelivered ? '전달됨' : '전달 실패'}
              </p>
              {(overrideResult?.txHash ?? result.txHash) && (
                <div className="opacity-80 [&_a]:text-current [&_summary]:text-current">
                  <ChainLink txHash={(overrideResult?.txHash ?? result.txHash) as string} />
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
