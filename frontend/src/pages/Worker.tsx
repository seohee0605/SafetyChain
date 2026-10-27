import QRCode from 'qrcode'
import { useCallback, useEffect, useState } from 'react'
import { ChainLink } from '../components/ui'
import { BACKEND_URL } from '../config'

// 근로자 폰용 화면 (#/worker). 동의 → 출입 QR → 내 출입 기록
// 로그인 없이 사번·현장만 폰에 기억해 둔다

type Profile = { workerId: string; siteId: string }
type QrIssue = { nonce: string; expiresAt: number }
type RecordRow = {
  nonce: string
  at: number
  result: 'pass' | 'fail' | 'override' | 'held' | 'late'
  helmetPass: boolean
  shoesPass: boolean
  alcoholPass: boolean
  txHash: string
}
type Tab = 'qr' | 'records'

const STORAGE_KEY = 'safetychain.worker'

function loadProfile(): Profile | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function saveProfile(p: Profile | null) {
  try {
    if (p) localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // 저장 못 해도 이번 화면에서는 동작
  }
}

const RESULT_LABEL = {
  pass: { text: '출입 허용', cls: 'bg-hazard-green text-white' },
  override: { text: '감독자 확인 후 허용', cls: 'bg-safety-yellow text-charcoal' },
  fail: { text: '출입 불가', cls: 'bg-hazard-red text-white' },
  held: { text: '위험성평가 전 보류', cls: 'bg-safety-orange text-white' },
  late: { text: '지연 도착 (감사용)', cls: 'bg-ink-muted text-white' },
}

const RESULT_ICON = { pass: '✓', override: '!', fail: '✕', held: '‖', late: '⧗' }

export default function Worker() {
  const [profile, setProfile] = useState<Profile | null>(loadProfile)
  const [consent, setConsent] = useState<boolean | null>(null)
  const [tab, setTab] = useState<Tab>('qr')

  useEffect(() => {
    if (!profile) return
    fetch(`${BACKEND_URL}/consent/${encodeURIComponent(profile.siteId)}/${encodeURIComponent(profile.workerId)}`)
      .then((res) => res.json())
      .then((r: { agreed: boolean }) => setConsent(r.agreed))
      .catch(() => setConsent(false))
  }, [profile])

  function logout() {
    saveProfile(null)
    setProfile(null)
    setConsent(null)
  }

  async function withdraw() {
    if (!profile || !confirm('동의를 철회하면 자동 게이트를 쓸 수 없고, 관리자 대면 확인으로 출입해야 해요. 철회할까요?')) return
    await fetch(`${BACKEND_URL}/consent/withdraw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profile),
    })
    setConsent(false)
  }

  return (
    <div className="min-h-screen bg-paper flex justify-center">
      <div className="w-full max-w-md flex flex-col min-h-screen">
        <header className="bg-charcoal text-white px-5 pt-5 pb-4">
          <div className="h-1 hazard-stripes -mx-5 -mt-5 mb-4" />
          <p className="font-display text-xl font-extrabold uppercase tracking-wider leading-none">
            Safety<span className="text-safety-yellow">Chain</span>
            <span className="ml-2 text-sm text-white/60 normal-case tracking-normal font-sans font-medium">근로자</span>
          </p>
          {profile && (
            <p className="text-xs text-white/60 mt-1.5">
              사번 {profile.workerId} · 현장 {profile.siteId}
            </p>
          )}
        </header>

        <main className="flex-1 px-5 py-6">
          {!profile && (
            <Setup
              onDone={(p) => {
                saveProfile(p)
                setProfile(p)
              }}
            />
          )}
          {profile && consent === false && <Consent profile={profile} onAgreed={() => setConsent(true)} />}
          {profile && consent && tab === 'qr' && <EntryQr profile={profile} />}
          {profile && consent && tab === 'records' && <Records profile={profile} />}
        </main>

        {profile && consent && (
          <nav className="sticky bottom-0 grid grid-cols-2 border-t-2 border-charcoal bg-white">
            {(['qr', 'records'] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`py-4 font-display font-bold uppercase tracking-wide ${tab === t ? 'bg-safety-yellow text-charcoal' : 'text-ink-muted'}`}
              >
                {t === 'qr' ? '출입 QR' : '내 기록'}
              </button>
            ))}
          </nav>
        )}

        {profile && (
          <footer className="px-5 py-3 text-xs text-ink-muted flex gap-4 justify-center">
            <button onClick={logout} className="underline">사번 변경</button>
            {consent && (
              <button onClick={withdraw} className="underline">동의 철회</button>
            )}
            <a href="#/gate" className="underline">관리 화면</a>
          </footer>
        )}
      </div>
    </div>
  )
}

function Setup({ onDone }: { onDone: (p: Profile) => void }) {
  const [workerId, setWorkerId] = useState('')
  const [siteId, setSiteId] = useState('')
  const field =
    'w-full border-2 border-charcoal/70 px-4 py-3.5 text-lg bg-white outline-none focus:border-charcoal focus:ring-2 focus:ring-safety-yellow'
  return (
    <div className="space-y-4">
      <h1 className="font-display text-3xl font-bold uppercase text-charcoal">시작하기</h1>
      <p className="text-sm text-ink-muted">현장에서 받은 사번과 현장 ID를 입력해 주세요.</p>
      <input className={field} placeholder="사번" value={workerId} onChange={(e) => setWorkerId(e.target.value.trim())} />
      <input className={field} placeholder="현장 ID" value={siteId} onChange={(e) => setSiteId(e.target.value.trim())} />
      <BigButton disabled={!workerId || !siteId} onClick={() => onDone({ workerId, siteId })}>
        다음
      </BigButton>
    </div>
  )
}

function Consent({ profile, onAgreed }: { profile: Profile; onAgreed: () => void }) {
  const [personal, setPersonal] = useState(false)
  const [sensitive, setSensitive] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function agree() {
    setError(null)
    const res = await fetch(`${BACKEND_URL}/consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...profile, personal, sensitive }),
    })
    if (res.ok) onAgreed()
    else setError('저장하지 못했어요. 다시 시도해 주세요.')
  }

  return (
    <div className="space-y-4">
      <h1 className="font-display text-3xl font-bold uppercase text-charcoal">정보 수집 동의</h1>
      <p className="text-sm text-ink-muted">자동 출입 게이트를 쓰려면 아래 두 가지 동의가 필요해요.</p>

      <ConsentBox
        checked={personal}
        onChange={setPersonal}
        title="[필수] 개인정보 수집·이용"
        rows={[
          ['항목', '사번'],
          ['목적', '현장 출입 관리'],
          ['블록체인', '사번은 현장별 비밀값과 섞은 해시로만 기록 (실명·연락처 기록 안 함)'],
          ['보관', '해당 현장 공사 기간'],
        ]}
      />
      <ConsentBox
        checked={sensitive}
        onChange={setSensitive}
        title="[필수] 민감정보 수집·이용 (별도 동의)"
        rows={[
          ['항목', '게이트 검사 사진, 음주 측정 통과 여부 (측정 수치는 저장하지 않음)'],
          ['목적', '보호구 착용·음주 여부 확인을 통한 산업재해 예방'],
          ['블록체인', '사진 원본은 현장 서버에만, 블록체인에는 사진 해시와 통과 여부만'],
          ['보관', '해당 현장 공사 기간'],
        ]}
      />

      <p className="text-xs text-ink-muted">
        동의하지 않을 권리가 있어요. 동의하지 않아도 관리자 대면 확인으로 출입할 수 있고, 언제든 앱에서 철회할 수 있어요.
      </p>
      {error && <p className="text-sm text-hazard-red font-semibold">{error}</p>}
      <BigButton disabled={!personal || !sensitive} onClick={agree}>
        동의하고 시작
      </BigButton>
    </div>
  )
}

