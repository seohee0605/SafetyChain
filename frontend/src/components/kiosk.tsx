import { useEffect, useState, type ReactNode } from 'react'
import { getTxBlock } from '../chain'
import { EXPLORER_URL } from '../config'

// 목업(demo/*-mockup)에서 화면마다 반복되는 조각들: 제목 줄, 단계 막대, 결과 패널, 아래 검은 띠, 하단 버튼 줄, 안내 상자

export const shortHex = (hex: string) => `${hex.slice(0, 6)}…${hex.slice(-4)}`
const pad = (n: number) => String(n).padStart(2, '0')
export const hhmm = (sec: number) => {
  const d = new Date(sec * 1000)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
export const hhmmss = (sec: number) => `${hhmm(sec)}:${pad(new Date(sec * 1000).getSeconds())}`

// 화면 맨 위 제목 줄. 오른쪽에는 버튼·지갑 표시 등을 넣는다
export function TitleBar({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <h1 className="text-2xl sm:text-3xl font-black text-charcoal">{title}</h1>
      {sub && <span className="text-base sm:text-lg font-bold text-ink-muted">{sub}</span>}
      {children && <div className="ml-auto flex flex-wrap items-center gap-2.5">{children}</div>}
    </div>
  )
}

export type StepState = 'done' | 'now' | 'rejected' | 'todo'

// 단계 진행 막대. 지난 단계는 초록 체크, 지금 단계는 노란색, 반려는 빨강
export function StepBar({ steps }: { steps: { label: string; sub?: string; state: StepState }[] }) {
  return (
    <ol className="grid gap-2" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
      {steps.map((s, i) => (
        <li
          key={s.label}
          className={`flex items-center gap-2.5 px-3.5 py-3 font-bold text-sm sm:text-base border-b-[5px] ${
            s.state === 'done'
              ? 'bg-white text-charcoal border-hazard-green'
              : s.state === 'now'
                ? 'bg-safety-yellow text-charcoal border-charcoal'
                : s.state === 'rejected'
                  ? 'bg-white text-hazard-red border-hazard-red'
                  : 'bg-paper-dark text-ink-muted border-charcoal/15'
          }`}
        >
          <span
            className={`w-7 h-7 shrink-0 rounded-full grid place-items-center text-sm border-2 ${
              s.state === 'done'
                ? 'bg-hazard-green border-hazard-green text-white'
                : s.state === 'now'
                  ? 'bg-charcoal border-charcoal text-white'
                  : s.state === 'rejected'
                    ? 'bg-hazard-red border-hazard-red text-white'
                    : 'border-ink-muted/50'
            }`}
          >
            {s.state === 'done' ? '✓' : s.state === 'rejected' ? '✕' : i + 1}
          </span>
          <span className="hidden sm:block min-w-0">
            {s.label}
            {s.sub && <small className="block text-xs font-medium opacity-80 truncate">{s.sub}</small>}
          </span>
        </li>
      ))}
    </ol>
  )
}

const RESULT_TONE = {
  green: ['bg-hazard-green text-white', 'text-hazard-green'],
  orange: ['bg-safety-orange text-white', 'text-safety-orange'],
  red: ['bg-hazard-red text-white', 'text-hazard-red'],
  redDark: ['bg-hazard-red-dark text-white', 'text-hazard-red-dark'],
  blue: ['bg-review-blue text-white', 'text-review-blue'],
  yellow: ['bg-safety-yellow text-charcoal', 'text-charcoal'],
  gray: ['bg-ink-muted text-white', 'text-ink-muted'],
  dark: ['bg-charcoal-light text-white', 'text-charcoal-light'],
} as const
export type ResultTone = keyof typeof RESULT_TONE

// ok: true=통과(✓), false=불합격(✕, 흰 칩), null=애매(?, 흰 칩), undefined=표시 없는 정보 칩
export type Chip = { label: string; ok?: boolean | null }

// 큰 색 패널 결과 화면 (게이트 판정, 위험성평가 제출 결과, 케이스 확정 등)
export function ResultPanel(props: {
  tone: ResultTone
  icon: string
  title: string
  sub?: ReactNode
  chips?: Chip[]
  actions?: ReactNode
  note?: ReactNode
  bar?: ReactNode
}) {
  const [bg, fg] = RESULT_TONE[props.tone]
  return (
    <div className={`flex-1 flex flex-col min-h-[480px] ${bg}`}>
      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-center">
        <div className={`w-24 h-24 rounded-full bg-white grid place-items-center text-6xl font-black ${fg}`}>{props.icon}</div>
        <p className="text-4xl sm:text-6xl font-black leading-tight">{props.title}</p>
        {props.sub && <p className="text-xl sm:text-2xl font-bold">{props.sub}</p>}
        {props.chips && <Chips chips={props.chips} />}
        {props.actions && <div className="flex flex-wrap justify-center gap-3 mt-2.5">{props.actions}</div>}
        {props.note && <div className="text-base opacity-90 max-w-2xl">{props.note}</div>}
      </div>
      {props.bar}
    </div>
  )
}

export function Chips({ chips }: { chips: Chip[] }) {
  return (
    <div className="flex flex-wrap justify-center gap-2.5 mt-1.5">
      {chips.map((c) => (
        <span key={c.label} className={`px-3.5 py-2 font-bold text-base sm:text-lg ${c.ok === false || c.ok === null ? 'bg-white text-charcoal' : 'bg-black/20'}`}>
          {c.ok === true ? '✓ ' : c.ok === false ? '✕ ' : c.ok === null ? '? ' : ''}
          {c.label}
        </span>
      ))}
    </div>
  )
}

// 결과 패널 위의 흰 버튼 / 테두리 버튼
export function PanelButton({ ghost, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { ghost?: boolean }) {
  return (
    <button
      {...props}
      className={`px-5 py-3.5 font-black text-lg disabled:cursor-not-allowed ${
        ghost ? 'bg-transparent border-2 border-current' : 'bg-white text-charcoal border-2 border-white'
      } ${props.disabled ? 'opacity-70' : 'hover:brightness-95'} ${props.className ?? ''}`}
    />
  )
}

// 결과 아래 검은 띠 (노란 네모 3개 + 제목 + 작은 설명)
export function Bar({ title, detail, right }: { title: ReactNode; detail?: ReactNode; right?: ReactNode }) {
  return (
    <div className="bg-charcoal text-white px-6 py-3.5 flex items-center gap-4">
      <div className="flex gap-1 shrink-0">
        {[0, 1, 2].map((i) => (
          <i key={i} className="w-4 h-4 bg-safety-yellow" />
        ))}
      </div>
      <div className="min-w-0">
        <p className="font-bold">{title}</p>
        {detail && <p className="text-xs text-white/60 mt-0.5">{detail}</p>}
      </div>
      {right && <div className="ml-auto font-bold shrink-0">{right}</div>}
    </div>
  )
}

// 기록번호(tx)로 블록 번호·블록 시각을 체인에서 직접 읽어 '블록 포함 시각 · 블록 # · Etherscan' 줄을 만든다
export function TxDetail({ txHash, prefix = [], suffix = [] }: { txHash: string | null; prefix?: ReactNode[]; suffix?: ReactNode[] }) {
  const [block, setBlock] = useState<{ blockNumber: bigint; timestamp: number } | null>(null)
  useEffect(() => {
    setBlock(null)
    if (!txHash) return
    getTxBlock(txHash as `0x${string}`)
      .then(setBlock)
      .catch(() => {})
  }, [txHash])

  const parts: ReactNode[] = [...prefix]
  if (block) {
    parts.push(`블록 포함 시각 ${hhmmss(block.timestamp)}`)
    parts.push(`블록 #${block.blockNumber.toLocaleString()}`)
  }
  if (txHash) parts.push(<TxLink key="tx" txHash={txHash} label={`기록번호 ${shortHex(txHash)}`} />)
  parts.push(...suffix)
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && ' · '}
          {p}
        </span>
      ))}
    </>
  )
}

