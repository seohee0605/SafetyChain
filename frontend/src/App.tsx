import { useEffect, useState } from 'react'
import Audit from './pages/Audit'
import CaseReview from './pages/CaseReview'
import Dashboard from './pages/Dashboard'
import Gate from './pages/Gate'
import SiteRecord from './pages/SiteRecord'
import Verify from './pages/Verify'
import Worker from './pages/Worker'

const PAGES = {
  gate: { label: '게이트', component: Gate },
  siteRecord: { label: '위험성평가', component: SiteRecord },
  caseReview: { label: '케이스 검토', component: CaseReview },
  dashboard: { label: '대시보드', component: Dashboard },
  audit: { label: '감리 감사', component: Audit },
  verify: { label: '검증', component: Verify },
  worker: { label: '근로자 앱', component: Worker },
} as const

type PageKey = keyof typeof PAGES

// #/gate, #/worker ... 주소로 화면을 고른다 (근로자 앱은 폰에서 #/worker 로 바로 연다)
function pageFromHash(): PageKey {
  const key = window.location.hash.replace(/^#\/?/, '')
  return key in PAGES ? (key as PageKey) : 'gate'
}

function App() {
  const [page, setPageState] = useState<PageKey>(pageFromHash)
  const Page = PAGES[page].component

  useEffect(() => {
    const onHash = () => setPageState(pageFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const setPage = (key: PageKey) => {
    window.location.hash = `/${key}`
  }

  // 근로자 앱은 폰 화면이라 관리용 헤더 없이 단독으로 띄운다
  if (page === 'worker') return <Worker />

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
        <nav className="max-w-3xl mx-auto px-6 flex gap-1 overflow-x-auto">
          {(Object.keys(PAGES) as PageKey[]).map((key) => (
            <button
              key={key}
              onClick={() => setPage(key)}
              className={`shrink-0 px-4 py-2.5 text-sm font-display font-bold uppercase tracking-wide border-t-4 transition-colors ${
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
