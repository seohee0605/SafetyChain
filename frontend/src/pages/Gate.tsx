import jsQR from 'jsqr'
import QRCode from 'qrcode'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { caseIdOf } from '../chain'
import { Card, ErrorText, Input, Select } from '../components/ui'
import { BACKEND_URL, GATE_URL } from '../config'
import { Modal, ModalButtons, OptionList } from './gate/Modal'
import { StepBar } from '../components/kiosk'
import type { Admin, AiPreview, EmergencyResult, GateResult, OverrideResult, QrIssue, Reason, SiteRecord, Stage, VerdictKind } from './gate/types'
import { verdictOf } from './gate/types'
import { Verdict } from './gate/Verdict'

// 4단계 '블록체인 기록' 화면에 보여줄 게이트 서비스 진행 단계 (gate/main.py _steps 순서)
const CHAIN_ROWS: { key: Stage; label: string }[] = [
  { key: 'inspecting', label: 'AI 보호구 판정' },
  { key: 'signing', label: '게이트 기기 서명' },
  { key: 'auditing', label: '감리 감사 저장소로 원본 전송' },
  { key: 'anchoring', label: '블록 포함 대기' },
]

const GATE_STEPS = ['QR 확인', '보호구 촬영', '음주 측정', '블록체인 기록', '출입 판정']

// 통과 화면에서 다음 근로자로 자동으로 넘어가기까지 (초)
const AUTO_RESET_SEC = 5

// 실제로는 QR은 근로자 폰(#/worker)에, 스캔·촬영은 게이트 태블릿에서 일어난다.
// 같은 브라우저에서 시연할 때는 '시연 도구'에서 QR을 발급한다.
const today = () => new Date().toISOString().slice(0, 10)
const hhmm = (sec: number) => new Date(sec * 1000).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
// 화면에는 사번을 가려서 보여준다 (예: 20231234 → 20****34)
const maskWorker = (id: string) => (id.length <= 3 ? id[0] + '*'.repeat(Math.max(0, id.length - 1)) : id.slice(0, 2) + '*'.repeat(id.length - 4) + id.slice(-2))

// 데모 영상 촬영용: 주소 끝에 ?demo 를 붙이면 웹캠 대신 준비된 사진을 쓴다 (판정은 실제 백엔드)
const DEMO_MODE = new URLSearchParams(window.location.search).has('demo')
const DEMO_CAPTURE_IMAGE = '/demo-helmet.jpg'
const FRAME_COUNT = 4 // 1초 동안 찍을 장수 (게이트 정책: 3~5장, 모두 통과해야 통과)
const FRAME_INTERVAL_MS = 250

// 시연 도구의 '판정 화면 미리보기' 버튼. 체인에 아무것도 보내지 않고 화면만 띄운다
const PREVIEWS: { kind: VerdictKind; label: string }[] = [
  { kind: 'pass', label: '통과' },
  { kind: 'heldNoAssessment', label: '보류 (평가 없음)' },
  { kind: 'heldHazards', label: '보류 (위험요인 미조치)' },
  { kind: 'deny', label: '보호구 차단' },
  { kind: 'alcohol', label: '음주 차단' },
  { kind: 'pending', label: '확정 대기' },
]

