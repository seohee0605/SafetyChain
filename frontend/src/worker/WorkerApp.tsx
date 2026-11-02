import QRCode from 'qrcode'
import { useCallback, useEffect, useState } from 'react'
import { ChainLink } from '../components/ui'
import { BACKEND_URL } from '../config'
import {
  createPasskey,
  friendlyPasskeyError,
  passkeyUnavailableReason,
  signWithPasskey,
  type LoginOptions,
  type RegisterOptions,
} from './passkey'

// 근로자 앱 (별도 입구 worker.html). 관리 화면과 분리된 폰 전용 앱.
// 처음: 감독자에게 받은 초대 코드 + Face ID로 패스키 등록 → 이후: Face ID로 로그인
// 동의·출입 QR·내 기록은 로그인한 본인 것만 볼 수 있다 (서버가 세션 토큰의 사번으로만 응답)

type Profile = { workerId: string; siteId: string }
type Session = { token: string; expiresAt: number }
type QrIssue = { nonce: string; expiresAt: number }
type RecordRow = {
  nonce: string
  at: number
  result: 'pass' | 'fail' | 'override' | 'held' | 'hazards' | 'late' | 'suspect'
  helmetPass: boolean
  shoesPass: boolean
  txHash: string
}
type Tab = 'qr' | 'records'

const PROFILE_KEY = 'safetychain.worker' // 사번·현장만 (비밀값 아님)
const SESSION_KEY = 'safetychain.worker.session' // 세션 토큰은 탭을 닫으면 사라지게 sessionStorage

