export type QrIssue = { nonce: string; expiresAt: number }
export type EntryStatus = 'Granted' | 'Denied' | 'HeldNoAssessment' | 'HeldHazardsOpen' | 'LateAuditOnly' | 'SuspectTimestamp'
export type GateResult = {
  anchored: boolean
  pending?: boolean // 트랜잭션은 보냈지만 릴레이 대기 시간(60초) 안에 블록에 안 들어감
  txHash: string | null
  verdict: boolean
  nonce: string
  helmetPass: boolean
  shoesPass: boolean
  alcoholPass: boolean
  overridable: boolean
  entryStatus: EntryStatus | null
  entryAllowed: boolean
  deviceSeq: number
  auditDelivered: boolean
  // 게이트 AI 판정 정보. 안전모·안전화 모두 3단계 (안전화는 지금 정책상 전부 감독자 확인)
  ai?: {
    helmetDecision: Decision
    helmetScore: number
    shoesDecision: Decision
    shoesScoreAI: number | null
    shoesOpinion: ShoesOpinion | null
    person: boolean
    shoesPassBy: 'ai' | 'supervisor'
  }
}
export type Decision = 'pass' | 'supervisor' | 'deny'
export type ShoesOpinion = 'looks_work' | 'not_work_like'
// 촬영 직후 게이트 /preview 결과 (서명·기록 없음, 감독자 참고용)
export type AiPreview = {
  person: boolean
  helmetDecision: Decision
  helmetScore: number
  shoesDecision: Decision
  shoesScoreAI: number | null
  shoesOpinion: ShoesOpinion | null
}
export type Reason = { code: number; label: string }
export type Admin = { name: string; address: string }
export type OverrideResult = { txHash: string; reason: string }
export type EmergencyResult = { reason: string; pending: boolean }
export type Stage = 'inspecting' | 'signing' | 'auditing' | 'anchoring' | 'confirmed' | 'not_anchored'

// 오늘 위험성평가 (백엔드 /site/records 한 줄)
export type SiteRecord = {
  caseId: string
  hazardsControlled: boolean
  hazards: { hazard: string; controlMeasure?: string; completed?: boolean }[]
  adminName: string
  timestamp: number
}

// 판정 화면 종류. 'review'(감독자 확인 대기)는 아직 게이트 로직·컨트랙트에 없어서 시연 도구의 미리보기에서만 나온다
export type VerdictKind =
  | 'pass'
  | 'override'
  | 'heldNoAssessment'
  | 'heldHazards'
  | 'deny'
  | 'alcohol'
  | 'review'
  | 'late'
  | 'suspect'
  | 'pending'
  | 'notAnchored'

export function verdictOf(result: GateResult, overrideResult: OverrideResult | null): VerdictKind {
  if (!result.anchored) return result.pending ? 'pending' : 'notAnchored'
  if (overrideResult) return 'override'
  switch (result.entryStatus) {
    case 'Granted':
      return 'pass'
    case 'HeldNoAssessment':
      return 'heldNoAssessment'
    case 'HeldHazardsOpen':
      return 'heldHazards'
    case 'LateAuditOnly':
      return 'late'
    case 'SuspectTimestamp':
      return 'suspect'
    default:
      return result.alcoholPass ? 'deny' : 'alcohol'
  }
}
