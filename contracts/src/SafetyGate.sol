// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @title SafetyGate
/// @notice 출입 검사·위험성평가·감리/발주처 승인 기록 앵커링.
/// 서명은 각 주체가 EIP-712로, 가스는 릴레이(백엔드)가 낸다.
contract SafetyGate is AccessControl, EIP712 {
    using ECDSA for bytes32;

    // ------------------------------------------------------------------
    // 역할
    // ------------------------------------------------------------------

    /// @notice 시공사 운영 관리자: 서명자 등록을 '제안'하고 해제할 수 있다. 단독으로 등록을 완료할 수는 없다.
    bytes32 public constant CONTRACTOR_ADMIN_ROLE = keccak256("CONTRACTOR_ADMIN_ROLE");
    /// @notice 감리: 서명자 등록 승인, case 1차 승인/반려.
    bytes32 public constant INSPECTOR_ROLE = keccak256("INSPECTOR_ROLE");
    /// @notice 발주처: 서명자 등록 승인, case 최종 승인/반려.
    bytes32 public constant OWNER_ROLE = keccak256("OWNER_ROLE");
    /// @notice 게이트 기기: 근로자 출입 검사(CheckIn)만 서명할 수 있다.
    bytes32 public constant GATE_DEVICE_ROLE = keccak256("GATE_DEVICE_ROLE");
    /// @notice 시공사 현장 감독자(안전관리자): 위험성평가, Manual Override, case 제출을 서명한다.
    bytes32 public constant SUPERVISOR_ROLE = keccak256("SUPERVISOR_ROLE");

    // ------------------------------------------------------------------
    // 정책 상수
    // ------------------------------------------------------------------

    /// @notice 출입 검사: 서명 후 이 시간 안에 체인에 들어오면 정상(출입 근거로 인정).
    uint64 public constant CHECKIN_ON_TIME = 10 minutes;
    /// @notice 출입 검사: 이 시간까지는 '지연 도착'으로 저장(감사용, 출입 근거 X), 넘으면 명백한 소급으로 거부.
    uint64 public constant CHECKIN_LATE_LIMIT = 24 hours;
    /// @notice 위험성평가·Override·Case 승인: 서명 시점에 서명하고 이 시간 안에 제출해야 한다. 지연 단계 없음.
    uint64 public constant RECORD_WINDOW = 1 hours;
    /// @notice 기기 시계 오차 허용치. 서명 시각이 블록 시각보다 이만큼 이상 미래면 정상으로 보지 않는다.
    uint64 public constant MAX_CLOCK_SKEW = 1 minutes;
    /// @notice 출입 검사: 1분 넘게 미래지만 이 시간 안이면 '의심(기기 시계 이상)'으로 저장, 넘으면 거부.
    uint64 public constant CHECKIN_SUSPECT_FUTURE = 10 minutes;
    /// @notice 일회용 QR의 최대 유효기간. 발급~만료가 이보다 길면 일회용 출입 권한으로 보지 않는다.
    uint64 public constant MAX_QR_TTL = 10 minutes;
    /// @notice '해당 날짜' 판정 기준 시간대 (KST = UTC+9). 위험성평가는 출입과 같은 KST 날짜에 체인에 올라와야 유효하다.
    uint64 public constant DAY_OFFSET = 9 hours;

    /// @notice 서명자 해제 사유 코드.
    uint8 public constant REVOKE_KEY_COMPROMISED = 1; // 키 유출 의심
    uint8 public constant REVOKE_DEVICE_REPLACED = 2; // 기기 고장·교체
    uint8 public constant REVOKE_SITE_CLOSED = 3; // 현장 철수
    uint8 public constant REVOKE_REASON_MAX = 3;

    /// @notice 긴급·장비 장애 예외 출입 사유 코드.
    uint8 public constant EMERGENCY_GATE_FAULT = 1; // 게이트 장비 장애
    uint8 public constant EMERGENCY_RESCUE = 2; // 응급·구조 대응
    uint8 public constant EMERGENCY_POWER_NETWORK = 3; // 정전·통신 장애
    uint8 public constant EMERGENCY_REASON_MAX = 3;

    /// @notice Override 사유 코드 (온체인에는 코드만, 자유 텍스트는 올리지 않는다).
    uint8 public constant OVERRIDE_FALSE_POSITIVE = 1; // AI 오탐 (육안 확인 결과 착용)
    uint8 public constant OVERRIDE_CAMERA_FAULT = 2; // 카메라·조명 문제로 판정 불가
    uint8 public constant OVERRIDE_REINSPECTED = 3; // 현장에서 보호구 재착용 후 재확인
    uint8 public constant OVERRIDE_REASON_MAX = 3;

    /// @notice Case 행위 코드.
    uint8 public constant ACTION_SUBMIT = 1; // 시공사 감독자 제출
    uint8 public constant ACTION_APPROVE = 2; // 감리 또는 발주처 승인
    uint8 public constant ACTION_REJECT = 3; // 감리 또는 발주처 반려 (사유 코드 필수)
    uint8 public constant REJECT_REASON_MAX = 5;

    // ------------------------------------------------------------------
    // EIP-712 타입
    // ------------------------------------------------------------------

    bytes32 private constant CHECKIN_TYPEHASH = keccak256(
        "CheckIn(bytes32 caseId,bytes32 workerId,bytes32 siteId,bool helmetPass,bool shoesPass,bool alcoholPass,bytes32 modelHash,bytes32 evidenceHash,bytes32 nonce,uint64 qrIssuedAt,uint64 qrExpiresAt,uint64 deviceSeq,uint64 timestamp)"
    );
    bytes32 private constant SITE_RECORD_TYPEHASH = keccak256(
        "SiteRecord(bytes32 caseId,bytes32 siteId,bytes32 recordHash,bool hazardsControlled,bytes32 nonce,uint64 timestamp)"
    );
    bytes32 private constant OVERRIDE_TYPEHASH =
        keccak256("Override(bytes32 checkInNonce,uint8 reasonCode,bytes32 nonce,uint64 timestamp)");
    bytes32 private constant EMERGENCY_TYPEHASH = keccak256(
        "EmergencyEntry(bytes32 caseId,bytes32 siteId,bytes32 workerId,uint8 reasonCode,bytes32 nonce,uint64 timestamp)"
    );
    bytes32 private constant CASE_ACTION_TYPEHASH = keccak256(
        "CaseAction(bytes32 caseId,bytes32 scopeHash,uint8 action,uint8 reasonCode,bytes32 nonce,uint64 timestamp)"
    );
    bytes32 private constant SIGNER_APPROVAL_TYPEHASH =
        keccak256("SignerApproval(uint256 proposalId,bytes32 role,address account)");

    // ------------------------------------------------------------------
    // 서명 대상 구조체
    // ------------------------------------------------------------------

    struct CheckIn {
        bytes32 caseId; // keccak256(siteId || workDate): 현장·작업일 단위 묶음
        bytes32 workerId; // 가명 식별자 (실명 아님)
        bytes32 siteId;
        bool helmetPass;
        bool shoesPass;
        bool alcoholPass; // 통과 여부만. 측정 수치는 어디에도 올리지 않는다
        bytes32 modelHash; // 판정에 쓴 AI 모델 가중치 해시
        bytes32 evidenceHash; // 검사 사진 원본의 해시 (원본은 오프체인)
        bytes32 nonce; // 일회용 QR nonce
        uint64 qrIssuedAt; // QR 발급 시각 (서명 시각의 하한: 이 시점 이후에 검사됨)
        uint64 qrExpiresAt; // QR 만료 시각 (서명 시각의 상한)
        uint64 deviceSeq; // 기기별 일련번호 (1부터 1씩 증가). 빠진 번호 = 제출되지 않은 기록
        uint64 timestamp; // 기기가 서명한 시각 (블록 시각과 비교해 분류)
    }

    struct SiteRecord {
        bytes32 caseId;
        bytes32 siteId;
        bytes32 recordHash; // 오프체인 위험성평가 원문의 해시
        bool hazardsControlled; // 중점관리대상 위험요인 조치 완료 여부
        bytes32 nonce;
        uint64 timestamp;
    }

    struct Override {
        bytes32 checkInNonce; // 수동 처리할 검사 기록
        uint8 reasonCode; // OVERRIDE_* 코드
        bytes32 nonce;
        uint64 timestamp;
    }

    /// @notice 긴급·장비 장애 예외 출입. 감독자 서명 + 감리 또는 발주처 서명이 둘 다 있어야 한다.
    struct EmergencyEntry {
        bytes32 caseId;
        bytes32 siteId;
        bytes32 workerId; // 가명 식별자
        uint8 reasonCode; // EMERGENCY_* 코드
        bytes32 nonce;
        uint64 timestamp;
    }

    struct CaseAction {
        bytes32 caseId;
        bytes32 scopeHash; // 검토 대상 기록(nonce 목록)의 해시. 제출한 범위 그대로 승인해야 한다
        uint8 action; // ACTION_* 코드
        uint8 reasonCode; // 반려일 때만 0이 아니어야 함
        bytes32 nonce;
        uint64 timestamp;
    }

    // ------------------------------------------------------------------
    // 저장 구조체
    // ------------------------------------------------------------------

    /// @notice 출입 검사 기록의 출입 판정. 우선순위: 의심·지연 > 평가 없음 > 위험요인 미조치 > 불합격 > 허가.
    enum EntryStatus {
        Granted, // 당일 위험성평가 완료 + 보호구·음주 합격 + 제시간 제출
        Denied, // 보호구 또는 음주 불합격 (보호구는 감독자 Override 가능)
        HeldNoAssessment, // 당일 이 현장의 위험성평가가 체인에 없음 → 출입 보류, 시도 사실은 남김
        LateAuditOnly, // 늦게 도착한 기록 → 검사 사실은 남기되 출입 근거로 쓰지 않음
        HeldHazardsOpen, // 당일 평가는 있지만 위험요인이 미조치 → 출입 보류
        SuspectTimestamp // 기기 시계가 블록 시각보다 1~10분 앞섬 → 의심 표시와 함께 저장, 출입 근거 X
    }

    struct StoredCheckIn {
        CheckIn data;
        address device; // 서명한 게이트 기기
        EntryStatus status;
        uint64 anchoredAt; // 블록 시각 = 화면에 보여줄 "기록 시각"
        bool overridden;
        uint8 overrideReason;
        address overriddenBy;
        uint64 overriddenAt;
    }

    struct StoredSiteRecord {
        SiteRecord data;
        address supervisor;
        uint64 anchoredAt;
    }

    struct SiteStats {
        uint64 checkIns; // 전체 검사 건수 (지연·보류 포함)
        uint64 failed; // AI·음주 불합격 건수
        uint64 overrides; // 감독자 수동 처리 건수
        uint64 held; // 위험성평가 전 출입 시도(보류) 건수
        uint64 late; // 지연 도착(감사용) 건수
        uint64 suspect; // 기기 시계 이상 의심 건수
        uint64 emergencies; // 긴급·장비 장애 예외 출입 건수
    }

    struct StoredEmergency {
        EmergencyEntry data;
        address supervisor;
        address approver; // 감리 또는 발주처
        uint64 anchoredAt;
    }

    /// @notice 현장·작업일(caseId)별 최신 위험성평가 상태.
    struct Assessment {
        bytes32 siteId;
        bool hazardsControlled;
        bytes32 recordNonce;
        uint64 anchoredAt;
    }

    /// @notice 게이트 기기별 일련번호 집계. 누락 = highestSeq - received.
    struct DeviceStats {
        uint64 highestSeq;
        uint64 received;
    }

    /// @notice 서명자 해제 이력 (감리가 확인).
    struct Revocation {
        bytes32 role;
        address account;
        uint8 reasonCode;
        address revokedBy;
        uint64 revokedAt;
        uint64 lastSeq; // 해제 직전까지 받은 최대 일련번호 (기기일 때)
        uint64 missingAtRevoke; // 해제 시점 누락 건수
    }

    enum CaseStatus {
        None,
        Submitted, // 시공사 제출, 감리 대기
        InspectorApproved, // 감리 승인, 발주처 대기
        Finalized, // 발주처 승인 = 최종 확정
        Rejected // 감리 또는 발주처 반려 → 재제출 가능
    }

    struct CaseState {
        CaseStatus status;
        bytes32 scopeHash;
        uint32 round; // 제출 횟수 (재제출마다 +1)
    }

    struct CaseHistoryEntry {
        uint8 action;
        uint8 reasonCode;
        bytes32 scopeHash;
        address actor;
        bytes32 actorRole;
        bytes32 nonce;
        uint64 anchoredAt;
    }

    struct SignerProposal {
        bytes32 role;
        address account;
        address proposer;
        bool executed;
        address approvedBy;
    }

    // ------------------------------------------------------------------
    // 상태
    // ------------------------------------------------------------------

    mapping(bytes32 nonce => bool used) private _usedNonces;

    mapping(bytes32 nonce => StoredCheckIn) private _checkIns;
    mapping(bytes32 siteId => bytes32[] nonces) private _checkInNoncesBySite;
    mapping(bytes32 siteId => SiteStats) private _siteStats;

    mapping(bytes32 nonce => StoredSiteRecord) private _siteRecords;
    mapping(bytes32 siteId => bytes32[] nonces) private _siteRecordNoncesBySite;

    mapping(bytes32 caseId => CaseState) private _cases;
    mapping(bytes32 caseId => CaseHistoryEntry[]) private _caseHistory;

    SignerProposal[] private _proposals;

    mapping(bytes32 caseId => Assessment) private _assessments;
    mapping(address device => DeviceStats) private _deviceStats;
    mapping(address device => mapping(uint64 seq => bool)) private _seqUsed;
    Revocation[] private _revocations;
    mapping(bytes32 nonce => StoredEmergency) private _emergencies;
    mapping(bytes32 siteId => bytes32[] nonces) private _emergencyNoncesBySite;

    // ------------------------------------------------------------------
    // 이벤트 / 에러
    // ------------------------------------------------------------------

    event CheckInRecorded(
        bytes32 indexed siteId,
        bytes32 indexed workerId,
        bytes32 nonce,
        bool allPassed,
        EntryStatus status,
        address device,
        uint64 deviceSeq
    );
    event EmergencyEntryRecorded(
        bytes32 indexed siteId, bytes32 nonce, uint8 reasonCode, address supervisor, address approver
    );
    event SequenceGap(address indexed device, uint64 fromSeq, uint64 toSeq);
    event SignerRevoked(
        bytes32 indexed role, address indexed account, uint8 reasonCode, address revokedBy, uint64 lastSeq
    );
    event OverrideRecorded(bytes32 indexed siteId, bytes32 indexed checkInNonce, uint8 reasonCode, address supervisor);
    event SiteRecordSubmitted(bytes32 indexed siteId, bytes32 nonce, bool hazardsControlled, address supervisor);
    event CaseActionRecorded(
        bytes32 indexed caseId, uint8 action, uint8 reasonCode, CaseStatus newStatus, address actor
    );
    event SignerProposed(uint256 indexed proposalId, bytes32 indexed role, address indexed account, address proposer);
    event SignerApproved(uint256 indexed proposalId, bytes32 indexed role, address indexed account, address approver);

    error NonceAlreadyUsed(bytes32 nonce);
    error MissingRole(address signer, bytes32 role);
    error StaleTimestamp(uint64 signedAt, uint64 blockTime);
    error CheckInNotFound(bytes32 nonce);
    error CheckInNotFailed(bytes32 nonce);
    error AlcoholFailCannotBeOverridden(bytes32 nonce);
    error AlreadyOverridden(bytes32 nonce);
    error InvalidReason(uint8 reasonCode);
    error InvalidCaseTransition(CaseStatus status, uint8 action);
    error ScopeMismatch(bytes32 expected, bytes32 given);
    error RoleNotAssignable(bytes32 role);
    error ProposalNotFound(uint256 proposalId);
    error ProposalAlreadyExecuted(uint256 proposalId);
    error EmptyScope();
    error InvalidSequence(uint64 seq);
    error DuplicateSequence(address device, uint64 seq);
    error SignerNotActive(bytes32 role, address account);
    error CheckInNotOverridable(bytes32 nonce, EntryStatus status);
    error InvalidQrWindow(uint64 issuedAt, uint64 expiresAt);
    error QrNotValidAtSigning(uint64 issuedAt, uint64 expiresAt, uint64 signedAt);

    /// @param contractorAdmin 시공사 운영 관리자 (보통 배포·릴레이 계정)
    /// @param inspector 감리 서명 주소
    /// @param owner 발주처 서명 주소
    /// @dev DEFAULT_ADMIN_ROLE은 아무에게도 주지 않는다. 그래서 grantRole로 역할을 임의로 줄 수 없고,
    ///      서명자 등록은 proposeSigner → approveSigner 경로로만 가능하다.
    constructor(address contractorAdmin, address inspector, address owner) EIP712("SafetyChain", "1") {
        _grantRole(CONTRACTOR_ADMIN_ROLE, contractorAdmin);
        _grantRole(INSPECTOR_ROLE, inspector);
        _grantRole(OWNER_ROLE, owner);
    }

    // ==================================================================
    // 서명자 등록 (시공사 제안 + 감리·발주처 승인)
    // ==================================================================

    /// @notice 게이트 기기 또는 감독자 서명자 등록을 제안한다. 승인 전까지는 아무 권한도 없다.
    function proposeSigner(bytes32 role, address account)
        external
        onlyRole(CONTRACTOR_ADMIN_ROLE)
        returns (uint256 proposalId)
    {
        if (role != GATE_DEVICE_ROLE && role != SUPERVISOR_ROLE) {
            revert RoleNotAssignable(role);
        }
        proposalId = _proposals.length;
        _proposals.push(
            SignerProposal({
                role: role, account: account, proposer: msg.sender, executed: false, approvedBy: address(0)
            })
        );
        emit SignerProposed(proposalId, role, account, msg.sender);
    }

    /// @notice 감리 또는 발주처가 서명한 승인으로 등록을 완료한다. 누가 제출하든 서명자가 기준이다.
    function approveSigner(uint256 proposalId, bytes calldata sig) external {
        if (proposalId >= _proposals.length) revert ProposalNotFound(proposalId);
        SignerProposal storage p = _proposals[proposalId];
        if (p.executed) revert ProposalAlreadyExecuted(proposalId);

        address approver = _hashTypedDataV4(_signerApprovalStructHash(proposalId)).recover(sig);
        if (!hasRole(INSPECTOR_ROLE, approver) && !hasRole(OWNER_ROLE, approver)) {
            revert MissingRole(approver, INSPECTOR_ROLE);
        }

        p.executed = true;
        p.approvedBy = approver;
        _grantRole(p.role, p.account);
        emit SignerApproved(proposalId, p.role, p.account, approver);
    }

    /// @notice 키 유출 등 비상 시 시공사 관리자가 서명자를 즉시 해제한다.
    /// 해제는 권한을 줄이는 방향이라 승인 없이 허용하되, 사유 코드와 해제 시점의 일련번호를
    /// 이력으로 남겨 감리가 "왜, 언제, 몇 번까지 받고 해제했는지" 확인할 수 있게 한다.
    function revokeSigner(bytes32 role, address account, uint8 reasonCode) external onlyRole(CONTRACTOR_ADMIN_ROLE) {
        if (role != GATE_DEVICE_ROLE && role != SUPERVISOR_ROLE) revert RoleNotAssignable(role);
        if (reasonCode == 0 || reasonCode > REVOKE_REASON_MAX) revert InvalidReason(reasonCode);
        if (!hasRole(role, account)) revert SignerNotActive(role, account);

        DeviceStats storage d = _deviceStats[account];
        _revocations.push(
            Revocation({
                role: role,
                account: account,
                reasonCode: reasonCode,
                revokedBy: msg.sender,
                revokedAt: uint64(block.timestamp),
                lastSeq: d.highestSeq,
                missingAtRevoke: d.highestSeq - d.received
            })
        );
        _revokeRole(role, account);
        emit SignerRevoked(role, account, reasonCode, msg.sender, d.highestSeq);
    }

    /// @notice 감리·발주처가 서명해야 할 EIP-712 digest (백엔드·배포 스크립트용).
    function signerApprovalDigest(uint256 proposalId) external view returns (bytes32) {
        if (proposalId >= _proposals.length) revert ProposalNotFound(proposalId);
        return _hashTypedDataV4(_signerApprovalStructHash(proposalId));
    }

    function getProposal(uint256 proposalId) external view returns (SignerProposal memory) {
        if (proposalId >= _proposals.length) revert ProposalNotFound(proposalId);
        return _proposals[proposalId];
    }

    function proposalCount() external view returns (uint256) {
        return _proposals.length;
    }

    // ==================================================================
    // 근로자 출입 검사 (게이트 기기)
    // ==================================================================

    /// @notice 출입 검사 기록. 서명·nonce·역할이 맞으면 거부하지 않고 저장한 뒤 출입 상태로 분류한다.
    ///   - 서명 후 10분 이내 → 정상, 10분~24시간 → 지연(감사용), 24시간 초과 → 거부
    ///   - 기기 시계가 1~10분 앞섬 → 의심(감사용), 10분 넘게 앞섬 → 거부
    ///   - 서명 시각이 QR 발급~만료 사이가 아니면 거부 (만료된 QR로는 출입 기록이 생기지 않음)
    ///   - 당일 위험성평가가 없으면 '보류'로 저장 (시도 사실은 남김)
    ///   - 기기 일련번호로 제출되지 않은 기록(누락)을 드러낸다
    function submitCheckIn(CheckIn calldata c, bytes calldata sig) external {
        _consumeNonce(c.nonce);
        _checkQrWindow(c);
        Timing timing = _classifyCheckInTiming(c.timestamp);
        address device = _recoverWithRole(_checkInStructHash(c), sig, GATE_DEVICE_ROLE);
        _recordSequence(device, c.deviceSeq);

        bool allPassed = c.helmetPass && c.shoesPass && c.alcoholPass;
        EntryStatus status = _entryStatus(c, timing, allPassed);

        StoredCheckIn storage s = _checkIns[c.nonce];
        s.data = c;
        s.device = device;
        s.status = status;
        s.anchoredAt = uint64(block.timestamp);
        _checkInNoncesBySite[c.siteId].push(c.nonce);

        SiteStats storage st = _siteStats[c.siteId];
        st.checkIns += 1;
        if (!allPassed) st.failed += 1;
        if (status == EntryStatus.HeldNoAssessment || status == EntryStatus.HeldHazardsOpen) st.held += 1;
        if (status == EntryStatus.LateAuditOnly) st.late += 1;
        if (status == EntryStatus.SuspectTimestamp) st.suspect += 1;

        emit CheckInRecorded(c.siteId, c.workerId, c.nonce, allPassed, status, device, c.deviceSeq);
    }

    // ==================================================================
    // Manual Override (시공사 감독자)
    // ==================================================================

    /// @notice AI 보호구 불합격 판정을 감독자가 사유 코드와 함께 수동 처리한다.
    function submitOverride(Override calldata o, bytes calldata sig) external {
        _consumeNonce(o.nonce);
        _checkRecordWindow(o.timestamp);
        if (o.reasonCode == 0 || o.reasonCode > OVERRIDE_REASON_MAX) revert InvalidReason(o.reasonCode);

        StoredCheckIn storage s = _checkIns[o.checkInNonce];
        if (s.anchoredAt == 0) revert CheckInNotFound(o.checkInNonce);
        if (!s.data.alcoholPass) revert AlcoholFailCannotBeOverridden(o.checkInNonce);
        if (s.data.helmetPass && s.data.shoesPass) revert CheckInNotFailed(o.checkInNonce);
        // 평가 전 보류·지연 도착은 감독자 수동 처리로 풀 수 없다 (수동 승인으로 안전 조건 전체 우회 금지)
        if (s.status != EntryStatus.Denied) revert CheckInNotOverridable(o.checkInNonce, s.status);
        if (s.overridden) revert AlreadyOverridden(o.checkInNonce);

        bytes32 structHash =
            keccak256(abi.encode(OVERRIDE_TYPEHASH, o.checkInNonce, o.reasonCode, o.nonce, o.timestamp));
        address supervisor = _recoverWithRole(structHash, sig, SUPERVISOR_ROLE);

        s.overridden = true;
        s.overrideReason = o.reasonCode;
        s.overriddenBy = supervisor;
        s.overriddenAt = uint64(block.timestamp);
        _siteStats[s.data.siteId].overrides += 1;

        emit OverrideRecorded(s.data.siteId, o.checkInNonce, o.reasonCode, supervisor);
    }

    // ==================================================================
    // 일일 위험성평가 (시공사 감독자)
    // ==================================================================

    function submitSiteRecord(SiteRecord calldata r, bytes calldata sig) external {
        _consumeNonce(r.nonce);
        _checkRecordWindow(r.timestamp);

        bytes32 structHash = keccak256(
            abi.encode(
                SITE_RECORD_TYPEHASH, r.caseId, r.siteId, r.recordHash, r.hazardsControlled, r.nonce, r.timestamp
            )
        );
        address supervisor = _recoverWithRole(structHash, sig, SUPERVISOR_ROLE);

        StoredSiteRecord storage s = _siteRecords[r.nonce];
        s.data = r;
        s.supervisor = supervisor;
        s.anchoredAt = uint64(block.timestamp);
        _siteRecordNoncesBySite[r.siteId].push(r.nonce);

        // 같은 날 다시 제출하면 최신 평가가 기준이 된다 (오후에 미조치로 바뀌면 이후 출입은 보류)
        _assessments[r.caseId] = Assessment({
            siteId: r.siteId,
            hazardsControlled: r.hazardsControlled,
            recordNonce: r.nonce,
            anchoredAt: uint64(block.timestamp)
        });

        emit SiteRecordSubmitted(r.siteId, r.nonce, r.hazardsControlled, supervisor);
    }

    // ==================================================================
    // 긴급·장비 장애 예외 출입 (감독자 + 감리 또는 발주처)
    // ==================================================================

    /// @notice 게이트 고장·응급 상황 등으로 정상 검사를 못 할 때의 별도 절차.
    /// 감독자 혼자서는 안 되고, 감리 또는 발주처가 같은 내용에 함께 서명해야 기록된다.
    /// 출입 검사 기록(CheckIn)과 분리돼 현장 통계·감리 화면에 따로 집계된다.
    function submitEmergencyEntry(EmergencyEntry calldata e, bytes calldata supervisorSig, bytes calldata reviewerSig)
        external
    {
        _consumeNonce(e.nonce);
        _checkRecordWindow(e.timestamp);
        if (e.reasonCode == 0 || e.reasonCode > EMERGENCY_REASON_MAX) revert InvalidReason(e.reasonCode);

        bytes32 structHash = keccak256(
            abi.encode(EMERGENCY_TYPEHASH, e.caseId, e.siteId, e.workerId, e.reasonCode, e.nonce, e.timestamp)
        );
        address supervisor = _recoverWithRole(structHash, supervisorSig, SUPERVISOR_ROLE);
        address approver = _hashTypedDataV4(structHash).recover(reviewerSig);
        if (!hasRole(INSPECTOR_ROLE, approver) && !hasRole(OWNER_ROLE, approver)) {
            revert MissingRole(approver, INSPECTOR_ROLE);
        }

        StoredEmergency storage s = _emergencies[e.nonce];
        s.data = e;
        s.supervisor = supervisor;
        s.approver = approver;
        s.anchoredAt = uint64(block.timestamp);
        _emergencyNoncesBySite[e.siteId].push(e.nonce);
        _siteStats[e.siteId].emergencies += 1;

        emit EmergencyEntryRecorded(e.siteId, e.nonce, e.reasonCode, supervisor, approver);
    }

    // ==================================================================
    // Case 확정: 시공사 제출 → 감리 승인 → 발주처 승인
    // ==================================================================

    /// @notice 하나의 함수로 제출·승인·반려를 처리한다. 현재 상태에 따라 서명할 수 있는 역할이 정해진다.
    ///   None/Rejected      + SUBMIT          → 감독자(SUPERVISOR)만
    ///   Submitted          + APPROVE/REJECT  → 감리(INSPECTOR)만
    ///   InspectorApproved  + APPROVE/REJECT  → 발주처(OWNER)만
    ///   Finalized          → 더 이상 변경 불가
    function submitCaseAction(CaseAction calldata a, bytes calldata sig) external {
        _consumeNonce(a.nonce);
        _checkRecordWindow(a.timestamp);

        CaseState storage c = _cases[a.caseId];
        bytes32 requiredRole = _requiredRoleFor(c.status, a.action);

        if (a.action == ACTION_REJECT) {
            if (a.reasonCode == 0 || a.reasonCode > REJECT_REASON_MAX) revert InvalidReason(a.reasonCode);
        } else if (a.reasonCode != 0) {
            revert InvalidReason(a.reasonCode);
        }
        if (a.action == ACTION_SUBMIT && a.scopeHash == bytes32(0)) revert EmptyScope();
        if (a.action != ACTION_SUBMIT && a.scopeHash != c.scopeHash) revert ScopeMismatch(c.scopeHash, a.scopeHash);

        bytes32 structHash = keccak256(
            abi.encode(CASE_ACTION_TYPEHASH, a.caseId, a.scopeHash, a.action, a.reasonCode, a.nonce, a.timestamp)
        );
        address actor = _recoverWithRole(structHash, sig, requiredRole);

        if (a.action == ACTION_SUBMIT) {
            c.status = CaseStatus.Submitted;
            c.scopeHash = a.scopeHash;
            c.round += 1;
        } else if (a.action == ACTION_REJECT) {
            c.status = CaseStatus.Rejected;
        } else if (c.status == CaseStatus.Submitted) {
            c.status = CaseStatus.InspectorApproved;
        } else {
            c.status = CaseStatus.Finalized;
        }

        _caseHistory[a.caseId].push(
            CaseHistoryEntry({
                action: a.action,
                reasonCode: a.reasonCode,
                scopeHash: a.scopeHash,
                actor: actor,
                actorRole: requiredRole,
                nonce: a.nonce,
                anchoredAt: uint64(block.timestamp)
            })
        );
        emit CaseActionRecorded(a.caseId, a.action, a.reasonCode, c.status, actor);
    }

    // ==================================================================
    // 조회
    // ==================================================================

    function isNonceUsed(bytes32 nonce) external view returns (bool) {
        return _usedNonces[nonce];
    }

    function getCheckIn(bytes32 nonce) external view returns (StoredCheckIn memory) {
        if (_checkIns[nonce].anchoredAt == 0) revert CheckInNotFound(nonce);
        return _checkIns[nonce];
    }

    function getCheckIns(bytes32 siteId, uint256 from, uint256 to) external view returns (StoredCheckIn[] memory) {
        bytes32[] storage nonces = _checkInNoncesBySite[siteId];
        (uint256 start, uint256 end) = _range(nonces.length, from, to);
        StoredCheckIn[] memory result = new StoredCheckIn[](end - start);
        for (uint256 i = start; i < end; i++) {
            result[i - start] = _checkIns[nonces[i]];
        }
        return result;
    }

    /// @notice 출입 근거로 인정되는가: 허가, 또는 보호구 불합격 후 감독자 Override.
    function isEntryAllowed(bytes32 nonce) external view returns (bool) {
        StoredCheckIn storage s = _checkIns[nonce];
        if (s.anchoredAt == 0) revert CheckInNotFound(nonce);
        return s.status == EntryStatus.Granted || (s.status == EntryStatus.Denied && s.overridden);
    }

    function getAssessment(bytes32 caseId) external view returns (Assessment memory) {
        return _assessments[caseId];
    }

    function getDeviceStats(address device) external view returns (DeviceStats memory) {
        return _deviceStats[device];
    }

    /// @notice 기기가 서명했어야 하는데 체인에 올라오지 않은 기록 수.
    function missingCount(address device) external view returns (uint64) {
        DeviceStats storage d = _deviceStats[device];
        return d.highestSeq - d.received;
    }

    function getEmergencyEntry(bytes32 nonce) external view returns (StoredEmergency memory) {
        return _emergencies[nonce];
    }

    function getEmergencyEntries(bytes32 siteId, uint256 from, uint256 to)
        external
        view
        returns (StoredEmergency[] memory)
    {
        bytes32[] storage nonces = _emergencyNoncesBySite[siteId];
        (uint256 start, uint256 end) = _range(nonces.length, from, to);
        StoredEmergency[] memory result = new StoredEmergency[](end - start);
        for (uint256 i = start; i < end; i++) {
            result[i - start] = _emergencies[nonces[i]];
        }
        return result;
    }

    function getRevocations() external view returns (Revocation[] memory) {
        return _revocations;
    }

    function getSiteStats(bytes32 siteId) external view returns (SiteStats memory) {
        return _siteStats[siteId];
    }

    function getSiteRecord(bytes32 nonce) external view returns (StoredSiteRecord memory) {
        return _siteRecords[nonce];
    }

    function getSiteRecords(bytes32 siteId, uint256 from, uint256 to)
        external
        view
        returns (StoredSiteRecord[] memory)
    {
        bytes32[] storage nonces = _siteRecordNoncesBySite[siteId];
        (uint256 start, uint256 end) = _range(nonces.length, from, to);
        StoredSiteRecord[] memory result = new StoredSiteRecord[](end - start);
        for (uint256 i = start; i < end; i++) {
            result[i - start] = _siteRecords[nonces[i]];
        }
        return result;
    }

    function getCase(bytes32 caseId) external view returns (CaseState memory) {
        return _cases[caseId];
    }

    function getCaseHistory(bytes32 caseId) external view returns (CaseHistoryEntry[] memory) {
        return _caseHistory[caseId];
    }

    // ==================================================================
    // 내부 함수
    // ==================================================================

    function _consumeNonce(bytes32 nonce) private {
        if (_usedNonces[nonce]) revert NonceAlreadyUsed(nonce);
        _usedNonces[nonce] = true;
    }

    enum Timing {
        OnTime,
        Late,
        Suspect
    }

    /// @dev 출입 검사 시각 분류.
    ///   미래 10분 초과·과거 24시간 초과 → 거부 / 미래 1~10분 → 의심 / 과거 10분~24시간 → 지연 / 그 외 → 정상
    function _classifyCheckInTiming(uint64 signedAt) private view returns (Timing) {
        if (
            uint256(signedAt) > block.timestamp + CHECKIN_SUSPECT_FUTURE
                || block.timestamp > uint256(signedAt) + CHECKIN_LATE_LIMIT
        ) {
            revert StaleTimestamp(signedAt, uint64(block.timestamp));
        }
        if (uint256(signedAt) > block.timestamp + MAX_CLOCK_SKEW) return Timing.Suspect;
        if (block.timestamp > uint256(signedAt) + CHECKIN_ON_TIME) return Timing.Late;
        return Timing.OnTime;
    }

    /// @dev QR 유효기간: 발급~만료가 MAX_QR_TTL 이하이고, 게이트 서명 시각이 그 사이여야 한다.
    function _checkQrWindow(CheckIn calldata c) private pure {
        if (c.qrExpiresAt <= c.qrIssuedAt || c.qrExpiresAt - c.qrIssuedAt > MAX_QR_TTL) {
            revert InvalidQrWindow(c.qrIssuedAt, c.qrExpiresAt);
        }
        if (c.timestamp < c.qrIssuedAt || c.timestamp > c.qrExpiresAt) {
            revert QrNotValidAtSigning(c.qrIssuedAt, c.qrExpiresAt, c.timestamp);
        }
    }

    /// @dev 위험성평가·Override·Case 승인: [블록 시각 - 1시간, 블록 시각 + 1분] 밖이면 거부.
    function _checkRecordWindow(uint64 signedAt) private view {
        _checkWithin(signedAt, RECORD_WINDOW);
    }

    function _checkWithin(uint64 signedAt, uint64 maxAge) private view {
        if (uint256(signedAt) > block.timestamp + MAX_CLOCK_SKEW || block.timestamp > uint256(signedAt) + maxAge) {
            revert StaleTimestamp(signedAt, uint64(block.timestamp));
        }
    }

    function _checkInStructHash(CheckIn calldata c) private pure returns (bytes32) {
        return keccak256(
            bytes.concat(
                abi.encode(CHECKIN_TYPEHASH, c.caseId, c.workerId, c.siteId, c.helmetPass, c.shoesPass),
                abi.encode(c.alcoholPass, c.modelHash, c.evidenceHash, c.nonce),
                abi.encode(c.qrIssuedAt, c.qrExpiresAt, c.deviceSeq, c.timestamp)
            )
        );
    }

    /// @dev 기기별 일련번호 기록. 같은 번호 재사용은 거부해 '누락을 다른 기록으로 메우는 것'을 막는다.
    function _recordSequence(address device, uint64 seq) private {
        if (seq == 0) revert InvalidSequence(seq);
        if (_seqUsed[device][seq]) revert DuplicateSequence(device, seq);
        _seqUsed[device][seq] = true;

        DeviceStats storage d = _deviceStats[device];
        if (seq > d.highestSeq) {
            if (seq > d.highestSeq + 1) emit SequenceGap(device, d.highestSeq + 1, seq - 1);
            d.highestSeq = seq;
        }
        d.received += 1;
    }

    function _entryStatus(CheckIn calldata c, Timing timing, bool allPassed) private view returns (EntryStatus) {
        if (timing == Timing.Suspect) return EntryStatus.SuspectTimestamp;
        if (timing == Timing.Late) return EntryStatus.LateAuditOnly;
        Assessment storage a = _assessments[c.caseId];
        // 출입 허가 조건 ①: 당일(KST) 이 현장의 위험성평가가 체인에 있고, 위험요인 조치가 끝났어야 한다.
        // caseId는 게이트가 넣는 값이라, 어제 caseId를 재사용하지 못하도록 평가의 블록 시각 날짜까지 확인한다.
        if (a.anchoredAt == 0 || a.siteId != c.siteId || _dayOf(a.anchoredAt) != _dayOf(block.timestamp)) {
            return EntryStatus.HeldNoAssessment;
        }
        if (!a.hazardsControlled) return EntryStatus.HeldHazardsOpen;
        // 출입 허가 조건 ②: 안전검사 통과. (조건 ③ 출입 권한 1회 사용은 submitCheckIn 첫 줄 _consumeNonce가 보장)
        return allPassed ? EntryStatus.Granted : EntryStatus.Denied;
    }

    function _dayOf(uint256 ts) private pure returns (uint256) {
        return (ts + DAY_OFFSET) / 1 days;
    }

    function _recoverWithRole(bytes32 structHash, bytes calldata sig, bytes32 role) private view returns (address) {
        address signer = _hashTypedDataV4(structHash).recover(sig);
        if (!hasRole(role, signer)) revert MissingRole(signer, role);
        return signer;
    }

    function _requiredRoleFor(CaseStatus status, uint8 action) private pure returns (bytes32) {
        if (action == ACTION_SUBMIT) {
            if (status == CaseStatus.None || status == CaseStatus.Rejected) return SUPERVISOR_ROLE;
        } else if (action == ACTION_APPROVE || action == ACTION_REJECT) {
            if (status == CaseStatus.Submitted) return INSPECTOR_ROLE;
            if (status == CaseStatus.InspectorApproved) return OWNER_ROLE;
        }
        revert InvalidCaseTransition(status, action);
    }

    function _signerApprovalStructHash(uint256 proposalId) private view returns (bytes32) {
        SignerProposal storage p = _proposals[proposalId];
        return keccak256(abi.encode(SIGNER_APPROVAL_TYPEHASH, proposalId, p.role, p.account));
    }

    function _range(uint256 length, uint256 from, uint256 to) private pure returns (uint256, uint256) {
        uint256 end = to > length ? length : to;
        if (from >= end) return (0, 0);
        return (from, end);
    }
}