function load<T>(storage: Storage, key: string): T | null {
  try {
    const raw = storage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function store(storage: Storage, key: string, value: unknown) {
  try {
    if (value === null) storage.removeItem(key)
    else storage.setItem(key, JSON.stringify(value))
  } catch {
    // 저장 못 해도 이번 화면에서는 동작
  }
}

class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function api<T>(path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const headers: Record<string, string> = {}
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'
  if (init.token) headers['X-Worker-Token'] = init.token
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
  if (!res.ok) {
    let detail = res.statusText
    try {
      detail = (await res.json()).detail ?? detail
    } catch {
      // 본문 없음
    }
    throw new ApiError(res.status, String(detail))
  }
  return (await res.json()) as T
}

// 게이트 판정 화면과 같은 말·같은 색
const RESULT_LABEL = {
  pass: { text: '들어가세요', sub: '오늘도 안전하게!', short: '통과', cls: 'bg-hazard-green text-white', fg: 'text-hazard-green' },
  override: { text: '감독자 확인 후 통과', sub: 'AI 판정은 그대로 남고 수동 처리 기록이 추가됐어요', short: '수동 처리 통과', cls: 'bg-safety-yellow text-charcoal', fg: 'text-charcoal' },
  fail: { text: '들어갈 수 없어요', sub: '보호구나 음주 측정을 다시 확인해 주세요', short: '차단', cls: 'bg-hazard-red text-white', fg: 'text-hazard-red' },
  held: { text: '잠시 기다려 주세요', sub: '오늘 위험성평가가 아직 등록되지 않았어요', short: '보류 · 평가 전', cls: 'bg-safety-orange text-white', fg: 'text-safety-orange' },
  hazards: { text: '잠시 기다려 주세요', sub: '위험요인 조치가 아직 끝나지 않았어요', short: '보류 · 미조치', cls: 'bg-safety-orange text-white', fg: 'text-safety-orange' },
  late: { text: '지연 도착 기록', sub: '출입 근거로 쓰지 않고 감사용으로 남았어요', short: '지연 기록', cls: 'bg-ink-muted text-white', fg: 'text-ink-muted' },
  suspect: { text: '기록 시각 의심', sub: '게이트 기기 시계를 확인해야 해요', short: '시각 의심', cls: 'bg-ink-muted text-white', fg: 'text-ink-muted' },
}

const RESULT_ICON = { pass: '✓', override: '!', fail: '✕', held: '‖', hazards: '‖', late: '⧗', suspect: '⚠' }

export default function WorkerApp() {
  const [profile, setProfile] = useState<Profile | null>(() => load<Profile>(localStorage, PROFILE_KEY))
  const [session, setSession] = useState<Session | null>(() => {
    const s = load<Session>(sessionStorage, SESSION_KEY)
    return s && s.expiresAt > Date.now() / 1000 ? s : null
  })
  const [consent, setConsent] = useState<boolean | null>(null)
  const [tab, setTab] = useState<Tab>('qr')

  const signedIn = (p: Profile, s: Session) => {
    store(localStorage, PROFILE_KEY, p)
    store(sessionStorage, SESSION_KEY, s)
    setProfile(p)
    setSession(s)
  }

  const signOut = useCallback(() => {
    store(sessionStorage, SESSION_KEY, null)
    setSession(null)
    setConsent(null)
  }, [])

  // 세션이 만료되면(401) 로그인 화면으로
  const call = useCallback(
    async <T,>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
      try {
        return await api<T>(path, { ...init, token: session?.token })
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) signOut()
        throw e
      }
    },
    [session, signOut],
  )

  useEffect(() => {
    if (!profile || !session) return
    call<{ agreed: boolean }>(`/consent/${encodeURIComponent(profile.siteId)}/${encodeURIComponent(profile.workerId)}`)
      .then((r) => setConsent(r.agreed))
      .catch(() => setConsent(false))
  }, [profile, session, call])

  function forgetDevice() {
    if (!confirm('이 폰에서 사번 정보를 지울까요? 다시 쓰려면 감독자에게 새 초대 코드를 받아 등록해야 해요.')) return
    store(localStorage, PROFILE_KEY, null)
    signOut()
    setProfile(null)
  }

  async function withdraw() {
    if (!profile || !confirm('동의를 철회하면 자동 게이트를 쓸 수 없고, 관리자 대면 확인으로 출입해야 해요. 철회할까요?')) return
    await call('/consent/withdraw', { body: profile })
    setConsent(false)
  }

  const unavailable = passkeyUnavailableReason()

  return (
    <div className="min-h-dvh bg-paper flex justify-center">
      <div className="w-full max-w-md flex flex-col min-h-dvh">
        <header className="bg-charcoal text-white px-5 pt-[max(1.25rem,env(safe-area-inset-top))] pb-4">
          <p className="font-display text-xl font-extrabold uppercase tracking-wider leading-none">
            Safety<span className="text-safety-yellow">Chain</span>
            <span className="ml-2 text-sm text-white/60 normal-case tracking-normal font-sans font-medium">근로자</span>
          </p>
          {profile && (
            <p className="text-xs text-white/60 mt-1.5">
              사번 {profile.workerId} · 현장 {profile.siteId}
              {session && <span className="ml-2 text-safety-yellow">● 본인 확인됨</span>}
            </p>
          )}
        </header>
        <div className="h-1.5 hazard-stripes" />

        <main className="flex-1 px-5 py-6">
          {unavailable && !session && (
            <p className="mb-5 border-2 border-hazard-red bg-white p-3 text-sm font-semibold text-hazard-red">{unavailable}</p>
          )}
          {!profile && <Register onDone={signedIn} />}
          {profile && !session && <Login profile={profile} onDone={(s) => signedIn(profile, s)} />}
          {profile && session && consent === false && <Consent profile={profile} call={call} onAgreed={() => setConsent(true)} />}
          {profile && session && consent && tab === 'qr' && <EntryQr profile={profile} call={call} />}
          {profile && session && consent && tab === 'records' && <Records profile={profile} call={call} />}
        </main>

        {profile && session && consent && (
          <nav className="sticky bottom-0 grid grid-cols-2 border-t-2 border-charcoal bg-white pb-[env(safe-area-inset-bottom)]">
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
            {session && (
              <button onClick={signOut} className="underline">로그아웃</button>
            )}
            {session && consent && (
              <button onClick={withdraw} className="underline">동의 철회</button>
            )}
            <button onClick={forgetDevice} className="underline">이 폰에서 사번 지우기</button>
          </footer>
        )}
      </div>
    </div>
  )
}

type Call = <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>

const FIELD =
  'w-full border-2 border-charcoal/70 px-4 py-3.5 text-lg bg-white outline-none focus:border-charcoal focus:ring-2 focus:ring-safety-yellow'