export const VERIFY_HANDOFF_KEY = 'safetychain.verifyInput'

// 다른 화면에서 검증 화면으로 기록번호를 넘기고 이동한다 (검증 화면이 열리자마자 조회)
export function openVerify(txHash?: string | null) {
  if (txHash) {
    try {
      sessionStorage.setItem(VERIFY_HANDOFF_KEY, txHash)
    } catch {
      /* 저장 못 하면 검증 화면에서 붙여넣기 */
    }
  }
  window.location.hash = '/verify'
}

// 기록번호는 줄여서 보여주지만, 복사·검증은 항상 64자리 전체로 한다
export function TxLink({ txHash, label }: { txHash: string; label?: string }) {
  const text = label ?? `tx ${shortHex(txHash)}`
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(txHash)
    } catch {
      // 클립보드가 막힌 환경: 숨은 입력칸으로 복사
      const t = document.createElement('textarea')
      t.value = txHash
      document.body.appendChild(t)
      t.select()
      document.execCommand('copy')
      t.remove()
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  const btn = 'ml-1.5 px-1.5 py-0.5 border border-current/40 text-[11px] font-bold hover:bg-white/10 align-middle'
  return (
    <span className="whitespace-nowrap">
      {EXPLORER_URL ? (
        <a href={`${EXPLORER_URL}/tx/${txHash}`} target="_blank" rel="noreferrer" title={txHash} className="text-safety-yellow underline font-bold">
          {text} ↗{label ? ' Etherscan' : ''}
        </a>
      ) : (
        <span className="font-mono" title={txHash}>{text}</span>
      )}
      <button type="button" onClick={copy} className={btn}>{copied ? '복사됨 ✓' : '전체 복사'}</button>
      <button type="button" onClick={() => openVerify(txHash)} className={btn}>검증 →</button>
    </span>
  )
}

