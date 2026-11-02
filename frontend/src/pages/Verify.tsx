import { useEffect, useState, type ReactNode } from 'react'
import type { Hex } from 'viem'
import { decodeRecordTx, isNonceUsedOnChain, type DecodedRecord } from '../chain'
import { Bar, hhmmss, shortHex, TitleBar, TxDetail, VERIFY_HANDOFF_KEY, Warn } from '../components/kiosk'
import { ErrorText } from '../components/ui'
import { BACKEND_URL, EXPLORER_URL } from '../config'

type VerifyData = {
  onchain: boolean
  sigValid: boolean
  recordMatchesChain: boolean
  evidenceIntact: boolean
  modelHashMatch: boolean
  anchoredAt?: number
  device?: string
  entryStatus?: 'Granted' | 'Denied' | 'HeldNoAssessment' | 'HeldHazardsOpen' | 'LateAuditOnly' | 'SuspectTimestamp'
  entryAllowed?: boolean
  deviceSeq?: number
  overridden?: boolean
  overrideReason?: string | null
  overriddenBy?: string | null
}

type SiteVerify = {
  onchain: boolean
  sigValid: boolean
  contentIntact: boolean
  anchoredAt?: number
  submittedBy: string | null
}

type Mode = 'checkin' | 'site'

const ENTRY_LABEL = {
  Granted: '통과 (Granted)',
  Denied: '차단 (Denied)',
  HeldNoAssessment: '보류 · 위험성평가 전',
  HeldHazardsOpen: '보류 · 위험요인 미조치',
  LateAuditOnly: '지연 기록 (감사용)',
  SuspectTimestamp: '기록 시각 의심 (감사용)',
}

const HEX32 = /^0x[0-9a-fA-F]{64}$/
// 체인 RPC가 느리거나 막혀 있어도 화면이 멈추지 않게 (기록번호 풀기·직접 확인만 해당)
const within = <T,>(p: Promise<T>, ms = 8000): Promise<T | null> => Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))])
const flags = (d: Record<string, unknown>) => `안전모${d.helmetPass ? '✓' : '✕'} 안전화${d.shoesPass ? '✓' : '✕'} 음주${d.alcoholPass ? '✓' : '✕'}`