function ConsentBox(props: {
  checked: boolean
  onChange: (v: boolean) => void
  title: string
  rows: [string, string][]
}) {
  return (
    <label className={`block border-2 p-4 bg-white ${props.checked ? 'border-charcoal' : 'border-charcoal/30'}`}>
      <div className="flex items-center gap-3">
        <input
          type="checkbox"
          checked={props.checked}
          onChange={(e) => props.onChange(e.target.checked)}
          className="w-6 h-6 accent-safety-yellow shrink-0"
        />
        <span className="font-semibold text-charcoal">{props.title}</span>
      </div>
      <dl className="mt-3 space-y-1 text-xs text-ink-muted">
        {props.rows.map(([k, v]) => (
          <div key={k} className="flex gap-2">
            <dt className="w-14 shrink-0 font-semibold">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </label>
  )
}

function EntryQr({ profile }: { profile: Profile }) {
  const [qr, setQr] = useState<QrIssue | null>(null)
  const [image, setImage] = useState<string | null>(null)
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  const [used, setUsed] = useState<RecordRow | null>(null)
  const [error, setError] = useState<string | null>(null)

  const issue = useCallback(async () => {
    setError(null)
    setUsed(null)
    const res = await fetch(`${BACKEND_URL}/qr/issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profile),
    })
    if (!res.ok) {
      setError('QR을 받지 못했어요. 잠시 후 다시 시도해 주세요.')
      return
    }
    const data: QrIssue = await res.json()
    setQr(data)
    setImage(await QRCode.toDataURL(data.nonce, { margin: 1, width: 480 }))
  }, [profile])

  useEffect(() => {
    issue()
  }, [issue])

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(t)
  }, [])

  // 게이트에서 이 QR이 쓰였는지 확인해서 결과를 폰에도 띄운다
  useEffect(() => {
    if (!qr || used) return
    const t = setInterval(async () => {
      const res = await fetch(
        `${BACKEND_URL}/worker/${encodeURIComponent(profile.siteId)}/${encodeURIComponent(profile.workerId)}/records`,
      ).catch(() => null)
      if (!res?.ok) return
      const rows: RecordRow[] = await res.json()
      const hit = rows.find((r) => r.nonce === qr.nonce)
      if (hit) setUsed(hit)
    }, 3000)
    return () => clearInterval(t)
  }, [qr, used, profile])

  if (used) {
    const label = RESULT_LABEL[used.result]
    return (
      <div className="space-y-5 text-center">
        <div className={`py-10 border-2 border-charcoal ${label.cls}`}>
          <p className="text-6xl font-display font-extrabold">{RESULT_ICON[used.result]}</p>
          <p className="text-3xl font-display font-extrabold uppercase mt-2">{label.text}</p>
        </div>
        <ItemChips row={used} />
        <ChainLink txHash={used.txHash} />
        <BigButton onClick={issue}>새 QR 받기</BigButton>
      </div>
    )
  }

  const left = qr ? qr.expiresAt - now : 0
  const expired = qr !== null && left <= 0

  return (
    <div className="space-y-5 text-center">
      <p className="text-sm text-ink-muted">게이트 카메라에 이 화면을 보여주세요</p>
      <div className="relative bg-white border-2 border-charcoal p-4 aspect-square flex items-center justify-center">
        {image && <img src={image} alt="출입 QR" className={`w-full ${expired ? 'opacity-15' : ''}`} />}
        {expired && <p className="absolute font-display text-2xl font-bold uppercase text-charcoal">만료됨</p>}
      </div>
      {qr && !expired && (
        <p className="font-display text-2xl font-bold text-charcoal">
          {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} <span className="text-sm text-ink-muted font-sans font-normal">남음 · 1회용</span>
        </p>
      )}
      {error && <p className="text-sm text-hazard-red font-semibold">{error}</p>}
      <BigButton onClick={issue} variant={expired ? 'primary' : 'secondary'}>
        새 QR 받기
      </BigButton>
    </div>
  )
}

function Records({ profile }: { profile: Profile }) {
  const [rows, setRows] = useState<RecordRow[] | null>(null)

  useEffect(() => {
    fetch(`${BACKEND_URL}/worker/${encodeURIComponent(profile.siteId)}/${encodeURIComponent(profile.workerId)}/records`)
      .then((res) => res.json())
      .then(setRows)
      .catch(() => setRows([]))
  }, [profile])

  if (rows === null) return <p className="text-sm text-ink-muted">불러오는 중...</p>
  if (rows.length === 0) return <p className="text-sm text-ink-muted">아직 출입 기록이 없어요.</p>

  return (
    <div className="space-y-3">
      <h1 className="font-display text-2xl font-bold uppercase text-charcoal">내 출입 기록</h1>
      <p className="text-xs text-ink-muted">통과 여부만 보여요. 검사 사진과 음주 수치는 앱에 표시하지 않아요.</p>
      {rows.map((r) => {
        const label = RESULT_LABEL[r.result]
        return (
          <div key={r.nonce} className="bg-white border-2 border-charcoal/20 p-4 space-y-2">
            <div className="flex justify-between items-center">
              <span className="text-sm text-ink">{new Date(r.at * 1000).toLocaleString()}</span>
              <span className={`text-xs font-display font-bold uppercase px-2.5 py-1 border-2 border-charcoal ${label.cls}`}>{label.text}</span>
            </div>
            <ItemChips row={r} />
            <ChainLink txHash={r.txHash} />
          </div>
        )
      })}
    </div>
  )
}

function ItemChips({ row }: { row: Pick<RecordRow, 'helmetPass' | 'shoesPass' | 'alcoholPass'> }) {
  return (
    <div className="flex gap-1.5 justify-center flex-wrap text-xs">
      {[
        ['안전모', row.helmetPass],
        ['안전화', row.shoesPass],
        ['음주', row.alcoholPass],
      ].map(([label, ok]) => (
        <span key={label as string} className={`px-2 py-1 border-2 font-semibold ${ok ? 'border-hazard-green text-hazard-green' : 'border-hazard-red text-hazard-red'}`}>
          {label} {ok ? '통과' : '불합격'}
        </span>
      ))}
    </div>
  )
}

function BigButton(props: {
  onClick: () => void
  disabled?: boolean
  variant?: 'primary' | 'secondary'
  children: React.ReactNode
}) {
  const style =
    props.variant === 'secondary'
      ? 'bg-charcoal text-white'
      : 'bg-safety-yellow text-charcoal'
  return (
    <button
      onClick={props.onClick}
      disabled={props.disabled}
      className={`w-full border-2 border-charcoal py-4 text-lg font-display font-bold uppercase tracking-wide disabled:opacity-35 ${style}`}
    >
      {props.children}
    </button>
  )
}
