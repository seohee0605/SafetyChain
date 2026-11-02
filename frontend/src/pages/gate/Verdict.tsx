import type { ReactNode } from 'react'
import { Bar, PanelButton as ActionButton, shortHex as short, TxDetail } from '../../components/kiosk'
import type { GateResult, OverrideResult, SiteRecord, VerdictKind } from './types'

const hhmm = (sec: number) => new Date(sec * 1000).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })

type Props = {
  kind: VerdictKind
  result: GateResult
  overrideResult: OverrideResult | null
  siteRecord: SiteRecord | null
  workerLabel: string
  elapsedSec: number
  countdown: number | null
  preview: boolean
  onNext: () => void
  onShowOverride: () => void
}

// 출입 판정 화면. 색·문구는 목업(gate-mockup) 그대로, 내용은 체인에 확정된 판정(entryStatus)으로만 정한다 (Gatekeeper)
export function Verdict(props: Props) {
  const { kind, result, overrideResult, siteRecord, workerLabel, elapsedSec, countdown, preview, onNext, onShowOverride } = props

  const ppeFailed = [!result.helmetPass && '안전모', !result.shoesPass && '안전화'].filter(Boolean) as string[]
  // 3단계 판정 반영: 안전모는 '감독자 확인 필요', 안전화는 누가 통과시켰는지(AI/감독자)를 칩에 같이 쓴다
  const helmetLowConf = result.ai?.helmetDecision === 'supervisor' && !result.helmetPass
  const ppeChips: Chip[] = [
    { label: result.helmetPass ? '안전모' : helmetLowConf ? '안전모 감독자 확인 필요' : '안전모', ok: result.helmetPass },
    {
      label: result.shoesPass
        ? result.ai?.shoesPassBy === 'ai' ? '안전화 (AI)' : result.ai ? '안전화 (감독자 확인)' : '안전화'
        : result.ai && result.ai.shoesPassBy !== 'ai' ? '안전화 미확인' : '안전화',
      ok: result.shoesPass,
    },
    { label: result.alcoholPass ? '음주 통과' : '음주', ok: result.alcoholPass },
  ]
  const openHazards = siteRecord?.hazards.filter((h) => !h.completed).map((h) => h.hazard) ?? []
  const nextButton = (
    <ActionButton ghost onClick={onNext}>
      처음 화면으로
    </ActionButton>
  )

  let v: {
    bg: string
    icon: string
    title: string
    sub: string
    chips?: Chip[]
    note?: ReactNode
    actions?: ReactNode
    barTitle: string
    barRight?: string
    dark?: boolean // 노란 배경처럼 글자를 어둡게 써야 하는 경우
  }

  switch (kind) {
    case 'pass':
      v = {
        bg: 'bg-hazard-green',
        icon: '✓',
        title: '들어가세요',
        sub: `${workerLabel} 님, 오늘도 안전하게!`,
        chips: [{ label: '위험성평가', ok: true }, ...ppeChips],
        barTitle: '블록체인에 기록 완료 · 수정·삭제 불가',
      }
      break
    case 'override':
      v = {
        bg: 'bg-safety-yellow',
        dark: true,
        icon: '!',
        title: '감독자 확인 후 통과',
        sub: `사유: ${overrideResult?.reason ?? ''}`,
        chips: [{ label: '위험성평가', ok: true }, ...ppeChips],
        note: "원래 'AI 불합격' 기록은 그대로 남고, 감독자 서명이 붙은 수동 처리 기록이 하나 더 쌓였어요. 감리·발주처가 하루치 기록을 승인할 때 이 건을 따로 검토해요.",
        barTitle: '수동 처리로 기록됨 · 수정·삭제 불가',
      }
      break
    case 'heldNoAssessment':
      v = {
        bg: 'bg-safety-orange',
        icon: '!',
        title: '잠시 기다려 주세요',
        sub: '오늘 위험성평가가 아직 등록되지 않았어요',
        chips: [{ label: '위험성평가', ok: false }, ...ppeChips],
        note: '감독자가 평가를 등록하면 새 QR로 다시 검사해 주세요. 이번 출입 시도도 기록에 남았어요.',
        actions: nextButton,
        barTitle: '출입 보류로 기록됨 · 수정·삭제 불가',
      }
      break
    case 'heldHazards':
      v = {
        bg: 'bg-safety-orange',
        icon: '!',
        title: '잠시 기다려 주세요',
        sub: '위험요인 조치가 아직 끝나지 않았어요',
        chips: [{ label: '위험요인 미조치', ok: false }, ...ppeChips],
        note:
          siteRecord && openHazards.length > 0
            ? `오늘 평가(${hhmm(siteRecord.timestamp)} 제출)의 '${openHazards.join("', '")}' 조치가 아직 끝나지 않았어요. 조치 완료가 다시 제출되면 새 QR로 검사해 주세요.`
            : '조치 완료가 다시 제출되면 새 QR로 검사해 주세요. 이번 출입 시도도 기록에 남았어요.',
        actions: nextButton,
        barTitle: '출입 보류로 기록됨 · 수정·삭제 불가',
      }
      break
    case 'deny':
      v = {
        bg: 'bg-hazard-red',
        icon: '✕',
        title: '들어갈 수 없어요',
        sub: helmetLowConf
          ? 'AI가 안전모 착용을 확신하지 못했어요 (AI 저신뢰). 감독자가 육안으로 확인해 주세요'
          : `${ppeFailed.join('와 ') || '보호구'}가 확인되지 않았어요`,
        chips: [{ label: '위험성평가', ok: true }, ...ppeChips],
        actions: (
          <>
            <ActionButton onClick={onNext}>{ppeFailed.join('·') || '보호구'} 착용하고 다시 검사</ActionButton>
            {result.overridable && !overrideResult && (
              <ActionButton ghost onClick={onShowOverride}>
                {helmetLowConf ? '감독자 육안 확인 (AI 저신뢰)' : '감독자 확인 (AI 오판일 때)'}
              </ActionButton>
            )}
          </>
        ),
        barTitle: '출입 거부로 기록됨 · 수정·삭제 불가',
      }
      break
    case 'alcohol':
      v = {
        bg: 'bg-hazard-red-dark',
        icon: '✕',
        title: '들어갈 수 없어요',
        sub: '음주 측정 기준을 넘었어요',
        chips: [{ label: '위험성평가', ok: true }, ...ppeChips],
        note: (
          <>
            오늘은 작업에 들어갈 수 없어요. 현장 감독자에게 알려 주세요.
            <br />
            음주 판정은 감독자도 수동으로 통과시킬 수 없어요.
          </>
        ),
        actions: nextButton,
        barTitle: '출입 거부로 기록됨 · 수정·삭제 불가',
      }
      break
    case 'review':
      v = {
        bg: 'bg-review-blue',
        icon: '?',
        title: '감독자가 확인할게요',
        sub: '안전화 판정이 애매해요 (AI 확신도 낮음)',
        chips: [
          { label: '위험성평가', ok: true },
          { label: '안전모', ok: true },
          { label: '안전화', ok: null },
          { label: '음주 통과', ok: true },
        ],
        actions: (
          <>
            <ActionButton disabled>감독자: 착용 확인, 통과</ActionButton>
            <ActionButton ghost disabled>
              감독자: 미착용, 차단
            </ActionButton>
          </>
        ),
        note: '감독자의 선택은 사유와 함께 별도로 기록돼요. (3단계 판정은 게이트 로직·컨트랙트 변경 후 동작, 지금은 화면만)',
        barTitle: '감독자 확인 대기로 기록됨 · 수정·삭제 불가',
      }
      break
    case 'late':
      v = {
        bg: 'bg-ink-muted',
        icon: '⧗',
        title: '지연 도착 기록',
        sub: '늦게 전송된 기록이라 출입 근거로 쓰지 않아요',
        chips: ppeChips,
        note: '검사 사실은 감사용으로 남았어요. 새 QR로 다시 검사해 주세요.',
        actions: nextButton,
        barTitle: '지연 기록으로 남음 · 수정·삭제 불가',
      }
      break
    case 'suspect':
      v = {
        bg: 'bg-ink-muted',
        icon: '⚠',
        title: '기록 시각 의심',
        sub: '게이트 기기 시계가 블록체인 시각보다 앞서 있어요',
        chips: ppeChips,
        note: '출입 근거로 쓰지 않고 의심 기록으로 남겼어요. 관리자에게 기기 시계 확인을 요청하세요.',
        actions: nextButton,
        barTitle: '의심 기록으로 남음 · 수정·삭제 불가',
      }
      break
    case 'pending':
    case 'notAnchored':
      v = {
        bg: 'bg-charcoal-light',
        icon: kind === 'pending' ? '…' : '?',
        title: kind === 'pending' ? '확정을 기다리고 있어요' : '기록이 확정되지 않았어요',
        sub:
          kind === 'pending'
            ? '네트워크가 느려 블록체인 기록이 60초 넘게 걸리고 있어요'
            : '블록체인 기록이 확정되지 않아 출입할 수 없어요',
        note:
          kind === 'pending'
            ? '검사는 끝났고 기록은 이미 보냈어요. 게이트가 체인을 자동으로 다시 확인하고, 확정되면 바로 판정을 보여드려요.'
            : '게이트 기록은 감리 감사 저장소에 남았어요. 감독자에게 알려 주세요.',
        chips:
          kind === 'pending'
            ? [
                ...(result.txHash ? [{ label: `전송한 기록 ${short(result.txHash)}`, ok: undefined }] : []),
                { label: `${elapsedSec}초 경과 · 자동 재확인 중`, ok: undefined },
              ]
            : undefined,
        actions: kind === 'notAnchored' ? nextButton : undefined,
        barTitle: '',
      }
      break
  }

  // 동그라미 안 아이콘은 배경과 같은 색으로 (목업과 같게)
  const iconColor: Record<string, string> = {
    'bg-hazard-green': 'text-hazard-green',
    'bg-safety-yellow': 'text-charcoal',
    'bg-safety-orange': 'text-safety-orange',
    'bg-hazard-red': 'text-hazard-red',
    'bg-hazard-red-dark': 'text-hazard-red-dark',
    'bg-review-blue': 'text-review-blue',
    'bg-ink-muted': 'text-ink-muted',
    'bg-charcoal-light': 'text-charcoal-light',
  }
  if (countdown !== null) v.barRight = `${countdown}초 후 처음 화면으로`

  return (
    <div className={`flex-1 flex flex-col min-h-[520px] ${v.bg} ${v.dark ? 'text-charcoal' : 'text-white'}`}>
      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6 text-center">
        <div className={`w-24 h-24 rounded-full bg-white grid place-items-center text-6xl font-black ${iconColor[v.bg]}`}>{v.icon}</div>
        <p className="text-5xl sm:text-6xl font-black leading-tight">{v.title}</p>
        <p className="text-xl sm:text-2xl font-bold">{v.sub}</p>
        {v.chips && (
          <div className="flex flex-wrap justify-center gap-2.5 mt-1.5">
            {v.chips.map((c) => (
              <span
                key={c.label}
                className={`px-3.5 py-2 font-bold text-base sm:text-lg ${c.ok === false || c.ok === null ? 'bg-white text-charcoal' : 'bg-black/20'}`}
              >
                {c.ok === true ? '✓ ' : c.ok === false ? '✕ ' : c.ok === null ? '? ' : ''}
                {c.label}
              </span>
            ))}
          </div>
        )}
        {v.actions && <div className="flex flex-wrap justify-center gap-3 mt-2.5">{v.actions}</div>}
        {v.note && <p className="text-base opacity-90 max-w-2xl">{v.note}</p>}
      </div>
      {kind === 'pending' || kind === 'notAnchored' ? (
        <Bar
          title={result.auditDelivered ? '감리 감사 저장소에는 원본이 이미 도착했어요' : '감리 감사 저장소 전달에 실패했어요'}
          detail={
            <>
              {preview ? '미리보기 · 실제 기록 아님' : `게이트 기록 #${result.deviceSeq}`} · 체인에 끝내 안 올라가면 감리 화면에 '누락'으로 표시돼요
            </>
          }
        />
      ) : (
        <ChainBar
          title={v.barTitle}
          right={v.barRight}
          txHash={overrideResult?.txHash ?? result.txHash}
          deviceSeq={result.deviceSeq}
          auditDelivered={result.auditDelivered}
          preview={preview}
        />
      )}
    </div>
  )
}

// ok: true=통과, false=불합격, null=애매(감독자 확인), undefined=체크 표시 없는 정보 칩
type Chip = { label: string; ok: boolean | null | undefined }

// 판정 아래 검은 띠: 이 판정이 들어간 블록과 기록번호(tx). 블록 정보는 프론트가 체인에 직접 물어본다
function ChainBar(props: { title: string; right?: string; txHash: string | null; deviceSeq: number; auditDelivered: boolean; preview: boolean }) {
  const { title, right, txHash, deviceSeq, auditDelivered, preview } = props
  return (
    <Bar
      title={title}
      right={right}
      detail={
        <TxDetail
          txHash={txHash}
          prefix={preview ? ['미리보기 · 실제 기록 아님'] : []}
          suffix={preview ? [] : [`게이트 기록 #${deviceSeq} · 감리 감사 저장소 ${auditDelivered ? '전달됨' : '전달 실패'}`]}
        />
      }
    />
  )
}
