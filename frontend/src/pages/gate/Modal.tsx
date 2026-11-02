import type { ReactNode } from 'react'

// 감독자 수동 처리·예외 출입처럼 근로자 화면 위에 잠깐 띄우는 창
export function Modal({ caption, title, onClose, children }: { caption: string; title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 bg-charcoal/60 grid place-items-center p-4" onClick={onClose}>
      <div
        className="bg-white text-charcoal w-full max-w-xl border-t-8 border-charcoal p-6 sm:p-7 space-y-3 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-xs font-bold text-ink-muted">{caption}</p>
        <h2 className="text-2xl font-extrabold leading-snug">{title}</h2>
        {children}
      </div>
    </div>
  )
}

// 사유 고르기: 동그라미 선택지 목록
export function OptionList<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; note?: string }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="space-y-2.5">
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={String(o.value)}
            type="button"
            onClick={() => onChange(o.value)}
            className={`w-full flex items-center gap-3 border-2 px-4 py-3 text-left font-bold ${
              on ? 'border-charcoal bg-safety-yellow/15' : 'border-charcoal/20'
            }`}
          >
            <span
              className={`w-5 h-5 rounded-full border-2 border-charcoal shrink-0 ${on ? 'bg-charcoal shadow-[inset_0_0_0_3px_white]' : ''}`}
            />
            {o.label}
            {o.note && <span className="ml-auto text-sm font-medium text-ink-muted">{o.note}</span>}
          </button>
        )
      })}
    </div>
  )
}

export function ModalButtons({ children }: { children: ReactNode }) {
  return <div className="flex gap-2.5 pt-2 [&>button]:flex-1">{children}</div>
}
