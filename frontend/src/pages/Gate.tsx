import jsQR from 'jsqr'
import QRCode from 'qrcode'
import { useEffect, useRef, useState } from 'react'
import { Card, ErrorText, Input, PageTitle, SecondaryButton, StepHeading, SuccessButton } from '../components/ui'
import { BACKEND_URL } from '../config'

type QrIssue = { nonce: string; expiresAt: number }
type GateResult = { txHash: string; verdict: boolean }

// 이 페이지는 "인부 화면"(QR 발급)과 "게이트 화면"(QR 스캔 + 촬영)을 한 브라우저에서
// 시뮬레이션한다. 실제 배포에서는 QR은 인부 개인 폰에, 스캔/촬영은 게이트 기기에서 각각
// 일어난다. 스캔으로 읽은 nonce만 제출에 쓰기 때문에, 발급된 nonce와 실제 스캔된 값이
// 다르면(예: 화면 캡처를 잘못 보여줬을 때) 그대로 드러난다 — 이게 이 데모의 핵심 증명 포인트.
const today = () => new Date().toISOString().slice(0, 10)

export default function Gate() {
  const [workerId, setWorkerId] = useState('')
  const [siteId, setSiteId] = useState('')
  const [workDate, setWorkDate] = useState(today())
  const [qr, setQr] = useState<QrIssue | null>(null)
  const [qrImageUrl, setQrImageUrl] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scannedNonce, setScannedNonce] = useState<string | null>(null)
  const [alcoholPass, setAlcoholPass] = useState(true)
  const [capturedBlob, setCapturedBlob] = useState<Blob | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [result, setResult] = useState<GateResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const scanCanvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const scanFrameRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (scanFrameRef.current) cancelAnimationFrame(scanFrameRef.current)
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  async function issueQr() {
    setError(null)
    setResult(null)
    setScannedNonce(null)
    const res = await fetch(`${BACKEND_URL}/qr/issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerId, siteId }),
    })
    if (!res.ok) {
      setError('QR 발급 실패')
      return
    }
    const data: QrIssue = await res.json()
    setQr(data)
    setQrImageUrl(await QRCode.toDataURL(data.nonce, { margin: 1, width: 220 }))
  }

  async function startCamera() {
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

  function capture() {
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

  async function submitCheck() {
    if (!scannedNonce || !capturedBlob) return
    setLoading(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('image', capturedBlob, 'capture.jpg')
      form.append('nonce', scannedNonce)
      form.append('alcoholPass', String(alcoholPass))
      form.append('workerId', workerId)
      form.append('siteId', siteId)
      form.append('workDate', workDate)

      const res = await fetch(`${BACKEND_URL}/gate/check`, { method: 'POST', body: form })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.detail ?? '제출 실패')
      }
      setResult(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : '알 수 없는 오류')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-5">
      <PageTitle title="게이트 시뮬레이터" subtitle="QR 발급(인부 화면) → 스캔(게이트 화면) → 촬영 → 온체인 제출" />

      <Card>
        <StepHeading step={1}>인부 화면: QR 발급</StepHeading>
        <div className="space-y-2.5">
          <Input placeholder="사번" value={workerId} onChange={(e) => setWorkerId(e.target.value)} />
          <Input placeholder="현장 ID" value={siteId} onChange={(e) => setSiteId(e.target.value)} />
          <Input type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)} />
          <SecondaryButton disabled={!workerId || !siteId} onClick={issueQr}>
            QR 발급
          </SecondaryButton>
          {qrImageUrl && (
            <div className="flex items-center gap-4 bg-paper-dark border-2 border-charcoal p-3">
              <img src={qrImageUrl} alt="발급된 QR" className="w-28 h-28 border-2 border-charcoal" />
              <p className="text-xs text-ink-muted">
                실제 배포 시 이 QR은 인부 개인 폰에 표시됩니다.
                <br />
                만료: {qr && new Date(qr.expiresAt * 1000).toLocaleTimeString()}
              </p>
            </div>
          )}
        </div>
      </Card>

      <Card>
        <StepHeading step={2}>게이트 화면: QR 스캔 + 촬영</StepHeading>
        <video ref={videoRef} autoPlay muted className="w-full bg-charcoal border-2 border-charcoal aspect-video object-cover" />
        <canvas ref={canvasRef} className="hidden" />
        <canvas ref={scanCanvasRef} className="hidden" />
        <div className="flex gap-2 flex-wrap">
          <SecondaryButton onClick={startCamera}>웹캠 시작</SecondaryButton>
          <SecondaryButton onClick={startScan} disabled={!qr || scanning}>
            {scanning ? 'QR 스캔 중...' : 'QR 스캔 시작'}
          </SecondaryButton>
          <SecondaryButton onClick={capture} disabled={!scannedNonce}>
            촬영
          </SecondaryButton>
        </div>
        {scannedNonce && (
          <p className="text-xs font-mono break-all bg-hazard-green/10 border-2 border-hazard-green text-hazard-green font-semibold p-3">
            ✅ 스캔된 nonce: {scannedNonce}
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
      </Card>

      <SuccessButton disabled={!scannedNonce || !capturedBlob || loading} onClick={submitCheck} className="w-full">
        {loading ? '제출 중...' : '게이트 통과 제출'}
      </SuccessButton>

      {error && <ErrorText>{error}</ErrorText>}
      {result && (
        <Card>
          <p className="font-display font-bold uppercase text-charcoal text-lg">
            {result.verdict ? '✅ 통과' : '❌ 미통과'}
          </p>
          <p className="text-xs font-mono break-all text-ink-muted">tx: {result.txHash}</p>
        </Card>
      )}
    </div>
  )
}