// 기록 검증: 회사(시공사) 서버의 원본을 블록체인 기록과 대조한다. 목업 verify-mockup
// 기록번호(tx 해시)를 넣으면 트랜잭션을 풀어 검증 코드를 찾고, 검증 코드(nonce)를 넣으면 그대로 조회한다
export default function Verify() {
  const [mode, setMode] = useState<Mode>('checkin')
  const [input, setInput] = useState('')
  const [data, setData] = useState<VerifyData | null>(null)
  const [site, setSite] = useState<SiteVerify | null>(null)
  const [decoded, setDecoded] = useState<DecodedRecord | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)
  const [directOnchain, setDirectOnchain] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  // 다른 화면의 '검증 →' 버튼으로 넘어오면 그 기록번호로 바로 조회한다
  useEffect(() => {
    let handed: string | null = null
    try {
      handed = sessionStorage.getItem(VERIFY_HANDOFF_KEY)
      sessionStorage.removeItem(VERIFY_HANDOFF_KEY)
    } catch {
      /* 무시 */
    }
    if (handed) {
      setInput(handed)
      void check(handed)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function check(override?: string) {
    setError(null)
    setData(null)
    setSite(null)
    setDecoded(null)
    setTxHash(null)
    setDirectOnchain(null)
    const value = (override ?? input).trim()
    if (!HEX32.test(value)) {
      setError(
        value.includes('…') || value.includes('...')
          ? "줄여서 보이는 번호예요. 기록 화면의 '전체 복사' 버튼으로 64자리 번호를 복사해 오거나 '검증 →' 버튼을 눌러 주세요"
          : '0x로 시작하는 64자리 기록번호(또는 검증 코드)를 넣어 주세요',
      )
      return
    }
    setLoading(true)
    try {
      // 1) 기록번호(tx)인지 먼저 본다. 맞으면 어떤 기록인지(게이트/위험성평가)도 거기서 정해진다
      const dec = await within(decodeRecordTx(value as Hex)).catch(() => null)
      const kind: Mode = dec ? dec.kind : mode
      const nonce = dec ? dec.nonce : value
      if (dec) {
        setDecoded(dec)
        setTxHash(value)
        setMode(dec.kind)
      }
      const res = await fetch(`${BACKEND_URL}/verify/${kind === 'site' ? 'site/' : ''}${nonce}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.detail === 'no check-in recorded for this nonce' || body.detail === 'no site record found for this nonce' ? '회사 서버에 이 기록이 없어요' : (body.detail ?? '검증 실패'))
      }
      if (kind === 'site') setSite(await res.json())
      else setData(await res.json())
      // 백엔드 안 거치고 체인에 직접 물어본 값 (백엔드 응답과 같아야 함)
      setDirectOnchain(await within(isNonceUsedOnChain(nonce as `0x${string}`)).catch(() => null))
    } catch (e) {
      setError(e instanceof Error ? e.message : '알 수 없는 오류')
    } finally {
      setLoading(false)
    }
  }

  const chain = decoded?.data ?? {}
  const gateRows: Row[] = data
    ? [
        { title: '등록 기기 서명', sub: '감리가 등록을 승인한 게이트 기기의 서명', ok: data.sigValid, chain: data.device ? `등록 기기 ${shortHex(data.device)}` : undefined },
        {
          title: '판정 일치',
          sub: data.entryStatus ? `${ENTRY_LABEL[data.entryStatus]}${data.overridden ? ' → 수동 처리' : ''}` : '회사 DB 판정 = 체인 기록',
          ok: data.recordMatchesChain,
          chain: decoded && !('checkInNonce' in chain) ? flags(chain) : undefined,
        },
        { title: '사진 원본', sub: '암호화 보관 · 지문만 대조', ok: data.evidenceIntact, chain: chain.evidenceHash ? `evidence ${shortHex(chain.evidenceHash as string)}` : undefined },
        { title: 'AI 모델', sub: '지금 게이트 모델 = 판정 당시 모델', ok: data.modelHashMatch, chain: chain.modelHash ? `modelHash ${shortHex(chain.modelHash as string)}` : undefined },
      ]
    : []
  const siteRows: Row[] = site
    ? [
        { title: '작성자 서명', sub: site.submittedBy ? `${site.submittedBy} (감독자 키)` : '등록 감독자 서명', ok: site.sigValid },
        { title: '내용 지문', sub: '공정·위험요인·조치 내용', ok: site.contentIntact, chain: chain.recordHash ? `recordHash ${shortHex(chain.recordHash as string)}` : undefined },
        ...(decoded ? [{ title: '조치 완료 여부', sub: '체인에는 예/아니오만 기록', ok: true, chain: `hazardsControlled = ${String(chain.hazardsControlled)}`, label: chain.hazardsControlled ? '조치 완료' : '미조치' }] : []),
      ]
    : []
  const rows = data ? gateRows : siteRows
  const onchain = data?.onchain ?? site?.onchain
  const anchoredAt = data?.anchoredAt ?? site?.anchoredAt
  const bad = rows.filter((r) => !r.ok)

  return (
    <div className="space-y-4">
      <TitleBar title="기록 검증" sub="회사에 저장된 원본이 블록체인 기록과 같은지 확인해요" />

      <div className="flex flex-col sm:flex-row gap-2.5">
        <div className="flex border-2 border-charcoal shrink-0">
          {(['checkin', 'site'] as Mode[]).map((m) => (
            <button key={m} onClick={() => setMode(m)} className={`px-4 py-3 font-bold ${mode === m ? 'bg-safety-yellow-dark text-charcoal' : 'bg-white'}`}>
              {m === 'checkin' ? '게이트 검사' : '위험성평가'}
            </button>
          ))}
        </div>
        <input
          className="flex-1 border-[3px] border-charcoal bg-white px-4 py-3 font-mono text-lg outline-none focus:ring-2 focus:ring-safety-yellow"
          placeholder="기록번호 붙여넣기 (0x로 시작)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && check()}
        />
        <button onClick={() => check()} disabled={!input || loading} className="bg-charcoal text-white px-6 py-3 font-black disabled:opacity-35">
          {loading ? '확인 중…' : '검증하기'}
        </button>
      </div>

      {error && <ErrorText>{error}</ErrorText>}

      {!data && !site && !error && <HowTo />}

      {(data || site) && (
        <>
          <div className={`flex items-center gap-5 px-6 py-5 text-white ${!onchain || bad.length ? 'bg-hazard-red' : 'bg-hazard-green'}`}>
            <span className={`w-16 h-16 shrink-0 rounded-full bg-white grid place-items-center text-4xl font-black ${!onchain || bad.length ? 'text-hazard-red' : 'text-hazard-green'}`}>
              {!onchain || bad.length ? '✕' : '✓'}
            </span>
            <div>
              <p className="text-3xl font-black">{!onchain ? '블록체인에 이 기록이 없어요' : bad.length ? '회사 원본이 바뀌었어요' : '원본이 체인 기록과 같아요'}</p>
              <p className="font-bold">
                {!onchain
                  ? '회사 서버에는 있지만 체인에 올라가지 않은 기록이에요. 감리 감사 화면에서 누락으로 보여요'
                  : bad.length
                    ? `${bad.map((r) => r.title).join(', ')} 항목이 체인 기록과 달라요 · 체인에 들어간 뒤 회사 쪽이 수정됐어요`
                    : `${rows.length}개 항목 모두 일치${anchoredAt ? ` · ${hhmmss(anchoredAt)}에 체인에 들어간 뒤 바뀌지 않았어요` : ''}`}
              </p>
            </div>
          </div>

          {onchain && (
            <div className="flex flex-col lg:flex-row gap-4">
              <div className="flex-1 flex flex-col gap-2.5">
                {rows.map((r) => (
                  <CheckRow key={r.title} row={r} />
                ))}
                {bad.length > 0 && (
                  <Warn danger>체인 기록이 기준이에요. 회사 서버의 원본이 체인에 들어간 뒤 바뀌었다는 뜻이에요. 감리 저장소에는 게이트가 보낸 원래 지문이 따로 남아 있어요.</Warn>
                )}
                {directOnchain !== null && (
                  <p className="text-sm text-ink-muted">
                    서버를 거치지 않고 블록체인에 직접 확인: {directOnchain ? '기록 있음' : '기록 없음'} {directOnchain === onchain ? '(서버 응답과 일치 ✓)' : '(서버 응답과 불일치 ⚠)'}
                  </p>
                )}
              </div>
              <div className="lg:w-[340px] flex flex-col gap-3">
                <div className="bg-white border-t-[5px] border-charcoal p-5">
                  <p className="text-xs font-bold text-ink-muted">조회된 기록</p>
                  <p className="text-xl font-black mb-2">
                    {data ? `게이트 출입 판정 · ${data.entryStatus ? ENTRY_LABEL[data.entryStatus].split(' ')[0] : ''}${data.overridden ? ' → 수동 처리' : ''}` : '일일 위험성평가'}
                  </p>
                  {data && (
                    <>
                      {chain.timestamp !== undefined && <KV k="기기 서명 시각" v={`${hhmmss(Number(chain.timestamp))} (기기 시계)`} />}
                      {anchoredAt && <KV k="블록 포함 시각" v={hhmmss(anchoredAt)} />}
                      {chain.workerId !== undefined && <KV k="근로자" v={<><code className="text-sm">{shortHex(chain.workerId as string)}</code><br /><small className="font-medium text-ink-muted">하루용 가명</small></>} />}
                      {data.deviceSeq !== undefined && <KV k="기기 일련번호" v={`#${data.deviceSeq}`} />}
                      <KV k="출입 근거" v={data.entryAllowed ? '인정' : '아님'} />
                      {data.overridden && <KV k="수동 처리" v={`${data.overrideReason} · ${data.overriddenBy}`} />}
                    </>
                  )}
                  {site && (
                    <>
                      {site.submittedBy && <KV k="작성자" v={site.submittedBy} />}
                      {anchoredAt && <KV k="블록 포함 시각" v={hhmmss(anchoredAt)} />}
                      <KV k="원문 위치" v="회사 서버 (비공개)" />
                    </>
                  )}
                </div>
                <div className="bg-charcoal text-white p-4 text-sm">
                  {data ? (
                    <>
                      <p className="font-bold">⚿ 실명·사진은 여기 나오지 않아요</p>
                      가명과 실명 매핑, 암호화된 사진 열람은 사고 조사 권한자만 할 수 있어요.
                    </>
                  ) : (
                    <>
                      <p className="font-bold">체인에는 지문만 있어요</p>
                      원문은 회사 서버에 있고, 이 화면은 원문에서 다시 계산한 지문을 체인과 대조해요.
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {txHash && (
            <Bar
              title={
                <>
                  트랜잭션 <code>{shortHex(txHash)}</code>
                  {decoded?.kind === 'checkin' && decoded.viaOverride && <span className="ml-2 text-safety-yellow">(수동 처리 기록 → 원래 검사 기록을 검증)</span>}
                </>
              }
              detail={<TxDetail txHash={null} prefix={[`블록 #${decoded?.blockNumber.toLocaleString() ?? ''}`, ...(anchoredAt ? [`블록 포함 시각 ${new Date(anchoredAt * 1000).toLocaleString('ko-KR', { hour12: false })}`] : [])]} />}
              right={
                EXPLORER_URL && (
                  <a href={`${EXPLORER_URL}/tx/${txHash}`} target="_blank" rel="noreferrer" className="bg-safety-yellow text-charcoal px-4 py-2.5 font-black">
                    Etherscan에서 열기 ↗
                  </a>
                )
              }
            />
          )}
        </>
      )}
    </div>
  )
}

type Row = { title: string; sub: string; ok: boolean; chain?: string; label?: string }

function CheckRow({ row }: { row: Row }) {
  return (
    <div className={`bg-white border-l-[5px] px-5 py-4 flex items-center gap-4 ${row.ok ? 'border-hazard-green' : 'border-hazard-red bg-hazard-red/5'}`}>
      <span className={`w-9 h-9 shrink-0 rounded-full grid place-items-center text-white font-black ${row.ok ? 'bg-hazard-green' : 'bg-hazard-red'}`}>{row.ok ? '✓' : '✕'}</span>
      <div className="w-48 shrink-0">
        <p className="text-lg font-black">{row.title}</p>
        <p className="text-sm text-ink-muted">{row.sub}</p>
      </div>
      {row.chain && (
        <p className="flex-1 text-sm font-mono">
          <span className="font-sans text-ink-muted mr-3">체인 기록</span>
          {row.chain}
        </p>
      )}
      <span className={`ml-auto shrink-0 font-black ${row.ok ? 'text-hazard-green' : 'text-hazard-red'}`}>{row.label ?? (row.ok ? '일치' : '불일치')}</span>
    </div>
  )
}

function KV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 py-2 border-b border-charcoal/10 last:border-0">
      <span className="text-ink-muted">{k}</span>
      <b className="text-right">{v}</b>
    </div>
  )
}