// 화면 아래 버튼 줄 (← 이전 · 설명 · 다음 →)
export function BottomBar({ children }: { children: ReactNode }) {
  return <div className="bg-white border-t border-charcoal/10 -mx-6 px-6 py-3.5 flex flex-wrap items-center gap-3 sticky bottom-0">{children}</div>
}

export function NavButton({ primary, danger, className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean; danger?: boolean }) {
  const look = primary
    ? 'bg-safety-yellow hover:bg-safety-yellow-dark text-charcoal border-b-[5px] border-charcoal'
    : danger
      ? 'bg-white text-hazard-red border-2 border-hazard-red'
      : 'bg-white text-charcoal border-2 border-charcoal'
  return <button {...props} className={`px-6 py-3.5 font-black text-lg disabled:opacity-35 disabled:cursor-not-allowed ${look} ${className}`} />
}

// 노란(경고)·빨간(위험) 안내 상자
export function Warn({ children, danger }: { children: ReactNode; danger?: boolean }) {
  return (
    <div className={`flex gap-3 p-3.5 text-sm font-bold leading-relaxed ${danger ? 'bg-hazard-red/10' : 'bg-safety-yellow/20'}`}>
      <span className={`w-6 h-6 shrink-0 grid place-items-center text-sm ${danger ? 'bg-hazard-red text-white' : 'bg-safety-yellow-dark text-white'}`}>!</span>
      <span>{children}</span>
    </div>
  )
}

// 회색 작은 안내 (i 표시)
export function Hint({ icon = 'i', children }: { icon?: string; children: ReactNode }) {
  return (
    <p className="flex gap-2.5 items-start text-sm text-ink-muted">
      <span className="w-5 h-5 shrink-0 grid place-items-center bg-charcoal/10 text-xs font-bold">{icon}</span>
      <span>{children}</span>
    </p>
  )
}

// 검은 설명 상자 ('제출하면 이렇게 남아요' 등)
export function DarkBox({ title, items }: { title: string; items: ReactNode[] }) {
  return (
    <div className="bg-charcoal text-white p-5 space-y-2">
      <div className="flex gap-1">
        {[0, 1, 2].map((i) => (
          <i key={i} className="w-3.5 h-3.5 bg-safety-yellow" />
        ))}
      </div>
      <p className="font-black text-lg">{title}</p>
      <ul className="space-y-1 text-sm text-white/80 list-disc pl-5">
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    </div>
  )
}

export function Label({ children, note }: { children: ReactNode; note?: string }) {
  return (
    <p className="text-sm font-bold text-charcoal mb-1.5">
      {children}
      {note && <small className="ml-1.5 font-medium text-ink-muted">{note}</small>}
    </p>
  )
}

// 시연용 현장·날짜 선택 줄 (여러 화면이 같이 쓴다)
export function SitePicker(props: {
  siteId: string
  workDate: string
  onSite: (v: string) => void
  onDate: (v: string) => void
  onLoad?: () => void
  loadLabel?: string
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-2 border-charcoal bg-white px-2 py-1.5">
      <input
        placeholder="현장 ID"
        value={props.siteId}
        onChange={(e) => props.onSite(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && props.onLoad?.()}
        className="w-28 px-2 py-1 font-bold outline-none"
      />
      <input type="date" value={props.workDate} onChange={(e) => props.onDate(e.target.value)} className="px-2 py-1 font-bold outline-none" />
      {props.onLoad && (
        <button onClick={props.onLoad} disabled={!props.siteId} className="bg-charcoal text-white px-3 py-1 text-sm font-bold disabled:opacity-35">
          {props.loadLabel ?? '조회'}
        </button>
      )}
    </div>
  )
}