function previewResult(kind: VerdictKind): GateResult {
  return {
    anchored: kind !== 'pending',
    pending: kind === 'pending',
    txHash: null,
    verdict: kind === 'pass',
    nonce: '0x',
    helmetPass: kind !== 'deny',
    shoesPass: true,
    alcoholPass: kind !== 'alcohol',
    overridable: kind === 'deny',
    entryStatus: null,
    entryAllowed: kind === 'pass',
    deviceSeq: 0,
    auditDelivered: true,
  }
}

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
  const [shoesPass, setShoesPass] = useState(false) // 감독자 육안 확인. 기본은 미확인(불합격)
  const [aiPreview, setAiPreview] = useState<AiPreview | null>(null)
  const [capturedBlob, setCapturedBlob] = useState<Blob | null>(null) // 첫 프레임 (미리보기·AI 1차 의견용)
  const [capturedFrames, setCapturedFrames] = useState<Blob[]>([])
  const [capturing, setCapturing] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [stage, setStage] = useState<Stage | null>(null)
  const [submittedAt, setSubmittedAt] = useState<number | null>(null)
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
  const [showEmergency, setShowEmergency] = useState(false)
  const [signingMode, setSigningMode] = useState<'wallet' | 'server'>('wallet')
  const [siteRecord, setSiteRecord] = useState<SiteRecord | null | undefined>(undefined) // undefined: 아직 모름
  const [showTools, setShowTools] = useState(false)
  const [previewKind, setPreviewKind] = useState<VerdictKind | null>(null)
  const [countdown, setCountdown] = useState<number | null>(null)
  const [now, setNow] = useState(Date.now())
  const [kiosk, setKiosk] = useState(false)

  const rootRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
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
    startCamera()
    const onFullscreen = () => setKiosk(document.fullscreenElement === rootRef.current)
    document.addEventListener('fullscreenchange', onFullscreen)
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreen)
      if (scanFrameRef.current) cancelAnimationFrame(scanFrameRef.current)
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  // 시계, 그리고 블록체인 기록 중 '몇 초 경과' 표시용
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const done = stage === 'confirmed' || stage === 'not_anchored'
  const kind: VerdictKind | null = previewKind ?? (done && result ? verdictOf(result, overrideResult) : null)
  const shownResult = previewKind ? previewResult(previewKind) : result
  const step = kind === 'pending' ? 3 : kind ? 4 : stage ? 3 : capturedBlob ? 2 : scannedNonce ? 1 : 0
  const elapsedSec = submittedAt ? Math.max(0, Math.round((now - submittedAt) / 1000)) : 0

  // 오늘 위험성평가 상태 (QR 화면 위 안내). 실제 출입 판정은 체인이 하고, 여기선 근로자에게 미리 알려주기만 한다
  useEffect(() => {
    if (!siteId || (step !== 0 && step !== 4)) return
    const caseId = caseIdOf(siteId, workDate)
    fetch(`${BACKEND_URL}/site/records/${encodeURIComponent(siteId)}`)
      .then((res) => res.json())
      .then((list: SiteRecord[]) => setSiteRecord(list.find((r) => r.caseId.toLowerCase() === caseId.toLowerCase()) ?? null))
      .catch(() => setSiteRecord(undefined))
  }, [siteId, workDate, step])

  // 통과(또는 감독자 수동 통과)면 몇 초 뒤 자동으로 다음 근로자 화면으로
  useEffect(() => {
    if (previewKind || (kind !== 'pass' && kind !== 'override')) {
      setCountdown(null)
      return
    }
    setCountdown(AUTO_RESET_SEC)
    const timer = setInterval(() => setCountdown((c) => (c === null ? null : c - 1)), 1000)
    return () => clearInterval(timer)
  }, [kind, previewKind])
  useEffect(() => {
    if (countdown === 0) resetForNext()
  }, [countdown])

  function resetForNext() {
    setQr(null)
    setQrImageUrl(null)
    setScannedNonce(null)
    setCapturedBlob(null)
    setCapturedFrames([])
    setPreviewUrl(null)
    setStage(null)
    setSubmittedAt(null)
    setResult(null)
    setOverrideResult(null)
    setShowOverride(false)
    setAlcoholPass(true)
    setShoesPass(false)
    setAiPreview(null)
    setError(null)
    setPreviewKind(null)
    setCountdown(null)
  }

  async function issueQr() {
    resetForNext()
    const res = await fetch(`${BACKEND_URL}/qr/issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerId, siteId }),
    })
    if (res.status === 401) {
      setError('근로자 인증 모드예요. 근로자 앱(Face ID 로그인)에서 QR을 받아 주세요. (백엔드 WORKER_AUTH=off일 때만 여기서 발급)')
      return
    }
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
    if (res.status === 401) {
      setError('근로자 인증 모드에서는 근로자가 앱에서 직접 동의해요.')
      return
    }
    if (!res.ok) {
      setError('동의 저장 실패')
      return
    }
    await issueQr()
  }

  async function startCamera() {
    if (DEMO_MODE) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true })
      streamRef.current = stream
      if (videoRef.current) videoRef.current.srcObject = stream
    } catch {
      setError('웹캠 접근 실패 (권한을 확인하세요)')
    }
  }

  // QR 화면과 촬영 화면이 서로 다른 <video>를 쓰므로, 새로 붙을 때마다 카메라 스트림을 다시 연결한다
  function attachVideo(el: HTMLVideoElement | null) {
    videoRef.current = el
    if (el && streamRef.current && el.srcObject !== streamRef.current) el.srcObject = streamRef.current
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

      const scanned = code ? parseEntryQr(code.data) : null
      if (scanned) {
        setScannedNonce(scanned.nonce)
        if (scanned.workerId) setWorkerId(scanned.workerId)
        if (scanned.siteId) setSiteId(scanned.siteId)
        setScanning(false)
        return
      }
      scanFrameRef.current = requestAnimationFrame(tick)
    }
    scanFrameRef.current = requestAnimationFrame(tick)
  }

  // 촬영 직후 AI 1차 의견을 받아 감독자에게 보여준다 (출입 판정은 /check에서 다시 계산)
  async function runPreview(blob: Blob) {
    setAiPreview(null)
    try {
      const form = new FormData()
      form.append('image', blob, 'capture.jpg')
      const res = await fetch(`${GATE_URL}/preview`, { method: 'POST', body: form })
      if (res.ok) setAiPreview(await res.json())
    } catch {
      // 미리보기 실패는 출입 흐름을 막지 않는다
    }
  }

  // 멘토링 4회차 Q3: 1초 동안 FRAME_COUNT장을 찍어 모두 보내고, 게이트는 모든 프레임이 통과해야 통과시킨다
  function grabFrame(): Promise<Blob | null> {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return Promise.resolve(null)
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d')?.drawImage(video, 0, 0)
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg'))
  }

  async function capture() {
    let frames: Blob[] = []
    if (DEMO_MODE) {
      // 시연 모드(웹캠 없음): 준비된 사진 한 장을 프레임 수만큼 보낸다
      const res = await fetch(DEMO_CAPTURE_IMAGE)
      const blob = await res.blob()
      frames = Array.from({ length: FRAME_COUNT }, () => blob)
    } else {
      setCapturing(true)
      for (let i = 0; i < FRAME_COUNT; i++) {
        const b = await grabFrame()
        if (b) frames.push(b)
        if (i < FRAME_COUNT - 1) await new Promise((r) => setTimeout(r, FRAME_INTERVAL_MS))
      }
      setCapturing(false)
    }
    if (frames.length === 0) return
    setCapturedFrames(frames)
    setCapturedBlob(frames[0])
    setPreviewUrl(URL.createObjectURL(frames[0]))
    void runPreview(frames[0])
  }

  function retake() {
    setCapturedBlob(null)
    setCapturedFrames([])
    setAiPreview(null)
    setPreviewUrl(null)
  }

  // 백엔드가 단계(검사 → 서명 → 온체인 기록 → 확정)를 끝낼 때마다 한 줄씩 보내준다
  async function submitCheck() {
    if (!scannedNonce || capturedFrames.length === 0) return
    setError(null)
    setResult(null)
    setStage('inspecting')
    setSubmittedAt(Date.now())
    try {
      const form = new FormData()
      capturedFrames.forEach((b, i) => form.append('image', b, `frame${i}.jpg`))
      form.append('nonce', scannedNonce)
      form.append('alcoholPass', String(alcoholPass))
      form.append('shoesPass', String(shoesPass))
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
      setSubmittedAt(null)
      setError(e instanceof Error ? e.message : '알 수 없는 오류')
    }
  }

  // '확정 대기': 트랜잭션이 60초 안에 블록에 안 들어간 경우. 정상 판정 기준(서명 후 3분) 동안 4초마다 체인을 다시 본다.
  // 그 안에 들어가면 체인 판정대로 결과를 바꾸고, 끝내 안 들어가면 '기록 미확정'으로 남긴다 (Gatekeeper 유지)
  const pendingNonce = result && !result.anchored && result.pending ? result.nonce : null
  useEffect(() => {
    if (!pendingNonce) return
    const startedAt = Date.now()
    const timer = setInterval(async () => {
      const res = await fetch(`${BACKEND_URL}/gate/status/${pendingNonce}`).catch(() => null)
      const body = res?.ok ? await res.json() : null
      if (body?.anchored) {
        clearInterval(timer)
        setResult((r) => (r && r.nonce === pendingNonce ? { ...r, ...body, pending: false } : r))
        setStage('confirmed')
      } else if (Date.now() - startedAt > 3 * 60 * 1000) {
        clearInterval(timer)
        setResult((r) => (r && r.nonce === pendingNonce ? { ...r, pending: false } : r))
      }
    }, 4000)
    return () => clearInterval(timer)
  }, [pendingNonce])

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

  function toggleKiosk() {
    if (document.fullscreenElement) document.exitFullscreen()
    else rootRef.current?.requestFullscreen().catch(() => {})
  }

  const workerLabel = workerId ? maskWorker(workerId) : '근로자'
  const missingIds = !workerId || !siteId

  return (
    <div ref={rootRef} className={`space-y-4 ${kiosk ? 'bg-paper p-6 overflow-y-auto' : ''}`}>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl sm:text-3xl font-black text-charcoal">게이트 출입 검사</h1>
        <span className="text-sm font-bold text-ink-muted">
          {siteId ? `${siteId} 현장` : ''}
        </span>
        <div className="ml-auto flex gap-2.5">
          <button onClick={() => setShowTools((s) => !s)} className="border-2 border-charcoal px-4 py-2 font-bold text-sm">
            시연 도구 {showTools ? '▾' : '▸'}
          </button>
          <button onClick={toggleKiosk} className="bg-charcoal text-white border-2 border-charcoal px-4 py-2 font-bold text-sm">
            ⛶ {kiosk ? '키오스크 끝내기' : '키오스크 모드'}
          </button>
        </div>
      </div>

      {showTools && (
        <Card>
          <WorkerInvite supervisors={supervisors} workerId={workerId} siteId={siteId} onWorker={setWorkerId} onSite={setSiteId} />
          <p className="text-xs text-ink-muted">
            근로자는 폰에서 <a href="/worker.html" className="underline font-semibold">근로자 앱</a>을 열어 Face ID로 로그인하고 QR을 띄웁니다.
            아래 "QR 발급"은 근로자 인증을 끈 경우(백엔드 WORKER_AUTH=off)에만 쓰는 예전 방식이에요. 사번·현장 ID는 예외 출입에도 쓰입니다.
          </p>
          <div className="grid sm:grid-cols-4 gap-2.5">
            <Input placeholder="사번" value={workerId} onChange={(e) => setWorkerId(e.target.value)} />
            <Input placeholder="현장 ID" value={siteId} onChange={(e) => setSiteId(e.target.value)} />
            <Input type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)} />
            <button disabled={missingIds} onClick={issueQr} className="bg-charcoal text-white font-bold px-4 py-2.5 disabled:opacity-35">
              QR 발급 (예전 방식)
            </button>
          </div>

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
              <button
                disabled={!consentPersonal || !consentSensitive}
                onClick={giveConsent}
                className="bg-charcoal text-white font-bold px-4 py-2.5 disabled:opacity-35"
              >
                동의 후 QR 발급
              </button>
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

          <label className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
            늦게 도착한 기록 만들기:
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

          <div className="space-y-1.5">
            <p className="text-sm font-semibold text-ink">판정 화면 미리보기 (체인에 기록하지 않음)</p>
            <div className="flex flex-wrap gap-2">
              {PREVIEWS.map((p) => (
                <button
                  key={p.kind}
                  onClick={() => setPreviewKind(p.kind)}
                  className={`border-2 border-charcoal px-3 py-1.5 text-sm font-bold ${previewKind === p.kind ? 'bg-safety-yellow' : 'bg-white'}`}
                >
                  {p.label}
                </button>
              ))}
              {previewKind && (
                <button onClick={() => setPreviewKind(null)} className="px-3 py-1.5 text-sm font-bold underline">
                  미리보기 끄기
                </button>
              )}
            </div>
          </div>
        </Card>
      )}

      <StepBar steps={GATE_STEPS.map((label, i) => ({ label, state: i < step ? 'done' : i === step ? 'now' : 'todo' }))} />

      <div className="flex flex-col lg:flex-row gap-5 min-h-[520px]">
        {kind && shownResult ? (
          <Verdict
            kind={kind}
            result={shownResult}
            overrideResult={overrideResult}
            siteRecord={siteRecord ?? (previewKind ? { caseId: '', hazardsControlled: false, adminName: '', timestamp: Date.now() / 1000, hazards: [{ hazard: '감전 · 가설 분전반', completed: false }] } : null)}
            workerLabel={workerLabel}
            elapsedSec={elapsedSec}
            countdown={countdown}
            preview={previewKind !== null}
            onNext={resetForNext}
            onShowOverride={() => {
              // AI가 감독자 확인 구간으로 판정했으면 사유 기본값을 'AI 저신뢰'(4)로
              setReasonCode(result?.ai?.helmetDecision === 'supervisor' ? 4 : 1)
              setShowOverride(true)
            }}
          />
        ) : step === 3 ? (
          <ChainProgress stage={stage as Stage} elapsedSec={elapsedSec} />
        ) : step === 0 ? (
          <>
            <div className="flex-1 flex flex-col justify-center gap-5">
              <AssessmentPill siteId={siteId} record={siteRecord} />
              <p className="text-4xl sm:text-5xl font-black leading-snug text-charcoal">
                휴대폰 <Highlight>QR 코드</Highlight>를<br />
                카메라에 비춰 주세요
              </p>
              <p className="text-lg text-ink-muted leading-relaxed">
                QR은 근로자 앱에서 열 수 있어요.
                <br />한 번만 쓸 수 있고, 발급 후 5분이 지나면 다시 받아야 해요.
              </p>
              <BigButton onClick={startScan} disabled={scanning || (DEMO_MODE && !qr)} className="sm:w-80">
                {scanning ? 'QR 찾는 중…' : 'QR 스캔 시작'}
              </BigButton>
              <p className="text-sm text-ink-muted">
                처음 오는 근로자는 위 <button onClick={() => setShowTools(true)} className="underline font-semibold">시연 도구</button>의
                현장 등록에서 초대 코드를 받아 근로자 앱에 등록해요.
              </p>
            </div>
            <CameraBox className="lg:w-[46%]">
              {DEMO_MODE ? (
                qrImageUrl && <img src={qrImageUrl} alt="게이트 카메라가 보는 QR" className="h-3/5 aspect-square object-contain" />
              ) : (
                <video ref={attachVideo} autoPlay muted playsInline className="absolute inset-0 w-full h-full object-cover" />
              )}
            </CameraBox>
          </>
        ) : (
          <>
            <div className="flex-1 flex flex-col gap-3.5">
              <p className="text-2xl sm:text-3xl font-black text-charcoal">
                {step === 1 ? (
                  <>
                    네모 칸 안에 <Highlight>전신</Highlight>이 보이게 서 주세요
                  </>
                ) : (
                  <>
                    <Highlight>음주 측정기</Highlight>에 숨을 불어 주세요
                  </>
                )}
              </p>
              <CameraBox className="flex-1" label={step === 2 ? '촬영 완료' : undefined}>
                {step === 2 && previewUrl ? (
                  <img src={previewUrl} alt="촬영한 사진" className="absolute inset-0 w-full h-full object-contain" />
                ) : DEMO_MODE ? (
                  <img src={DEMO_CAPTURE_IMAGE} alt="시연용 사진" className="absolute inset-0 w-full h-full object-contain opacity-60" />
                ) : (
                  <video ref={attachVideo} autoPlay muted playsInline className="absolute inset-0 w-full h-full object-cover" />
                )}
              </CameraBox>
            </div>
            <div className="lg:w-[360px] flex flex-col gap-3">
              <Box caption="확인된 근로자">
                <p className="text-2xl font-black mt-1">사번 {workerLabel}</p>
                <p className="text-hazard-green font-bold mt-1">✓ QR 유효 · 일회용 확인됨</p>
              </Box>
              <Box caption="보호구 검사">
                {step === 2 && aiPreview ? (
                  !aiPreview.person ? (
                    <p className="text-hazard-red font-bold mt-1">사람이 검출되지 않았어요. 다시 촬영하세요</p>
                  ) : (
                    <>
                      <Row
                        label="안전모 (AI 1차 의견)"
                        value={aiPreview.helmetDecision === 'pass' ? '착용으로 보임' : aiPreview.helmetDecision === 'supervisor' ? '확실하지 않음 → 감독자 확인' : '미착용으로 보임'}
                      />
                      <Row
                        label="안전화 (AI 1차 의견)"
                        value={`${aiPreview.shoesOpinion === 'looks_work' ? '작업화로 보임' : '작업화로 보이지 않음'}${aiPreview.shoesDecision === 'supervisor' ? ' → 감독자 확인' : ''}`}
                      />
                    </>
                  )
                ) : (
                  <>
                    <Row label="안전모" value={step === 1 ? `촬영 후 AI 판정 (1초 ${FRAME_COUNT}장)` : '제출 후 AI 판정'} />
                    <Row label="안전화" value={step === 1 ? 'AI 1차 의견 + 감독자 확인' : '제출 후 AI 판정'} />
                  </>
                )}
                {step === 2 && (
                  <button onClick={retake} className="text-sm underline font-semibold text-ink-muted mt-1">
                    다시 촬영
                  </button>
                )}
              </Box>
              {step === 2 && (
                <Box caption="작업화 착용 확인 (감독자 육안)">
                  <div className="mt-2">
                    <OptionList
                      options={[
                        { value: 'ok', label: '작업화 착용 확인' },
                        { value: 'no', label: '미확인 · 작업화 아님' },
                      ]}
                      value={shoesPass ? 'ok' : 'no'}
                      onChange={(v) => {
                        if (aiPreview && aiPreview.shoesDecision !== 'supervisor') return
                        setShoesPass(v === 'ok')
                      }}
                    />
                  </div>
                  <p className="text-xs text-ink-muted mt-2">
                    AI가 1차로 보고, 확실하지 않으면 감독자가 확인해요. 지금 정책은 모든 경우 감독자가 체크해요 (정책 변경은 policyHash로 기록).
                  </p>
                </Box>
              )}
              {step === 2 && (
                <Box caption="음주 측정기 결과 (시연: 직접 선택)">
                  <div className="mt-2">
                    <OptionList
                      options={[
                        { value: 'pass', label: '기준 이하 · 통과' },
                        { value: 'fail', label: '기준 초과' },
                      ]}
                      value={alcoholPass ? 'pass' : 'fail'}
                      onChange={(v) => setAlcoholPass(v === 'pass')}
                    />
                  </div>
                </Box>
              )}
              <div className="flex-1" />
              {step === 1 ? (
                <BigButton onClick={capture} disabled={capturing}>
                  {capturing ? '촬영 중 (1초)…' : `촬영하기 (1초 ${FRAME_COUNT}장)`}
                </BigButton>
              ) : (
                <BigButton onClick={submitCheck}>검사 제출</BigButton>
              )}
            </div>
          </>
        )}
      </div>

      <canvas ref={canvasRef} className="hidden" />
      <canvas ref={scanCanvasRef} className="hidden" />

      {error && <ErrorText>{error}</ErrorText>}

      <div className="bg-paper-dark flex flex-wrap items-center gap-2 px-5 py-3 text-sm font-bold">
        <button onClick={() => setShowEmergency(true)} className="hover:underline">
          감독자 전용 ▸ 긴급·장비 장애 예외 출입
        </button>
        <span className="ml-auto text-ink-muted font-medium">검사 결과는 블록체인에 자동 기록돼요</span>
      </div>

      {showOverride && (
        <Modal caption="감독자 전용 · 보호구 판정 수동 처리" title="AI 판정을 뒤집는 사유를 골라 주세요" onClose={() => setShowOverride(false)}>
          <OptionList options={reasons.map((r) => ({ value: r.code, label: `${r.code}. ${r.label}` }))} value={reasonCode} onChange={setReasonCode} />
          <Select value={supervisorName} onChange={(e) => setSupervisorName(e.target.value)}>
            {supervisors.length === 0 && <option value="">등록된 감독자 없음</option>}
            {supervisors.map((a) => (
              <option key={a.name} value={a.name}>
                감독자 {a.name}
              </option>
            ))}
          </Select>
          <p className="text-sm text-ink-muted leading-relaxed">
            원래 'AI 불합격' 기록은 그대로 남고, 감독자 서명이 붙은 수동 처리 기록이 하나 더 쌓여요. 감리·발주처가 하루치 기록을 승인할 때 이 건을
            따로 검토해요. 음주 불합격은 수동 처리할 수 없어요.
          </p>
          <ModalButtons>
            <button onClick={() => setShowOverride(false)} className="border-2 border-charcoal py-3.5 font-black">
              취소
            </button>
            <button
              onClick={submitOverride}
              disabled={previewKind !== null || !supervisorName || overriding}
              className="bg-charcoal text-white border-2 border-charcoal py-3.5 font-black disabled:opacity-40"
            >
              {previewKind ? '미리보기에선 기록 안 함' : overriding ? '서명 중…' : '감독자 서명하고 통과'}
            </button>
          </ModalButtons>
        </Modal>
      )}

      {showEmergency && (
        <Modal caption="감독자 전용 · 예외 출입" title="게이트로 검사할 수 없는 상황인가요?" onClose={() => setShowEmergency(false)}>
          <p className="text-sm text-ink-muted leading-relaxed">
            게이트 고장·응급 대응처럼 정상 검사를 할 수 없을 때만 씁니다. 감독자 서명과 감리(또는 발주처) 서명이 함께 있어야 기록되고, 현장
            통계와 감리 화면에 따로 집계됩니다.
          </p>
          <OptionList options={emergencyReasons.map((r) => ({ value: r.code, label: r.label }))} value={emergencyReason} onChange={setEmergencyReason} />
          <div className="grid grid-cols-2 gap-2">
            <Input placeholder="사번" value={workerId} onChange={(e) => setWorkerId(e.target.value)} />
            <Input placeholder="현장 ID" value={siteId} onChange={(e) => setSiteId(e.target.value)} />
          </div>
          <div className="flex gap-2">
            <Select value={supervisorName} onChange={(e) => setSupervisorName(e.target.value)} className="flex-1">
              {supervisors.map((a) => (
                <option key={a.name} value={a.name}>
                  감독자 {a.name}
                </option>
              ))}
            </Select>
            {signingMode === 'server' && (
              <Select value={emergencyReviewer} onChange={(e) => setEmergencyReviewer(e.target.value as 'inspector' | 'owner')} className="flex-1">
                <option value="inspector">감리 공동 서명</option>
                <option value="owner">발주처 공동 서명</option>
              </Select>
            )}
          </div>
          {emergencyResult && (
            <p className="text-sm bg-safety-yellow/20 border-2 border-charcoal p-2.5">
              {emergencyResult.pending
                ? `요청을 올렸습니다 · 사유: ${emergencyResult.reason}. 감리 또는 발주처가 감리 감사 화면에서 자기 지갑으로 공동 서명하면 기록됩니다 (1시간 안)`
                : `예외 출입이 기록됐습니다 · 사유: ${emergencyResult.reason}`}
            </p>
          )}
          {emergencyError && <ErrorText>{emergencyError}</ErrorText>}
          <ModalButtons>
            <button onClick={() => setShowEmergency(false)} className="border-2 border-charcoal py-3.5 font-black">
              닫기
            </button>
            <button
              onClick={submitEmergency}
              disabled={missingIds || !supervisorName}
              className="bg-charcoal text-white border-2 border-charcoal py-3.5 font-black disabled:opacity-40"
            >
              {signingMode === 'wallet' ? '감독자 서명으로 요청' : '두 기관 서명으로 기록'}
            </button>
          </ModalButtons>
        </Modal>
      )}
    </div>
  )
}

// QR 화면 위 '오늘 위험성평가' 안내. undefined면 아직 모름(현장 ID 없음·조회 실패)
function AssessmentPill({ siteId, record }: { siteId: string; record: SiteRecord | null | undefined }) {
  if (!siteId || record === undefined) return null
  const [tone, text] =
    record === null
      ? ['border-safety-orange text-safety-orange', '! 오늘 위험성평가가 아직 등록되지 않았어요 · 검사해도 출입 보류돼요']
      : !record.hazardsControlled
        ? ['border-safety-orange text-safety-orange', `! 오늘 위험성평가에 조치 안 된 위험요인이 있어요 (${hhmm(record.timestamp)} 제출)`]
        : ['border-hazard-green text-hazard-green', `✓ 오늘 위험성평가 등록됨 · 조치 완료 (${hhmm(record.timestamp)} ${record.adminName} 서명)`]
  return <p className={`self-start bg-white border-2 px-3 py-1.5 text-sm font-bold ${tone}`}>{text}</p>
}

// 4단계: 게이트 서비스가 보내주는 진행 단계를 그대로 보여준다. 판정은 블록에 들어간 뒤에만 나온다
function ChainProgress({ stage, elapsedSec }: { stage: Stage; elapsedSec: number }) {
  const current = CHAIN_ROWS.findIndex((r) => r.key === stage)
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center">
      <div className="flex gap-2.5">
        {[1, 0.6, 0.3].map((o, i) => (
          <i key={i} className="w-11 h-11 bg-safety-yellow animate-pulse" style={{ opacity: o, animationDelay: `${i * 150}ms` }} />
        ))}
      </div>
      <p className="text-3xl sm:text-4xl font-black text-charcoal">
        블록체인에 <Highlight>기록하는 중</Highlight>이에요
      </p>
      <p className="text-lg text-ink-muted">보통 10초 안에 끝나요. 기록이 확정되면 바로 출입 판정이 나와요.</p>
      <div className="bg-white w-full max-w-xl px-6 py-2 text-left">
        {CHAIN_ROWS.map((r, i) => (
          <Row
            key={r.key}
            label={r.label}
            value={i < current ? '✓ 완료' : i === current ? (r.key === 'anchoring' ? `${elapsedSec}초 경과…` : '진행 중…') : '대기'}
            tone={i < current ? 'ok' : i === current ? 'wait' : 'muted'}
          />
        ))}
      </div>
    </div>
  )
}

function Highlight({ children }: { children: ReactNode }) {
  return <span className="bg-safety-yellow px-1.5">{children}</span>
}

function CameraBox({ children, className = '', label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <div className={`relative bg-charcoal min-h-[320px] grid place-items-center overflow-hidden ${className}`}>
      {children}
      <span className="absolute left-4 top-4 bg-black/80 text-white text-xs font-bold px-2.5 py-1.5 flex items-center gap-2">
        <i className="w-2 h-2 rounded-full bg-hazard-red" />
        {label ?? '카메라 켜짐'}
      </span>
      {!label && (
        <div className="relative w-56 h-56 pointer-events-none">
          {['left-0 top-0 border-l-4 border-t-4', 'right-0 top-0 border-r-4 border-t-4', 'left-0 bottom-0 border-l-4 border-b-4', 'right-0 bottom-0 border-r-4 border-b-4'].map((c) => (
            <i key={c} className={`absolute w-14 h-14 border-safety-yellow ${c}`} />
          ))}
        </div>
      )}
    </div>
  )
}

function Box({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="bg-white px-5 py-4">
      <p className="text-xs font-bold text-ink-muted">{caption}</p>
      {children}
    </div>
  )
}

function Row({ label, value, tone = 'wait' }: { label: string; value: string; tone?: 'ok' | 'wait' | 'muted' }) {
  const color = tone === 'ok' ? 'text-hazard-green' : tone === 'wait' ? 'text-safety-yellow-dark' : 'text-ink-muted'
  return (
    <div className="flex justify-between gap-3 py-2.5 border-b border-charcoal/10 last:border-0 text-lg font-bold">
      <span>{label}</span>
      <span className={color}>{value}</span>
    </div>
  )
}

function BigButton({ className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`bg-safety-yellow hover:bg-safety-yellow-dark text-charcoal text-xl font-black py-5 px-6 border-b-[5px] border-charcoal disabled:opacity-35 disabled:cursor-not-allowed ${className}`}
    />
  )
}

// 근로자 앱 QR: {"v":1,"n":nonce,"w":사번,"s":현장} (예전 QR은 nonce만)
function parseEntryQr(data: string): { nonce: string; workerId?: string; siteId?: string } | null {
  const isNonce = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v)
  if (isNonce(data)) return { nonce: data }
  try {
    const o = JSON.parse(data)
    if (o && isNonce(o.n)) {
      return { nonce: o.n, workerId: typeof o.w === 'string' ? o.w : undefined, siteId: typeof o.s === 'string' ? o.s : undefined }
    }
  } catch {
    // QR이 아닌 다른 내용
  }
  return null
}

// 현장 등록: 감독자가 근로자를 대면 확인하고 일회용 초대 코드를 발급한다 (근로자 앱 패스키 등록에 필요)
function WorkerInvite(props: {
  supervisors: Admin[]
  workerId: string
  siteId: string
  onWorker: (v: string) => void
  onSite: (v: string) => void
}) {
  const [supervisor, setSupervisor] = useState('')
  const [invite, setInvite] = useState<{ code: string; expiresAt: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function issue() {
    setError(null)
    setInvite(null)
    const res = await fetch(`${BACKEND_URL}/worker/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerId: props.workerId, siteId: props.siteId, supervisorName: supervisor }),
    })
    if (!res.ok) {
      setError('초대 코드를 발급하지 못했어요')
      return
    }
    setInvite(await res.json())
  }

  return (
    <div className="border-2 border-charcoal bg-safety-yellow/15 p-3 space-y-2.5">
      <p className="font-bold text-charcoal">현장 등록 · 근로자 초대 코드</p>
      <p className="text-xs text-ink-muted">신분증으로 본인을 확인한 뒤 발급하세요. 코드는 한 번만 쓸 수 있고 24시간 뒤 만료돼요.</p>
      <div className="grid sm:grid-cols-4 gap-2.5">
        <Input placeholder="사번" value={props.workerId} onChange={(e) => props.onWorker(e.target.value)} />
        <Input placeholder="현장 ID" value={props.siteId} onChange={(e) => props.onSite(e.target.value)} />
        <Select value={supervisor} onChange={(e) => setSupervisor(e.target.value)}>
          <option value="">확인한 감독자</option>
          {props.supervisors.map((a) => (
            <option key={a.name} value={a.name}>
              {a.name}
            </option>
          ))}
        </Select>
        <button
          disabled={!props.workerId || !props.siteId || !supervisor}
          onClick={issue}
          className="bg-charcoal text-white font-bold px-4 py-2.5 disabled:opacity-35"
        >
          초대 코드 발급
        </button>
      </div>
      {invite && (
        <p className="text-sm">
          초대 코드{' '}
          <span className="font-display text-2xl font-extrabold tracking-[0.15em] bg-white border-2 border-charcoal px-2">{invite.code}</span>
          <span className="ml-2 text-ink-muted">만료 {new Date(invite.expiresAt * 1000).toLocaleString()}</span>
        </p>
      )}
      {error && <p className="text-sm font-semibold text-hazard-red">{error}</p>}
    </div>
  )
}
