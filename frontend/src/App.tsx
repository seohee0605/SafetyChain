import { useState } from 'react'
import CaseReview from './pages/CaseReview'
import Dashboard from './pages/Dashboard'
import Gate from './pages/Gate'
import SiteRecord from './pages/SiteRecord'
import Verify from './pages/Verify'

const PAGES = {
  gate: { label: '게이트', component: Gate },
  siteRecord: { label: '위험성평가', component: SiteRecord },
  caseReview: { label: '케이스 검토', component: CaseReview },
  dashboard: { label: '대시보드', component: Dashboard },
  verify: { label: '검증', component: Verify },
} as const

type PageKey = keyof typeof PAGES

function App() {
  const [page, setPage] = useState<PageKey>('gate')
  const Page = PAGES[page].component

  return (
    <div className="min-h-screen bg-paper">
      <div className="h-1.5 hazard-stripes" />
      <header className="bg-charcoal text-white">
        <div className="max-w-3xl mx-auto px-6 pt-5 pb-4">
          <p className="font-display text-2xl font-extrabold uppercase tracking-wider leading-none">
            Safety<span className="text-safety-yellow">Chain</span>
          </p>
          <p className="text-sm text-white/60 mt-1.5">현장 안전 검사 결과를 위변조 불가능하게 기록합니다</p>
        </div>
        <nav className="max-w-3xl mx-auto px-6 flex gap-1">
          {(Object.keys(PAGES) as PageKey[]).map((key) => (
            <button
              key={key}
              onClick={() => setPage(key)}
              className={`px-4 py-2.5 text-sm font-display font-bold uppercase tracking-wide border-t-4 transition-colors ${
                page === key
                  ? 'bg-paper text-charcoal border-safety-yellow'
                  : 'text-white/50 border-transparent hover:text-white hover:bg-white/5'
              }`}
            >
              {PAGES[key].label}
            </button>
          ))}
        </nav>
      </header>
      <main className="max-w-3xl mx-auto px-6 py-8">
        <Page />
      </main>
    </div>
  )
}

export default App