// 처음 화면: 어디서 기록번호를 찾는지, 무엇을 대조하는지
function HowTo() {
  const steps = [
    ['등록 기기 서명', '감리가 등록을 승인한 게이트 기기가 직접 서명한 기록인가'],
    ['판정 일치', '회사 DB의 판정이 체인 기록과 같은가'],
    ['사진 원본', '암호화 보관된 사진의 지문이 촬영 당시와 같은가'],
    ['AI 모델', '판정에 쓴 모델 파일이 체인에 기록된 것과 같은가'],
  ]
  return (
    <div className="flex flex-col lg:flex-row gap-6 pt-2">
      <div className="flex-1 flex flex-col gap-3">
        <h2 className="text-4xl font-black leading-snug">
          기록번호를 넣으면
          <br />
          <span className="bg-safety-yellow px-1.5">4가지</span>를 대조해요
        </h2>
        <p className="text-ink-muted leading-relaxed">
          기록번호는 게이트 <b>출입 판정</b> 화면 아래쪽, 위험성평가 제출 완료 화면에 있어요. 예전 '검증 코드'를 넣어도 돼요.
        </p>
        <div className="flex flex-wrap gap-2">
          {['사고 조사관', '감리', '발주처', '근로자 본인'].map((w) => (
            <span key={w} className="bg-white border-2 border-charcoal/20 px-3 py-1.5 font-bold text-sm">
              {w}
            </span>
          ))}
        </div>
        <div className="flex-1" />
        <Bar title="블록체인에 기록 완료 · 수정·삭제 불가" detail={<>블록 포함 시각 08:43:14 · 기록번호 <span className="bg-safety-yellow text-charcoal px-1 font-mono">0x7a3f…e21c</span></>} />
        <p className="text-sm font-bold">↑ 게이트 출입 판정 화면의 이 부분을 복사하세요</p>
      </div>
      <div className="lg:w-[460px] flex flex-col gap-2.5">
        {steps.map(([t, s], i) => (
          <div key={t} className="bg-white px-5 py-4 flex gap-4 items-center">
            <span className="w-9 h-9 shrink-0 grid place-items-center bg-charcoal text-safety-yellow font-black">{i + 1}</span>
            <div>
              <p className="font-black">{t}</p>
              <p className="text-sm text-ink-muted">{s}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
