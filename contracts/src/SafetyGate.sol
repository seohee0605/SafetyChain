// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @notice On-chain anchor for gate check-in results. Stores only pseudonymous
/// pass/fail results signed by pre-registered gate devices; never raw sensor values.
contract SafetyGate is AccessControl, EIP712 {
    using ECDSA for bytes32;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    bytes32 private constant CHECKIN_TYPEHASH = keccak256(
        "CheckIn(bytes32 caseId,bytes32 workerId,bytes32 siteId,bool helmetPass,bool shoesPass,bool alcoholPass,bytes32 modelHash,bytes32 nonce,uint64 timestamp)"
    );

    bytes32 private constant SITE_RECORD_TYPEHASH = keccak256(
        "SiteRecord(bytes32 caseId,bytes32 siteId,bytes32 recordHash,bool hazardsControlled,bytes32 nonce,uint64 timestamp)"
    );

    bytes32 private constant CASE_REVIEW_TYPEHASH = keccak256(
        "CaseReview(bytes32 caseId,bytes32 reviewScopeHash,bool reviewResult,bytes32 nonce,uint64 timestamp)"
    );

    struct CheckIn {
        bytes32 caseId; // 현장·작업일 단위로 위험성평가·검사를 묶는 식별자
        bytes32 workerId; // pseudonymous identifier, not a real name
        bytes32 siteId;
        bool helmetPass;
        bool shoesPass;
        bool alcoholPass; // pass/fail only, never the measured value
        bytes32 modelHash; // hash of the AI model weights used for inference
        bytes32 nonce; // single-use QR nonce
        uint64 timestamp;
    }

    /// @notice Daily site risk-assessment anchor. The full assessment (hazards,
    /// control measures, change history) lives off-chain; only its hash and the
    /// "high-risk items controlled" summary are anchored here.
    struct SiteRecord {
        bytes32 caseId;
        bytes32 siteId;
        bytes32 recordHash; // keccak256 of the off-chain risk-assessment document
        bool hazardsControlled; // whether high-risk (중점관리대상) items are confirmed controlled
        bytes32 nonce; // shares the same single-use nonce pool as CheckIn
        uint64 timestamp;
    }

    /// @notice Supervisor's final review over a case: "I reviewed these risk-assessment
    /// and worker check-in records and this is my verdict." reviewScopeHash binds the
    /// exact set of off-chain record references that were reviewed, so the scope can't
    /// be silently expanded after the fact.
    struct CaseReview {
        bytes32 caseId;
        bytes32 reviewScopeHash;
        bool reviewResult;
        bytes32 nonce;
        uint64 timestamp;
    }

    mapping(address device => bool registered) public registeredDevices;
    mapping(bytes32 nonce => bool used) private _usedNonces;
    mapping(bytes32 siteId => CheckIn[] checkIns) private _checkInsBySite;
    mapping(bytes32 siteId => SiteRecord[] records) private _siteRecordsBySite;
    mapping(bytes32 caseId => CaseReview[] reviews) private _reviewsByCase;

    event CheckInRecorded(
        bytes32 indexed siteId, bytes32 indexed workerId, uint256 idx, bool allPassed, address device
    );
    event SiteRecordSubmitted(bytes32 indexed siteId, uint256 idx, bool hazardsControlled, address device);
    event CaseReviewSubmitted(bytes32 indexed caseId, uint256 idx, bool reviewResult, address device);

    error NonceAlreadyUsed(bytes32 nonce);
    error UnregisteredDevice(address device);

    constructor(address admin) EIP712("SafetyChain", "1") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    function registerDevice(address device) external onlyRole(ADMIN_ROLE) {
        registeredDevices[device] = true;
    }

    function revokeDevice(address device) external onlyRole(ADMIN_ROLE) {
        registeredDevices[device] = false;
    }

    function submitCheckIn(CheckIn calldata c, bytes calldata sig) external {
        if (_usedNonces[c.nonce]) revert NonceAlreadyUsed(c.nonce);

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
                c.nonce,
                c.timestamp
            )
        );
        address signer = _hashTypedDataV4(structHash).recover(sig);

        if (!registeredDevices[signer]) revert UnregisteredDevice(signer);

        _usedNonces[c.nonce] = true;
        _checkInsBySite[c.siteId].push(c);
        uint256 idx = _checkInsBySite[c.siteId].length - 1;

        bool allPassed = c.helmetPass && c.shoesPass && c.alcoholPass;
        emit CheckInRecorded(c.siteId, c.workerId, idx, allPassed, signer);
    }

    function getCheckIns(bytes32 siteId, uint256 from, uint256 to) external view returns (CheckIn[] memory) {
        CheckIn[] storage all = _checkInsBySite[siteId];
        uint256 cappedTo = to > all.length ? all.length : to;
        if (from >= cappedTo) {
            return new CheckIn[](0);
        }

        CheckIn[] memory result = new CheckIn[](cappedTo - from);
        for (uint256 i = from; i < cappedTo; i++) {
            result[i - from] = all[i];
        }
        return result;
    }

    function isNonceUsed(bytes32 nonce) external view returns (bool) {
        return _usedNonces[nonce];
    }

    function submitSiteRecord(SiteRecord calldata r, bytes calldata sig) external {
        if (_usedNonces[r.nonce]) revert NonceAlreadyUsed(r.nonce);

        bytes32 structHash = keccak256(
            abi.encode(
                SITE_RECORD_TYPEHASH, r.caseId, r.siteId, r.recordHash, r.hazardsControlled, r.nonce, r.timestamp
            )
        );
        address signer = _hashTypedDataV4(structHash).recover(sig);

        if (!registeredDevices[signer]) revert UnregisteredDevice(signer);

        _usedNonces[r.nonce] = true;
        _siteRecordsBySite[r.siteId].push(r);
        uint256 idx = _siteRecordsBySite[r.siteId].length - 1;

        emit SiteRecordSubmitted(r.siteId, idx, r.hazardsControlled, signer);
    }

    function getSiteRecords(bytes32 siteId, uint256 from, uint256 to) external view returns (SiteRecord[] memory) {
        SiteRecord[] storage all = _siteRecordsBySite[siteId];
        uint256 cappedTo = to > all.length ? all.length : to;
        if (from >= cappedTo) {
            return new SiteRecord[](0);
        }

        SiteRecord[] memory result = new SiteRecord[](cappedTo - from);
        for (uint256 i = from; i < cappedTo; i++) {
            result[i - from] = all[i];
        }
        return result;
    }

    function submitCaseReview(CaseReview calldata r, bytes calldata sig) external {
        if (_usedNonces[r.nonce]) revert NonceAlreadyUsed(r.nonce);

        bytes32 structHash = keccak256(
            abi.encode(CASE_REVIEW_TYPEHASH, r.caseId, r.reviewScopeHash, r.reviewResult, r.nonce, r.timestamp)
        );
        address signer = _hashTypedDataV4(structHash).recover(sig);

        if (!registeredDevices[signer]) revert UnregisteredDevice(signer);

        _usedNonces[r.nonce] = true;
        _reviewsByCase[r.caseId].push(r);
        uint256 idx = _reviewsByCase[r.caseId].length - 1;

        emit CaseReviewSubmitted(r.caseId, idx, r.reviewResult, signer);
    }

    function getCaseReviews(bytes32 caseId, uint256 from, uint256 to) external view returns (CaseReview[] memory) {
        CaseReview[] storage all = _reviewsByCase[caseId];
        uint256 cappedTo = to > all.length ? all.length : to;
        if (from >= cappedTo) {
            return new CaseReview[](0);
        }

        CaseReview[] memory result = new CaseReview[](cappedTo - from);
        for (uint256 i = from; i < cappedTo; i++) {
            result[i - from] = all[i];
        }
        return result;
    }
}
