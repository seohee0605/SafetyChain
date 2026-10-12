// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @title SafetyGate
/// @notice 건설현장 출입 검사·위험성평가·감리/발주처 승인 기록을 온체인에 앵커링한다.
///
/// 설계 원칙 (1회차 멘토링 반영)
/// 1. 역할 분리: 게이트 기기 / 시공사 감독자 / 감리 / 발주처가 서명할 수 있는 기록 종류가 다르다.
///    게이트 기기 키로 감독자 승인을 만들거나, 감독자 키로 근로자 검사 기록을 만들 수 없다.
/// 2. 서명자 등록 = 시공사 제안 + 감리·발주처 승인: 시공사 혼자 가짜 기기를 등록할 수 없다.
/// 3. 소급 차단: 서명 시각이 블록 시각과 MAX_SIGNATURE_AGE 이상 차이 나면 거부한다.
///    화면에는 서명 시각이 아니라 블록 시각(anchoredAt)을 보여준다.
/// 4. Manual Override: AI가 보호구 불합격을 냈을 때 감독자가 사유 코드를 남겨 수동 처리한다.
///    음주 불합격은 AI 판정이 아니므로 override할 수 없다. override 건수는 현장 통계에 남는다.
/// 5. 다중 서명 확정: 하루치 기록(case)은 시공사 제출 → 감리 승인 → 발주처 승인을 거쳐야 확정된다.
///    반려·재제출 이력은 모두 남는다(append-only).
/// 6. 개인정보: 온체인에는 가명 ID, pass/fail, 해시, 서명자 주소만 올린다. 측정 수치·사진 원본은 오프체인.
///
/// 모든 기록은 "서명 + 릴레이" 방식이다. 서명자는 EIP-712로 서명만 하고,
/// 가스비는 릴레이(백엔드)가 낸다. 그래서 기기·감리·발주처 키에 ETH가 필요 없다.
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

    /// @notice 서명 시각이 블록 시각보다 이만큼 이상 과거면 거부한다 (소급 작성 차단).
    uint64 public constant MAX_SIGNATURE_AGE = 10 minutes;
    /// @notice 기기 시계 오차 허용치. 서명 시각이 블록 시각보다 이만큼 이상 미래면 거부한다.
    uint64 public constant MAX_CLOCK_SKEW = 1 minutes;

    /// @notice Override 사유 코드 (온체인에는 코드만, 자유 텍스트는 올리지 않는다).
    uint8 public constant OVERRIDE_FALSE_POSITIVE = 1; // AI 오탐 (육안 확인 결과 착용)
    uint8 public constant OVERRIDE_CAMERA_FAULT = 2; // 카메라·조명 문제로 판정 불가
    uint8 public constant OVERRIDE_REINSPECTED = 3; // 현장에서 보호구 재착용 후 재확인
    uint8 public constant OVERRIDE_REASON_MAX = 3;

    /// @notice Case 행위 코드.
    uint8 public constant ACTION_SUBMIT = 1; // 시공사 감독자 제출
    uint8 public constant ACTION_APPROVE = 2; // 감리 또는 발주처 승인
    uint8 public constant ACTION_REJECT = 3; // 감리 또는 발주처 반려 (사유 코드 필수)

    // ------------------------------------------------------------------
    // EIP-712 타입
    // ------------------------------------------------------------------

    bytes32 private constant CHECKIN_TYPEHASH = keccak256(
        "CheckIn(bytes32 caseId,bytes32 workerId,bytes32 siteId,bool helmetPass,bool shoesPass,bool alcoholPass,bytes32 modelHash,bytes32 evidenceHash,bytes32 nonce,uint64 timestamp)"
    );
    bytes32 private constant SITE_RECORD_TYPEHASH = keccak256(
        "SiteRecord(bytes32 caseId,bytes32 siteId,bytes32 recordHash,bool hazardsControlled,bytes32 nonce,uint64 timestamp)"
    );
    bytes32 private constant OVERRIDE_TYPEHASH =
        keccak256("Override(bytes32 checkInNonce,uint8 reasonCode,bytes32 nonce,uint64 timestamp)");
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
        uint64 timestamp; // 기기가 서명한 시각 (블록 시각과 비교해 검증)
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

    struct StoredCheckIn {
        CheckIn data;
        address device; // 서명한 게이트 기기
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
        uint64 checkIns; // 전체 검사 건수
        uint64 failed; // AI·음주 불합격 건수
        uint64 overrides; // 감독자 수동 처리 건수
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

    // ------------------------------------------------------------------
    // 이벤트 / 에러
    // ------------------------------------------------------------------

    event CheckInRecorded(
        bytes32 indexed siteId, bytes32 indexed workerId, bytes32 nonce, bool allPassed, address device
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
    /// 해제는 권한을 줄이는 방향이라 승인 없이 허용한다. 과거 기록은 그대로 남는다.
    function revokeSigner(bytes32 role, address account) external onlyRole(CONTRACTOR_ADMIN_ROLE) {
        if (role != GATE_DEVICE_ROLE && role != SUPERVISOR_ROLE) revert RoleNotAssignable(role);
        _revokeRole(role, account);
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

    function submitCheckIn(CheckIn calldata c, bytes calldata sig) external {
        _consumeNonce(c.nonce);
        _checkFreshness(c.timestamp);

        bytes32 structHash = keccak256(
            abi.encode(
                CHECKIN_TYPEHASH,
                c.caseId,
                c.workerId,
                c.siteId,
                c.helmetPass,
                c.shoesPass,
                c.alcoholPass,
                c.modelHash,
                c.evidenceHash,
                c.nonce,
                c.timestamp
            )
        );
        address device = _recoverWithRole(structHash, sig, GATE_DEVICE_ROLE);

        StoredCheckIn storage s = _checkIns[c.nonce];
        s.data = c;
        s.device = device;
        s.anchoredAt = uint64(block.timestamp);
        _checkInNoncesBySite[c.siteId].push(c.nonce);

        bool allPassed = c.helmetPass && c.shoesPass && c.alcoholPass;
        SiteStats storage st = _siteStats[c.siteId];
        st.checkIns += 1;
        if (!allPassed) st.failed += 1;

        emit CheckInRecorded(c.siteId, c.workerId, c.nonce, allPassed, device);
    }

    // ==================================================================
    // Manual Override (시공사 감독자)
    // ==================================================================

    /// @notice AI 보호구 불합격 판정을 감독자가 사유 코드와 함께 수동 처리한다.
    function submitOverride(Override calldata o, bytes calldata sig) external {
        _consumeNonce(o.nonce);
        _checkFreshness(o.timestamp);
        if (o.reasonCode == 0 || o.reasonCode > OVERRIDE_REASON_MAX) revert InvalidReason(o.reasonCode);

        StoredCheckIn storage s = _checkIns[o.checkInNonce];
        if (s.anchoredAt == 0) revert CheckInNotFound(o.checkInNonce);
        if (!s.data.alcoholPass) revert AlcoholFailCannotBeOverridden(o.checkInNonce);
        if (s.data.helmetPass && s.data.shoesPass) revert CheckInNotFailed(o.checkInNonce);
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
        _checkFreshness(r.timestamp);

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

        emit SiteRecordSubmitted(r.siteId, r.nonce, r.hazardsControlled, supervisor);
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
        _checkFreshness(a.timestamp);

        CaseState storage c = _cases[a.caseId];
        bytes32 requiredRole = _requiredRoleFor(c.status, a.action);

        if (a.action == ACTION_REJECT) {
            if (a.reasonCode == 0) revert InvalidReason(a.reasonCode);
        } else if (a.reasonCode != 0) {
            revert InvalidReason(a.reasonCode);
        }
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

    /// @dev 서명 시각이 [블록 시각 - MAX_SIGNATURE_AGE, 블록 시각 + MAX_CLOCK_SKEW] 안에 있어야 한다.
    function _checkFreshness(uint64 signedAt) private view {
        if (
            uint256(signedAt) > block.timestamp + MAX_CLOCK_SKEW
                || block.timestamp > uint256(signedAt) + MAX_SIGNATURE_AGE
        ) {
            revert StaleTimestamp(signedAt, uint64(block.timestamp));
        }
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
