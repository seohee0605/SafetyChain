import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { EXPLORER_URL } from '../config'

export function PageTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-6 border-b-4 border-charcoal pb-3">
      <h1 className="font-display text-3xl font-bold uppercase tracking-wide text-charcoal leading-none">
        {title}
      </h1>
      <p className="text-sm text-ink-muted mt-1.5">{subtitle}</p>
    </div>
  )
}

export function Card({ children }: { children: ReactNode }) {
  return (
    <div className="bg-white rounded-sm border-2 border-charcoal shadow-[5px_5px_0_0_var(--color-charcoal)] p-6 space-y-4">
      {children}
    </div>
  )
}

export function StepHeading({ step, children }: { step: number; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex items-center justify-center w-8 h-8 bg-safety-yellow border-2 border-charcoal text-charcoal font-display font-extrabold text-lg shrink-0">
        {step}
      </span>
      <h2 className="font-display font-bold uppercase tracking-wide text-charcoal text-lg">{children}</h2>
    </div>
  )
}

const fieldBase =
  'border-2 border-charcoal/70 rounded-none px-3.5 py-2.5 w-full text-ink placeholder:text-ink-muted/70 outline-none focus:border-charcoal focus:ring-2 focus:ring-safety-yellow transition-colors bg-white'

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${fieldBase} ${props.className ?? ''}`} />
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${fieldBase} ${props.className ?? ''}`} />
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${fieldBase} ${props.className ?? ''}`} />
}

export function PrimaryButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`bg-safety-yellow hover:bg-safety-yellow-dark text-charcoal border-2 border-charcoal rounded-none px-4 py-2.5 font-display font-bold uppercase tracking-wide transition-colors disabled:opacity-35 disabled:cursor-not-allowed ${props.className ?? ''}`}
    />
  )
}

export function SecondaryButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`bg-charcoal hover:bg-charcoal-light text-white border-2 border-charcoal rounded-none px-4 py-2.5 font-display font-bold uppercase tracking-wide transition-colors disabled:opacity-35 disabled:cursor-not-allowed ${props.className ?? ''}`}
    />
  )
}

export function SuccessButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`bg-hazard-green hover:brightness-110 text-white border-2 border-charcoal rounded-none px-4 py-2.5 font-display font-bold uppercase tracking-wide transition-colors disabled:opacity-35 disabled:cursor-not-allowed ${props.className ?? ''}`}
    />
  )
}

export function ErrorText({ children }: { children: ReactNode }) {
  return (
    <p className="text-sm text-white font-medium bg-hazard-red border-2 border-charcoal rounded-none px-3.5 py-2.5">
      ⚠ {children}
    </p>
  )
}

export function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center justify-between border-2 border-charcoal px-4 py-3">
      <span className="text-sm text-ink font-medium">{label}</span>
      <span
        className={`font-display font-bold uppercase text-sm px-2.5 py-1 border-2 border-charcoal text-white ${
          ok ? 'bg-hazard-green' : 'bg-hazard-red'
        }`}
      >
        {ok ? '통과' : '실패'}
      </span>
    </div>
  )
}

// tx 해시 같은 건 기본 화면에서 숨기고 링크/접기로만 보여준다
export function ChainLink({ txHash, label = '블록체인 기록 보기' }: { txHash: string; label?: string }) {
  if (EXPLORER_URL) {
    return (
      <a
        href={`${EXPLORER_URL}/tx/${txHash}`}
        target="_blank"
        rel="noreferrer"
        className="inline-block text-xs font-semibold text-ink-muted underline underline-offset-2 hover:text-charcoal"
      >
        {label} ↗
      </a>
    )
  }
  return <TechDetails label={label} rows={[['tx', txHash]]} />
}

export function TechDetails({ label = '기술 정보', rows }: { label?: string; rows: [string, string][] }) {
  return (
    <details className="text-xs text-ink-muted">
      <summary className="cursor-pointer font-semibold select-none">{label}</summary>
      <div className="mt-1.5 space-y-1">
        {rows.map(([k, v]) => (
          <p key={k} className="font-mono break-all">
            {k}: {v}
          </p>
        ))}
      </div>
    </details>
  )
}