function Register({ onDone }: { onDone: (p: Profile, s: Session) => void }) {
  const [workerId, setWorkerId] = useState('')
  const [siteId, setSiteId] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function register() {
    setBusy(true)
    setError(null)
    try {
      const ids = { workerId, siteId }
      const opt = await api<RegisterOptions>('/worker/register/options', { body: { ...ids, inviteCode } })
      const att = await createPasskey(opt, `사번 ${workerId}`)
      const r = await api<Session>('/worker/register', { body: { ...ids, inviteCode, ...att } })
      onDone(ids, r)
    } catch (e) {
      setError(e instanceof ApiError ? registerMessage(e) : friendlyPasskeyError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-black text-charcoal">처음 등록</h1>
      <p className="text-sm text-ink-muted">
        현장 감독자에게 받은 <b>초대 코드</b>를 넣고 Face ID로 이 폰을 등록해요. 다른 사람은 내 사번으로 QR을 받을 수 없어요.
      </p>
      <input className={FIELD} placeholder="사번" autoComplete="off" value={workerId} onChange={(e) => setWorkerId(e.target.value.trim())} />
      <input className={FIELD} placeholder="현장 ID" autoComplete="off" value={siteId} onChange={(e) => setSiteId(e.target.value.trim())} />
      <input
        className={`${FIELD} font-display tracking-[0.2em] uppercase`}
        placeholder="초대 코드"
        autoComplete="one-time-code"
        value={inviteCode}
        onChange={(e) => setInviteCode(e.target.value.trim().toUpperCase())}
      />
      {error && <p className="text-sm text-hazard-red font-semibold">{error}</p>}
      <BigButton disabled={busy || !workerId || !siteId || !inviteCode} onClick={register}>
        {busy ? 'Face ID 확인 중...' : 'Face ID로 등록'}
      </BigButton>
      <p className="text-xs text-ink-muted">
        이 폰에 만들어지는 패스키는 Face ID·지문으로만 쓸 수 있고, 서버에는 공개키만 저장돼요.
      </p>
    </div>
  )
}

function registerMessage(e: ApiError): string {
  if (e.message.includes('already used')) return '이미 사용한 초대 코드예요. 감독자에게 새 코드를 받아 주세요.'
  if (e.message.includes('expired')) return '초대 코드 유효기간이 지났어요. 감독자에게 새 코드를 받아 주세요.'
  if (e.message.includes('invalid invite')) return '사번·현장·초대 코드가 맞지 않아요.'
  if (e.message.includes('origin')) return '등록된 근로자 앱 주소가 아니에요. 감독자에게 앱 주소를 다시 받아 주세요.'
  return `등록하지 못했어요 (${e.message})`
}

function Login({ profile, onDone }: { profile: Profile; onDone: (s: Session) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function login() {
    setBusy(true)
    setError(null)
    try {
      const opt = await api<LoginOptions>('/worker/login/options', { body: profile })
      const sig = await signWithPasskey(opt)
      onDone(await api<Session>('/worker/login', { body: { ...profile, ...sig } }))
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setError('이 사번은 아직 등록되지 않았어요. "이 폰에서 사번 지우기" 후 초대 코드로 등록해 주세요.')
      else setError(e instanceof ApiError ? `로그인하지 못했어요 (${e.message})` : friendlyPasskeyError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6 text-center pt-6">
      <p className="mx-auto w-24 h-24 rounded-full bg-charcoal text-safety-yellow grid place-items-center text-5xl">☺</p>
      <div className="space-y-1">
        <h1 className="text-3xl font-black text-charcoal">본인 확인</h1>
        <p className="text-sm text-ink-muted">Face ID로 확인하면 오늘 출입 QR을 받을 수 있어요.</p>
      </div>
      {error && <p className="text-sm text-hazard-red font-semibold">{error}</p>}
      <BigButton disabled={busy} onClick={login}>
        {busy ? 'Face ID 확인 중...' : 'Face ID로 시작'}
      </BigButton>
    </div>
  )
}

function Consent({ profile, call, onAgreed }: { profile: Profile; call: Call; onAgreed: () => void }) {
  const [personal, setPersonal] = useState(false)
  const [sensitive, setSensitive] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function agree() {
    setError(null)
    try {
      await call('/consent', { body: { ...profile, personal, sensitive } })
      onAgreed()
    } catch {
      setError('저장하지 못했어요. 다시 시도해 주세요.')
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-black text-charcoal">정보 수집 동의</h1>
      <p className="text-sm text-ink-muted">자동 출입 게이트를 쓰려면 아래 두 가지 동의가 필요해요.</p>
      <ConsentBox
        checked={personal}
        onChange={setPersonal}
        title="[필수] 개인정보 수집·이용"
        rows={[
          ['항목', '사번'],
          ['목적', '현장 출입 관리'],
          ['블록체인', '사번은 날짜마다 바뀌는 가명으로만 기록 (실명·연락처 기록 안 함)'],
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
          ['블록체인', '사진 원본은 현장 서버에 암호화 보관, 블록체인에는 사진 해시와 통과 여부만'],
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

function ConsentBox(props: { checked: boolean; onChange: (v: boolean) => void; title: string; rows: [string, string][] }) {
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

function recordsPath(p: Profile) {
  return `/worker/${encodeURIComponent(p.siteId)}/${encodeURIComponent(p.workerId)}/records`
}

function EntryQr({ profile, call }: { profile: Profile; call: Call }) {
  const [qr, setQr] = useState<QrIssue | null>(null)
  const [image, setImage] = useState<string | null>(null)
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  const [used, setUsed] = useState<RecordRow | null>(null)
  const [error, setError] = useState<string | null>(null)

  const issue = useCallback(async () => {
    setError(null)
    setUsed(null)
    try {
      const data = await call<QrIssue>('/qr/issue', { body: profile })
      setQr(data)
      setImage(await QRCode.toDataURL(data.nonce, { margin: 1, width: 480 }))
    } catch {
      setError('QR을 받지 못했어요. 잠시 후 다시 시도해 주세요.')
    }
  }, [profile, call])

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
      const rows = await call<RecordRow[]>(recordsPath(profile)).catch(() => null)
      const hit = rows?.find((r) => r.nonce === qr.nonce)
      if (hit) setUsed(hit)
    }, 3000)
    return () => clearInterval(t)
  }, [qr, used, profile, call])

  if (used) {
    const label = RESULT_LABEL[used.result]
    return (
      <div className="space-y-5 text-center">
        <div className={`py-10 px-4 space-y-3 ${label.cls}`}>
          <p className={`mx-auto w-20 h-20 rounded-full bg-white grid place-items-center text-5xl font-black ${label.fg}`}>
            {RESULT_ICON[used.result]}
          </p>
          <p className="text-4xl font-black">{label.text}</p>
          <p className="font-bold">{label.sub}</p>
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
      <p className="text-2xl font-black text-charcoal">
        게이트 카메라에 <span className="bg-safety-yellow px-1">이 화면</span>을 보여주세요
      </p>
      <div className="relative bg-white p-4 aspect-square flex items-center justify-center border-[5px] border-safety-yellow">
        {image && <img src={image} alt="출입 QR" className={`w-full ${expired ? 'opacity-15' : ''}`} />}
        {expired && <p className="absolute font-display text-2xl font-bold uppercase text-charcoal">만료됨</p>}
      </div>
      {qr && !expired && (
        <p className="font-display text-2xl font-bold text-charcoal">
          {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}{' '}
          <span className="text-sm text-ink-muted font-sans font-normal">남음 · 1회용 · 본인 전용</span>
        </p>
      )}
      {error && <p className="text-sm text-hazard-red font-semibold">{error}</p>}
      <BigButton onClick={issue} variant={expired ? 'primary' : 'secondary'}>
        새 QR 받기
      </BigButton>
    </div>
  )
}

function Records({ profile, call }: { profile: Profile; call: Call }) {
  const [rows, setRows] = useState<RecordRow[] | null>(null)

  useEffect(() => {
    call<RecordRow[]>(recordsPath(profile))
      .then(setRows)
      .catch(() => setRows([]))
  }, [profile, call])

  if (rows === null) return <p className="text-sm text-ink-muted">불러오는 중...</p>
  if (rows.length === 0) return <p className="text-sm text-ink-muted">아직 출입 기록이 없어요.</p>

  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-black text-charcoal">내 출입 기록</h1>
      <p className="text-xs text-ink-muted">통과 여부만 보여요. 검사 사진과 음주 측정 결과는 앱에 표시하지 않아요.</p>
      {rows.map((r) => {
        const label = RESULT_LABEL[r.result]
        return (
          <div key={r.nonce} className="bg-white border-2 border-charcoal/20 p-4 space-y-2">
            <div className="flex justify-between items-center">
              <span className="text-sm text-ink">{new Date(r.at * 1000).toLocaleString()}</span>
              <span className={`text-xs font-bold px-2.5 py-1 ${label.cls}`}>{label.short}</span>
            </div>
            <ItemChips row={r} />
            <ChainLink txHash={r.txHash} />
          </div>
        )
      })}
    </div>
  )
}

// 음주 결과는 본인 화면에도 띄우지 않는다 (민감정보 최소 노출)
function ItemChips({ row }: { row: Pick<RecordRow, 'helmetPass' | 'shoesPass'> }) {
  return (
    <div className="flex gap-1.5 justify-center flex-wrap text-xs">
      {(
        [
          ['안전모', row.helmetPass],
          ['안전화', row.shoesPass],
        ] as const
      ).map(([label, ok]) => (
        <span
          key={label}
          className={`px-2 py-1 border-2 font-semibold ${ok ? 'border-hazard-green text-hazard-green' : 'border-hazard-red text-hazard-red'}`}
        >
          {label} {ok ? '통과' : '불합격'}
        </span>
      ))}
    </div>
  )
}

function BigButton(props: { onClick: () => void; disabled?: boolean; variant?: 'primary' | 'secondary'; children: React.ReactNode }) {
  const style = props.variant === 'secondary' ? 'bg-charcoal text-white' : 'bg-safety-yellow text-charcoal'
  return (
    <button
      onClick={props.onClick}
      disabled={props.disabled}
      className={`w-full py-4 text-xl font-black border-b-[5px] border-charcoal disabled:opacity-35 ${style}`}
    >
      {props.children}
    </button>
  )
}
