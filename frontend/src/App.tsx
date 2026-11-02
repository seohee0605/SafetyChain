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

  // 목업처럼 한 줄 헤더: 로고 · 메뉴 · 시계. 모든 화면이 1280px 기준 2단 배치라 넓게 쓴다
  return (
    <div className="min-h-screen bg-paper">
      <div className="h-2 hazard-stripes" />
      <header className="bg-charcoal text-white">
        <div className="max-w-6xl mx-auto px-6 flex items-end gap-6 sm:gap-10 min-h-16 overflow-x-auto">
          <p className="self-center shrink-0 font-display text-2xl font-extrabold uppercase tracking-wider leading-none">
            Safety<span className="text-safety-yellow">Chain</span>
          </p>
          <nav className="flex">
            {(Object.keys(PAGES) as PageKey[]).map((key) => (
              <button
                key={key}
                onClick={() => setPage(key)}
                className={`shrink-0 h-13 px-4 text-[15px] font-bold transition-colors ${
                  page === key ? 'bg-paper text-charcoal border-t-4 border-safety-yellow' : 'text-white/70 hover:text-white'
                }`}
              >
                {PAGES[key].label}
              </button>
            ))}
          </nav>
          <Clock />
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-6 py-6">
        <Page />
      </main>
    </div>
  )
}

function Clock() {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000)
    return () => clearInterval(t)
  }, [])
  return (
    <span className="ml-auto self-center shrink-0 pl-4 border-l border-white/20 text-xl font-black">
      {new Date(now).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })}
    </span>
  )
}

export default App
