// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SafetyGate} from "../src/SafetyGate.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

contract SafetyGateTest is Test {
    SafetyGate gate;

    // 시공사 운영 관리자 (msg.sender로 호출)
    address contractorAdmin = makeAddr("contractorAdmin");

    // 서명 키들 (EIP-712 서명 → 릴레이 제출)
    uint256 devicePk = 0xA11CE;
    uint256 supervisorPk = 0x5A9E;
    uint256 inspectorPk = 0x1A5;
    uint256 ownerPk = 0x0E1;
    uint256 attackerPk = 0xBAD;
    address device;
    address supervisor;
    address inspector;
    address owner;
    address attacker;

    bytes32 constant SITE_ID = keccak256("site-1");
    bytes32 constant CASE_ID = keccak256("site-1|2026-10-12");
    bytes32 constant MODEL_HASH = keccak256("ppe-weights");
    bytes32 constant SCOPE = keccak256("nonces-of-day");

    bytes32 constant CHECKIN_TYPEHASH = keccak256(
        "CheckIn(bytes32 caseId,bytes32 workerId,bytes32 siteId,bool helmetPass,bool shoesPass,bool alcoholPass,bytes32 modelHash,bytes32 evidenceHash,bytes32 nonce,uint64 qrIssuedAt,uint64 qrExpiresAt,uint64 deviceSeq,uint64 timestamp)"
    );
    bytes32 constant SITE_RECORD_TYPEHASH = keccak256(
        "SiteRecord(bytes32 caseId,bytes32 siteId,bytes32 recordHash,bool hazardsControlled,bytes32 nonce,uint64 timestamp)"
    );
    bytes32 constant OVERRIDE_TYPEHASH =
        keccak256("Override(bytes32 checkInNonce,uint8 reasonCode,bytes32 nonce,uint64 timestamp)");
    bytes32 constant EMERGENCY_TYPEHASH = keccak256(
        "EmergencyEntry(bytes32 caseId,bytes32 siteId,bytes32 workerId,uint8 reasonCode,bytes32 nonce,uint64 timestamp)"
    );
    bytes32 constant CASE_ACTION_TYPEHASH = keccak256(
        "CaseAction(bytes32 caseId,bytes32 scopeHash,uint8 action,uint8 reasonCode,bytes32 nonce,uint64 timestamp)"
    );

    uint256 nonceCounter;
    uint64 seqCounter;

    function setUp() public {
        vm.warp(1_790_000_000); // 2026년 근처의 현실적인 블록 시각
        device = vm.addr(devicePk);
        supervisor = vm.addr(supervisorPk);
        inspector = vm.addr(inspectorPk);
        owner = vm.addr(ownerPk);
        attacker = vm.addr(attackerPk);

        gate = new SafetyGate(contractorAdmin, inspector, owner);

        _registerSigner(gate.GATE_DEVICE_ROLE(), device, inspectorPk);
        _registerSigner(gate.SUPERVISOR_ROLE(), supervisor, ownerPk);
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    function _nonce() internal returns (bytes32) {
        return keccak256(abi.encode("nonce", ++nonceCounter));
    }

    function _sign(uint256 pk, bytes32 structHash) internal view returns (bytes memory) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("SafetyChain")),
                keccak256(bytes("1")),
                block.chainid,
                address(gate)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _registerSigner(bytes32 role, address account, uint256 approverPk) internal returns (uint256 id) {
        vm.prank(contractorAdmin);
        id = gate.proposeSigner(role, account);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(approverPk, gate.signerApprovalDigest(id));
        gate.approveSigner(id, abi.encodePacked(r, s, v));
    }

    function _checkIn(bytes32 nonce, bool helmet, bool shoes, bool alcohol)
        internal
        returns (SafetyGate.CheckIn memory)
    {
        return SafetyGate.CheckIn({
            caseId: CASE_ID,
            workerId: keccak256("worker-1"),
            siteId: SITE_ID,
            helmetPass: helmet,
            shoesPass: shoes,
            alcoholPass: alcohol,
            modelHash: MODEL_HASH,
            evidenceHash: keccak256("photo-bytes"),
            nonce: nonce,
            qrIssuedAt: uint64(block.timestamp - 1 minutes),
            qrExpiresAt: uint64(block.timestamp + 4 minutes),
            deviceSeq: ++seqCounter,
            timestamp: uint64(block.timestamp)
        });
    }

    /// @dev 테스트가 서명 시각을 바꿔도 QR 유효기간이 그 시각을 감싸도록 맞춘 뒤 서명한다 (QR 테스트는 _signCheckInRaw 사용)
    function _signCheckIn(SafetyGate.CheckIn memory c, uint256 pk) internal view returns (bytes memory) {
        if (c.timestamp < c.qrIssuedAt || c.timestamp > c.qrExpiresAt) {
            c.qrIssuedAt = c.timestamp - 1 minutes;
            c.qrExpiresAt = c.timestamp + 4 minutes;
        }
        return _signCheckInRaw(c, pk);
    }

    function _signCheckInRaw(SafetyGate.CheckIn memory c, uint256 pk) internal view returns (bytes memory) {
        bytes memory head = abi.encode(CHECKIN_TYPEHASH, c.caseId, c.workerId, c.siteId, c.helmetPass, c.shoesPass);
        bytes memory mid = abi.encode(c.alcoholPass, c.modelHash, c.evidenceHash, c.nonce);
        bytes memory tail = abi.encode(c.qrIssuedAt, c.qrExpiresAt, c.deviceSeq, c.timestamp);
        return _sign(pk, keccak256(bytes.concat(head, mid, tail)));
    }


    function _submitCheckIn(bool helmet, bool shoes, bool alcohol) internal returns (bytes32 nonce) {
        nonce = _nonce();
        SafetyGate.CheckIn memory c = _checkIn(nonce, helmet, shoes, alcohol);
        gate.submitCheckIn(c, _signCheckIn(c, devicePk));
    }

    function _override(bytes32 checkInNonce, uint8 reason) internal returns (SafetyGate.Override memory o) {
        o = SafetyGate.Override({
            checkInNonce: checkInNonce, reasonCode: reason, nonce: _nonce(), timestamp: uint64(block.timestamp)
        });
    }

    function _signOverride(SafetyGate.Override memory o, uint256 pk) internal view returns (bytes memory) {
        return _sign(pk, keccak256(abi.encode(OVERRIDE_TYPEHASH, o.checkInNonce, o.reasonCode, o.nonce, o.timestamp)));
    }

    function _siteRecord(bytes32 nonce) internal view returns (SafetyGate.SiteRecord memory) {
        return SafetyGate.SiteRecord({
            caseId: CASE_ID,
            siteId: SITE_ID,
            recordHash: keccak256("risk-assessment"),
            hazardsControlled: true,
            nonce: nonce,
            timestamp: uint64(block.timestamp)
        });
    }

    function _signSiteRecord(SafetyGate.SiteRecord memory r, uint256 pk) internal view returns (bytes memory) {
        return _sign(
            pk,
            keccak256(
                abi.encode(
                    SITE_RECORD_TYPEHASH, r.caseId, r.siteId, r.recordHash, r.hazardsControlled, r.nonce, r.timestamp
                )
            )
        );
    }

    /// @dev 오늘(CASE_ID) 위험성평가를 제출한다. 출입 허가(Granted)의 전제 조건.
    function _assess(bool hazardsControlled) internal {
        SafetyGate.SiteRecord memory r = _siteRecord(_nonce());
        r.hazardsControlled = hazardsControlled;
        gate.submitSiteRecord(r, _signSiteRecord(r, supervisorPk));
    }

    function _status(bytes32 nonce) internal view returns (SafetyGate.EntryStatus) {
        return gate.getCheckIn(nonce).status;
    }

    function _caseAction(uint8 action, uint8 reason, bytes32 scope) internal returns (SafetyGate.CaseAction memory) {
        return SafetyGate.CaseAction({
            caseId: CASE_ID,
            scopeHash: scope,
            action: action,
            reasonCode: reason,
            nonce: _nonce(),
            timestamp: uint64(block.timestamp)
        });
    }

    function _signCaseAction(SafetyGate.CaseAction memory a, uint256 pk) internal view returns (bytes memory) {
        return _sign(
            pk,
            keccak256(
                abi.encode(CASE_ACTION_TYPEHASH, a.caseId, a.scopeHash, a.action, a.reasonCode, a.nonce, a.timestamp)
            )
        );
    }

    function _act(uint8 action, uint8 reason, bytes32 scope, uint256 pk) internal {
        SafetyGate.CaseAction memory a = _caseAction(action, reason, scope);
        gate.submitCaseAction(a, _signCaseAction(a, pk));
    }

    // ==================================================================
    // 1. 서명자 등록: 시공사 제안 + 감리·발주처 승인
    // ==================================================================

    function test_constructor_grantsRoles_andNobodyIsDefaultAdmin() public view {
        assertTrue(gate.hasRole(gate.CONTRACTOR_ADMIN_ROLE(), contractorAdmin));
        assertTrue(gate.hasRole(gate.INSPECTOR_ROLE(), inspector));
        assertTrue(gate.hasRole(gate.OWNER_ROLE(), owner));
        assertFalse(gate.hasRole(gate.DEFAULT_ADMIN_ROLE(), contractorAdmin));
    }

    function test_contractorAdmin_cannotGrantRoleDirectly() public {
        bytes32 role = gate.GATE_DEVICE_ROLE();
        vm.prank(contractorAdmin);
        vm.expectRevert();
        gate.grantRole(role, attacker);
    }

    function test_proposedSigner_hasNoPowerUntilApproved() public {
        bytes32 role = gate.GATE_DEVICE_ROLE();
        vm.prank(contractorAdmin);
        gate.proposeSigner(role, attacker);
        assertFalse(gate.hasRole(role, attacker));

        bytes32 nonce = _nonce();
        SafetyGate.CheckIn memory c = _checkIn(nonce, true, true, true);
        bytes memory sig = _signCheckIn(c, attackerPk);
        vm.expectRevert(abi.encodeWithSelector(SafetyGate.MissingRole.selector, attacker, role));
        gate.submitCheckIn(c, sig);
    }

    function test_approveSigner_byOwner_activates() public {
        address newDevice = makeAddr("newDevice");
        _registerSigner(gate.GATE_DEVICE_ROLE(), newDevice, ownerPk);
        assertTrue(gate.hasRole(gate.GATE_DEVICE_ROLE(), newDevice));
        assertEq(gate.getProposal(gate.proposalCount() - 1).approvedBy, owner);
    }

    function test_approveSigner_selfApprovalByContractorSideRejected() public {
        // 시공사 쪽(감독자 키)이 스스로 승인 서명을 만들어도 거부된다
        bytes32 role = gate.GATE_DEVICE_ROLE();
        vm.prank(contractorAdmin);
        uint256 id = gate.proposeSigner(role, attacker);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(supervisorPk, gate.signerApprovalDigest(id));
        vm.expectRevert(abi.encodeWithSelector(SafetyGate.MissingRole.selector, supervisor, gate.INSPECTOR_ROLE()));
        gate.approveSigner(id, abi.encodePacked(r, s, v));
    }

    function test_approveSigner_cannotBeReplayed() public {
        bytes32 role = gate.GATE_DEVICE_ROLE();
        vm.prank(contractorAdmin);
        uint256 id = gate.proposeSigner(role, makeAddr("d2"));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(inspectorPk, gate.signerApprovalDigest(id));
        gate.approveSigner(id, abi.encodePacked(r, s, v));
        vm.expectRevert(abi.encodeWithSelector(SafetyGate.ProposalAlreadyExecuted.selector, id));
        gate.approveSigner(id, abi.encodePacked(r, s, v));
    }

    function test_onlyContractorAdmin_canPropose() public {
        bytes32 role = gate.GATE_DEVICE_ROLE();
        bytes32 adminRole = gate.CONTRACTOR_ADMIN_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, attacker, adminRole)
        );
        vm.prank(attacker);
        gate.proposeSigner(role, attacker);
    }

    function test_cannotProposeInspectorOrOwnerRole() public {
        bytes32 role = gate.INSPECTOR_ROLE();
        vm.prank(contractorAdmin);
        vm.expectRevert(abi.encodeWithSelector(SafetyGate.RoleNotAssignable.selector, role));
        gate.proposeSigner(role, attacker);
    }

    function test_revokedDevice_cannotSubmit_butPastRecordsRemain() public {
        bytes32 past = _submitCheckIn(true, true, true);
        bytes32 role = gate.GATE_DEVICE_ROLE();
        vm.prank(contractorAdmin);
        gate.revokeSigner(role, device, 1);

        bytes32 nonce = _nonce();
        SafetyGate.CheckIn memory c = _checkIn(nonce, true, true, true);
        bytes memory sig = _signCheckIn(c, devicePk);
        vm.expectRevert(abi.encodeWithSelector(SafetyGate.MissingRole.selector, device, role));
        gate.submitCheckIn(c, sig);

        assertEq(gate.getCheckIn(past).device, device);
    }

    // ==================================================================
    // 2. 출입 검사 + 역할 분리 + 소급 차단
    // ==================================================================

    function test_checkIn_storesDeviceBlockTimeAndEvidence() public {
        bytes32 nonce = _submitCheckIn(true, true, true);
        SafetyGate.StoredCheckIn memory s = gate.getCheckIn(nonce);
        assertEq(s.device, device);
        assertEq(s.anchoredAt, block.timestamp);
        assertEq(s.data.evidenceHash, keccak256("photo-bytes"));
        assertTrue(gate.isNonceUsed(nonce));
        assertEq(gate.getSiteStats(SITE_ID).checkIns, 1);
        assertEq(gate.getSiteStats(SITE_ID).failed, 0);
    }

    function test_checkIn_failCountedInStats() public {
        _submitCheckIn(false, true, true);
        assertEq(gate.getSiteStats(SITE_ID).failed, 1);
    }

    function test_checkIn_replayRejected() public {
        bytes32 nonce = _nonce();
        SafetyGate.CheckIn memory c = _checkIn(nonce, true, true, true);
        bytes memory sig = _signCheckIn(c, devicePk);
        gate.submitCheckIn(c, sig);
        vm.expectRevert(abi.encodeWithSelector(SafetyGate.NonceAlreadyUsed.selector, nonce));
        gate.submitCheckIn(c, sig);
    }

    function test_checkIn_supervisorKeyCannotForgeWorkerRecord() public {
        SafetyGate.CheckIn memory c = _checkIn(_nonce(), true, true, true);
        bytes memory sig = _signCheckIn(c, supervisorPk);
        vm.expectRevert(abi.encodeWithSelector(SafetyGate.MissingRole.selector, supervisor, gate.GATE_DEVICE_ROLE()));
        gate.submitCheckIn(c, sig);
    }

    function test_checkIn_tamperedPayloadRejected() public {
        SafetyGate.CheckIn memory c = _checkIn(_nonce(), false, true, true);
        bytes memory sig = _signCheckIn(c, devicePk);
        c.helmetPass = true; // 서명 후 결과 조작
        vm.expectRevert(); // 복구된 주소가 등록 기기가 아님
        gate.submitCheckIn(c, sig);
    }

    function test_checkIn_backdatedOverOneDayRejected() public {
        SafetyGate.CheckIn memory c = _checkIn(_nonce(), true, true, true);
        c.timestamp = uint64(block.timestamp - 1 days - 1); // 24시간 넘게 지난 기록 = 명백한 소급
        bytes memory sig = _signCheckIn(c, devicePk);
        vm.expectRevert(
            abi.encodeWithSelector(SafetyGate.StaleTimestamp.selector, c.timestamp, uint64(block.timestamp))
        );
        gate.submitCheckIn(c, sig);
    }

    function test_checkIn_farFutureTimestampRejected() public {
        SafetyGate.CheckIn memory c = _checkIn(_nonce(), true, true, true);
        c.timestamp = uint64(block.timestamp + 10 minutes + 1);
        bytes memory sig = _signCheckIn(c, devicePk);
        vm.expectRevert(
            abi.encodeWithSelector(SafetyGate.StaleTimestamp.selector, c.timestamp, uint64(block.timestamp))
        );
        gate.submitCheckIn(c, sig);
    }

    function test_checkIn_withinNetworkDelayAccepted() public {
        SafetyGate.CheckIn memory c = _checkIn(_nonce(), true, true, true);
        bytes memory sig = _signCheckIn(c, devicePk);
        vm.warp(block.timestamp + 2 minutes); // 테스트넷 지연
        gate.submitCheckIn(c, sig);
        assertEq(gate.getCheckIn(c.nonce).anchoredAt, block.timestamp);
    }

    function test_getCheckIns_range() public {
        _submitCheckIn(true, true, true);
        _submitCheckIn(false, true, true);
        _submitCheckIn(true, true, true);
        assertEq(gate.getCheckIns(SITE_ID, 0, 100).length, 3);
        assertEq(gate.getCheckIns(SITE_ID, 1, 2).length, 1);
        assertEq(gate.getCheckIns(SITE_ID, 5, 9).length, 0);
    }

    // ==================================================================
    // 3. Manual Override
    // ==================================================================

    function test_override_supervisorRecordsReason_andStatsCount() public {
        _assess(true);
        bytes32 target = _submitCheckIn(false, true, true); // AI가 안전모 미착용 판정
        SafetyGate.Override memory o = _override(target, 1);
        gate.submitOverride(o, _signOverride(o, supervisorPk));

        SafetyGate.StoredCheckIn memory s = gate.getCheckIn(target);
        assertTrue(s.overridden);
        assertEq(s.overrideReason, 1);
        assertEq(s.overriddenBy, supervisor);
        assertFalse(s.data.helmetPass); // 원래 AI 판정은 그대로 남는다
        assertEq(gate.getSiteStats(SITE_ID).overrides, 1);
    }

    function test_override_deviceKeyCannotOverride() public {
        _assess(true);
        bytes32 target = _submitCheckIn(false, true, true);
        SafetyGate.Override memory o = _override(target, 1);
        bytes memory sig = _signOverride(o, devicePk);
        vm.expectRevert(abi.encodeWithSelector(SafetyGate.MissingRole.selector, device, gate.SUPERVISOR_ROLE()));
        gate.submitOverride(o, sig);
    }

    function test_override_cannotOverridePassingCheckIn() public {
        bytes32 target = _submitCheckIn(true, true, true);
        SafetyGate.Override memory o = _override(target, 1);
        bytes memory sig = _signOverride(o, supervisorPk);
        vm.expectRevert(abi.encodeWithSelector(SafetyGate.CheckInNotFailed.selector, target));
        gate.submitOverride(o, sig);
    }

    function test_override_cannotBypassAlcoholFail() public {
        bytes32 target = _submitCheckIn(true, true, false);
        SafetyGate.Override memory o = _override(target, 1);
        bytes memory sig = _signOverride(o, supervisorPk);
        vm.expectRevert(abi.encodeWithSelector(SafetyGate.AlcoholFailCannotBeOverridden.selector, target));
        gate.submitOverride(o, sig);
    }

    function test_override_onlyOnce() public {
        _assess(true);
        bytes32 target = _submitCheckIn(true, false, true);
        SafetyGate.Override memory o1 = _override(target, 3);
        gate.submitOverride(o1, _signOverride(o1, supervisorPk));
        SafetyGate.Override memory o2 = _override(target, 1);
        bytes memory sig = _signOverride(o2, supervisorPk);
        vm.expectRevert(abi.encodeWithSelector(SafetyGate.AlreadyOverridden.selector, target));
        gate.submitOverride(o2, sig);
    }

    function test_override_reasonCodeRequired() public {
        bytes32 target = _submitCheckIn(false, true, true);
        SafetyGate.Override memory o = _override(target, 0);
        bytes memory sig = _signOverride(o, supervisorPk);
        vm.expectRevert(abi.encodeWithSelector(SafetyGate.InvalidReason.selector, 0));
        gate.submitOverride(o, sig);
    }

    function test_override_unknownCheckInRejected() public {
        bytes32 missing = keccak256("missing");
        SafetyGate.Override memory o = _override(missing, 1);
        bytes memory sig = _signOverride(o, supervisorPk);
        vm.expectRevert(abi.encodeWithSelector(SafetyGate.CheckInNotFound.selector, missing));
        gate.submitOverride(o, sig);
    }

    // ==================================================================
    // 4. 위험성평가
    // ==================================================================

    function test_siteRecord_supervisorSubmits() public {
        SafetyGate.SiteRecord memory r = _siteRecord(_nonce());
        gate.submitSiteRecord(r, _signSiteRecord(r, supervisorPk));
        SafetyGate.StoredSiteRecord memory s = gate.getSiteRecord(r.nonce);
        assertEq(s.supervisor, supervisor);
        assertEq(s.data.recordHash, keccak256("risk-assessment"));
        assertEq(gate.getSiteRecords(SITE_ID, 0, 10).length, 1);
    }

    function test_siteRecord_deviceKeyRejected() public {
        SafetyGate.SiteRecord memory r = _siteRecord(_nonce());
        bytes memory sig = _signSiteRecord(r, devicePk);
        vm.expectRevert(abi.encodeWithSelector(SafetyGate.MissingRole.selector, device, gate.SUPERVISOR_ROLE()));
        gate.submitSiteRecord(r, sig);
    }

    function test_siteRecord_backdatedRejected() public {
        SafetyGate.SiteRecord memory r = _siteRecord(_nonce());
        r.timestamp = uint64(block.timestamp - 7 days);
        bytes memory sig = _signSiteRecord(r, supervisorPk);
        vm.expectRevert(
            abi.encodeWithSelector(SafetyGate.StaleTimestamp.selector, r.timestamp, uint64(block.timestamp))
        );
        gate.submitSiteRecord(r, sig);
    }

    function test_noncePool_sharedAcrossRecordTypes() public {
        bytes32 nonce = _submitCheckIn(true, true, true);
        SafetyGate.SiteRecord memory r = _siteRecord(nonce);
        bytes memory sig = _signSiteRecord(r, supervisorPk);
        vm.expectRevert(abi.encodeWithSelector(SafetyGate.NonceAlreadyUsed.selector, nonce));
        gate.submitSiteRecord(r, sig);
    }

    // ==================================================================
    // 5. Case 확정: 시공사 제출 → 감리 → 발주처
    // ==================================================================

    function test_case_fullFlow_finalizedAfterInspectorAndOwner() public {
        _act(1, 0, SCOPE, supervisorPk);
        assertEq(uint8(gate.getCase(CASE_ID).status), uint8(SafetyGate.CaseStatus.Submitted));
        _act(2, 0, SCOPE, inspectorPk);
        assertEq(uint8(gate.getCase(CASE_ID).status), uint8(SafetyGate.CaseStatus.InspectorApproved));
        _act(2, 0, SCOPE, ownerPk);
        assertEq(uint8(gate.getCase(CASE_ID).status), uint8(SafetyGate.CaseStatus.Finalized));

        SafetyGate.CaseHistoryEntry[] memory h = gate.getCaseHistory(CASE_ID);
        assertEq(h.length, 3);
        assertEq(h[0].actor, supervisor);
        assertEq(h[1].actor, inspector);
        assertEq(h[2].actor, owner);
    }

    function test_case_contractorCannotFinalizeAlone() public {
        _act(1, 0, SCOPE, supervisorPk);
        SafetyGate.CaseAction memory a = _caseAction(2, 0, SCOPE);
        bytes memory sig = _signCaseAction(a, supervisorPk); // 감독자가 스스로 승인 시도
        vm.expectRevert(abi.encodeWithSelector(SafetyGate.MissingRole.selector, supervisor, gate.INSPECTOR_ROLE()));
        gate.submitCaseAction(a, sig);
    }

    function test_case_ownerCannotSkipInspector() public {
        _act(1, 0, SCOPE, supervisorPk);
        SafetyGate.CaseAction memory a = _caseAction(2, 0, SCOPE);
        bytes memory sig = _signCaseAction(a, ownerPk);
        vm.expectRevert(abi.encodeWithSelector(SafetyGate.MissingRole.selector, owner, gate.INSPECTOR_ROLE()));
        gate.submitCaseAction(a, sig);
    }

    function test_case_rejectThenResubmit_historyPreserved() public {
        bytes32 scope2 = keccak256("nonces-after-fix");
        _act(1, 0, SCOPE, supervisorPk);
        _act(3, 4, SCOPE, inspectorPk); // 감리 반려 (사유 코드 4: 재검사 요구)
        assertEq(uint8(gate.getCase(CASE_ID).status), uint8(SafetyGate.CaseStatus.Rejected));

        _act(1, 0, scope2, supervisorPk); // 재제출
        SafetyGate.CaseState memory c = gate.getCase(CASE_ID);
        assertEq(uint8(c.status), uint8(SafetyGate.CaseStatus.Submitted));
        assertEq(c.round, 2);
        assertEq(c.scopeHash, scope2);

        SafetyGate.CaseHistoryEntry[] memory h = gate.getCaseHistory(CASE_ID);
        assertEq(h.length, 3);
        assertEq(h[1].action, 3);
        assertEq(h[1].reasonCode, 4);
        assertEq(h[1].scopeHash, SCOPE); // 반려된 원래 범위도 남아 있다
    }

    function test_case_rejectRequiresReason() public {
        _act(1, 0, SCOPE, supervisorPk);
        SafetyGate.CaseAction memory a = _caseAction(3, 0, SCOPE);
        bytes memory sig = _signCaseAction(a, inspectorPk);
        vm.expectRevert(abi.encodeWithSelector(SafetyGate.InvalidReason.selector, 0));
        gate.submitCaseAction(a, sig);
    }

    function test_case_approveMustMatchSubmittedScope() public {
        _act(1, 0, SCOPE, supervisorPk);
        bytes32 other = keccak256("different-scope");
        SafetyGate.CaseAction memory a = _caseAction(2, 0, other);
        bytes memory sig = _signCaseAction(a, inspectorPk);
        vm.expectRevert(abi.encodeWithSelector(SafetyGate.ScopeMismatch.selector, SCOPE, other));
        gate.submitCaseAction(a, sig);
    }

    function test_case_finalizedIsImmutable() public {
        _act(1, 0, SCOPE, supervisorPk);
        _act(2, 0, SCOPE, inspectorPk);
        _act(2, 0, SCOPE, ownerPk);
        SafetyGate.CaseAction memory a = _caseAction(1, 0, keccak256("rewrite"));
        bytes memory sig = _signCaseAction(a, supervisorPk);
        vm.expectRevert(
            abi.encodeWithSelector(SafetyGate.InvalidCaseTransition.selector, SafetyGate.CaseStatus.Finalized, 1)
        );
        gate.submitCaseAction(a, sig);
    }

    function test_case_cannotApproveBeforeSubmit() public {
        SafetyGate.CaseAction memory a = _caseAction(2, 0, SCOPE);
        bytes memory sig = _signCaseAction(a, inspectorPk);
        vm.expectRevert(
            abi.encodeWithSelector(SafetyGate.InvalidCaseTransition.selector, SafetyGate.CaseStatus.None, 2)
        );
        gate.submitCaseAction(a, sig);
    }
    // ---- 추가 케이스 ----

    function test_checkIn_timestampWindowEdgesAccepted() public {
        SafetyGate.CheckIn memory c1 = _checkIn(_nonce(), true, true, true);
        c1.timestamp = uint64(block.timestamp - 10 minutes);
        gate.submitCheckIn(c1, _signCheckIn(c1, devicePk));

        SafetyGate.CheckIn memory c2 = _checkIn(_nonce(), true, true, true);
        c2.timestamp = uint64(block.timestamp + 1 minutes);
        gate.submitCheckIn(c2, _signCheckIn(c2, devicePk));
    }

    function test_approveSigner_unknownProposalRejected() public {
        vm.expectRevert(abi.encodeWithSelector(SafetyGate.ProposalNotFound.selector, 99));
        gate.approveSigner(99, "");
    }

    function test_case_inspectorCannotGiveFinalApproval() public {
        _act(1, 0, SCOPE, supervisorPk);
        _act(2, 0, SCOPE, inspectorPk);
        SafetyGate.CaseAction memory a = _caseAction(2, 0, SCOPE);
        bytes memory sig = _signCaseAction(a, inspectorPk);
        vm.expectRevert(abi.encodeWithSelector(SafetyGate.MissingRole.selector, inspector, gate.OWNER_ROLE()));
        gate.submitCaseAction(a, sig);
    }

    function test_case_reviewerCannotSubmit() public {
        SafetyGate.CaseAction memory a = _caseAction(1, 0, SCOPE);
        bytes memory sig = _signCaseAction(a, inspectorPk);
        vm.expectRevert(abi.encodeWithSelector(SafetyGate.MissingRole.selector, inspector, gate.SUPERVISOR_ROLE()));
        gate.submitCaseAction(a, sig);
    }

    function test_case_ownerCanRejectAfterInspectorApproval() public {
        _act(1, 0, SCOPE, supervisorPk);
        _act(2, 0, SCOPE, inspectorPk);
        _act(3, 5, SCOPE, ownerPk);
        assertEq(uint8(gate.getCase(CASE_ID).status), uint8(SafetyGate.CaseStatus.Rejected));
    }

    function test_case_cannotResubmitWhileUnderReview() public {
        _act(1, 0, SCOPE, supervisorPk);
        SafetyGate.CaseAction memory a = _caseAction(1, 0, keccak256("swapped-scope"));
        bytes memory sig = _signCaseAction(a, supervisorPk);
        vm.expectRevert(
            abi.encodeWithSelector(SafetyGate.InvalidCaseTransition.selector, SafetyGate.CaseStatus.Submitted, 1)
        );
        gate.submitCaseAction(a, sig);
    }

    function test_case_rejectReasonOutOfRange() public {
        _act(1, 0, SCOPE, supervisorPk);
        SafetyGate.CaseAction memory a = _caseAction(3, 6, SCOPE);
        bytes memory sig = _signCaseAction(a, inspectorPk);
        vm.expectRevert(abi.encodeWithSelector(SafetyGate.InvalidReason.selector, 6));
        gate.submitCaseAction(a, sig);
    }

    function test_case_emptyScopeRejected() public {
        SafetyGate.CaseAction memory a = _caseAction(1, 0, bytes32(0));
        bytes memory sig = _signCaseAction(a, supervisorPk);
        vm.expectRevert(SafetyGate.EmptyScope.selector);
        gate.submitCaseAction(a, sig);
    }

    function test_case_backdatedActionRejected() public {
        _act(1, 0, SCOPE, supervisorPk);
        SafetyGate.CaseAction memory a = _caseAction(2, 0, SCOPE);
        a.timestamp = uint64(block.timestamp - 1 days);
        bytes memory sig = _signCaseAction(a, inspectorPk);
        vm.expectRevert(
            abi.encodeWithSelector(SafetyGate.StaleTimestamp.selector, a.timestamp, uint64(block.timestamp))
        );
        gate.submitCaseAction(a, sig);
    }

    // ==================================================================
    // 6. 기록 누락 탐지: 기기 일련번호 (3회차 멘토링 Q4)
    // ==================================================================

    function _submitWithSeq(uint64 seq) internal returns (bytes32 nonce) {
        nonce = _nonce();
        SafetyGate.CheckIn memory c = _checkIn(nonce, true, true, true);
        c.deviceSeq = seq;
        gate.submitCheckIn(c, _signCheckIn(c, devicePk));
    }

    function test_seq_noGap_noMissing() public {
        _submitWithSeq(1);
        _submitWithSeq(2);
        _submitWithSeq(3);
        SafetyGate.DeviceStats memory d = gate.getDeviceStats(device);
        assertEq(d.highestSeq, 3);
        assertEq(d.received, 3);
        assertEq(gate.missingCount(device), 0);
    }

    function test_seq_selectiveOmission_showsMissing() public {
        // 1~10번 중 불합격 4·7·9번을 시공사가 빼고 제출
        for (uint64 i = 1; i <= 10; i++) {
            if (i == 4 || i == 7 || i == 9) continue;
            _submitWithSeq(i);
        }
        assertEq(gate.getDeviceStats(device).highestSeq, 10);
        assertEq(gate.missingCount(device), 3);
    }

    function test_seq_gapEmitsEvent() public {
        _submitWithSeq(1);
        bytes32 nonce = _nonce();
        SafetyGate.CheckIn memory c = _checkIn(nonce, true, true, true);
        c.deviceSeq = 5;
        bytes memory sig = _signCheckIn(c, devicePk);
        vm.expectEmit(true, false, false, true, address(gate));
        emit SafetyGate.SequenceGap(device, 2, 4);
        gate.submitCheckIn(c, sig);
    }

    function test_seq_lateArrivalFillsGap() public {
        // 오프라인으로 3·4번이 늦게 도착해도 누락 계산이 맞다
        _submitWithSeq(1);
        _submitWithSeq(2);
        _submitWithSeq(5);
        assertEq(gate.missingCount(device), 2);
        vm.warp(block.timestamp + 30 minutes);
        SafetyGate.CheckIn memory c3 = _checkIn(_nonce(), true, true, true);
        c3.deviceSeq = 3;
        c3.timestamp = uint64(block.timestamp - 30 minutes);
        gate.submitCheckIn(c3, _signCheckIn(c3, devicePk));
        SafetyGate.CheckIn memory c4 = _checkIn(_nonce(), true, true, true);
        c4.deviceSeq = 4;
        c4.timestamp = uint64(block.timestamp - 30 minutes);
        gate.submitCheckIn(c4, _signCheckIn(c4, devicePk));
        assertEq(gate.getDeviceStats(device).highestSeq, 5);
        assertEq(gate.missingCount(device), 0);
    }

    function test_seq_duplicateRejected() public {
        // 같은 번호를 두 번 써서 누락을 메우는 것 방지
        _submitWithSeq(1);
        bytes32 nonce = _nonce();
        SafetyGate.CheckIn memory c = _checkIn(nonce, true, true, true);
        c.deviceSeq = 1;
        bytes memory sig = _signCheckIn(c, devicePk);
        vm.expectRevert(abi.encodeWithSelector(SafetyGate.DuplicateSequence.selector, device, 1));
        gate.submitCheckIn(c, sig);
    }

    function test_seq_zeroRejected() public {
        SafetyGate.CheckIn memory c = _checkIn(_nonce(), true, true, true);
        c.deviceSeq = 0;
        bytes memory sig = _signCheckIn(c, devicePk);
        vm.expectRevert(abi.encodeWithSelector(SafetyGate.InvalidSequence.selector, 0));
        gate.submitCheckIn(c, sig);
    }

    function test_seq_trackedPerDevice() public {
        uint256 device2Pk = 0xD2;
        address device2 = vm.addr(device2Pk);
        _registerSigner(gate.GATE_DEVICE_ROLE(), device2, inspectorPk);
        _submitWithSeq(1);
        SafetyGate.CheckIn memory c = _checkIn(_nonce(), true, true, true);
        c.deviceSeq = 1; // 기기마다 번호가 따로 시작
        gate.submitCheckIn(c, _signCheckIn(c, device2Pk));
        assertEq(gate.getDeviceStats(device).received, 1);
        assertEq(gate.getDeviceStats(device2).received, 1);
    }

    // ==================================================================
    // 7. 서명자 해제: 사유 코드 필수 + 이력 공개 (Q4)
    // ==================================================================

    function test_revoke_recordsReasonAndLastSeq() public {
        _submitWithSeq(1);
        _submitWithSeq(2);
        _submitWithSeq(4); // 3번 누락
        bytes32 role = gate.GATE_DEVICE_ROLE();
        vm.warp(block.timestamp + 1 hours);
        vm.prank(contractorAdmin);
        gate.revokeSigner(role, device, 2); // 기기 고장·교체

        SafetyGate.Revocation[] memory r = gate.getRevocations();
        assertEq(r.length, 1);
        assertEq(r[0].account, device);
        assertEq(r[0].role, role);
        assertEq(r[0].reasonCode, 2);
        assertEq(r[0].revokedBy, contractorAdmin);
        assertEq(r[0].revokedAt, block.timestamp);
        assertEq(r[0].lastSeq, 4);
        assertEq(r[0].missingAtRevoke, 1);
        assertFalse(gate.hasRole(role, device));
    }

    function test_revoke_reasonRequired() public {
        bytes32 role = gate.GATE_DEVICE_ROLE();
        vm.startPrank(contractorAdmin);
        vm.expectRevert(abi.encodeWithSelector(SafetyGate.InvalidReason.selector, 0));
        gate.revokeSigner(role, device, 0);
        vm.expectRevert(abi.encodeWithSelector(SafetyGate.InvalidReason.selector, 4));
        gate.revokeSigner(role, device, 4);
        vm.stopPrank();
    }

    function test_revoke_inactiveSignerRejected() public {
        bytes32 role = gate.GATE_DEVICE_ROLE();
        vm.prank(contractorAdmin);
        vm.expectRevert(abi.encodeWithSelector(SafetyGate.SignerNotActive.selector, role, attacker));
        gate.revokeSigner(role, attacker, 1);
    }

    function test_revoke_onlyContractorAdmin() public {
        bytes32 role = gate.GATE_DEVICE_ROLE();
        vm.prank(attacker);
        vm.expectRevert();
        gate.revokeSigner(role, device, 1);
    }

    // ==================================================================
    // 8. 출입 순서 강제: 위험성평가가 있어야 출입 허가 (Q5)
    // ==================================================================

    function test_entry_noAssessment_heldButRecorded() public {
        bytes32 nonce = _submitCheckIn(true, true, true);
        assertEq(uint8(_status(nonce)), uint8(SafetyGate.EntryStatus.HeldNoAssessment));
        assertFalse(gate.isEntryAllowed(nonce));
        assertEq(gate.getSiteStats(SITE_ID).checkIns, 1); // 시도 기록은 남는다
        assertEq(gate.getSiteStats(SITE_ID).held, 1);
    }

    function test_entry_assessmentHazardsNotControlled_held() public {
        _assess(false);
        bytes32 nonce = _submitCheckIn(true, true, true);
        assertEq(uint8(_status(nonce)), uint8(SafetyGate.EntryStatus.HeldHazardsOpen));
    }

    function test_entry_assessmentThenPass_granted() public {
        _assess(true);
        bytes32 nonce = _submitCheckIn(true, true, true);
        assertEq(uint8(_status(nonce)), uint8(SafetyGate.EntryStatus.Granted));
        assertTrue(gate.isEntryAllowed(nonce));
    }

    function test_entry_latestAssessmentWins() public {
        _assess(true);
        _assess(false); // 오후에 위험요인 미조치로 다시 제출
        bytes32 nonce = _submitCheckIn(true, true, true);
        assertEq(uint8(_status(nonce)), uint8(SafetyGate.EntryStatus.HeldHazardsOpen));
    }

    function test_entry_assessmentOfOtherSite_doesNotCount() public {
        // 다른 현장의 평가로 이 현장 출입을 열 수 없다
        SafetyGate.SiteRecord memory r = _siteRecord(_nonce());
        r.siteId = keccak256("site-2");
        gate.submitSiteRecord(r, _signSiteRecord(r, supervisorPk));
        bytes32 nonce = _submitCheckIn(true, true, true);
        assertEq(uint8(_status(nonce)), uint8(SafetyGate.EntryStatus.HeldNoAssessment));
    }

    function test_entry_failWithAssessment_denied() public {
        _assess(true);
        bytes32 nonce = _submitCheckIn(false, true, true);
        assertEq(uint8(_status(nonce)), uint8(SafetyGate.EntryStatus.Denied));
        assertFalse(gate.isEntryAllowed(nonce));
    }

    function test_entry_deniedThenOverride_allowed() public {
        _assess(true);
        bytes32 nonce = _submitCheckIn(false, true, true);
        SafetyGate.Override memory o = _override(nonce, 1);
        gate.submitOverride(o, _signOverride(o, supervisorPk));
        assertTrue(gate.isEntryAllowed(nonce));
    }

    function test_override_cannotBypassMissingAssessment() public {
        bytes32 nonce = _submitCheckIn(false, true, true); // 평가 전 + 보호구 불합격
        SafetyGate.Override memory o = _override(nonce, 1);
        bytes memory sig = _signOverride(o, supervisorPk);
        vm.expectRevert(
            abi.encodeWithSelector(
                SafetyGate.CheckInNotOverridable.selector, nonce, SafetyGate.EntryStatus.HeldNoAssessment
            )
        );
        gate.submitOverride(o, sig);
        assertFalse(gate.isEntryAllowed(nonce));
    }

    // ==================================================================
    // 9. 거부 대신 저장 후 분류 + 기록별 시간 기준 (Q1·Q2)
    // ==================================================================

    function test_checkIn_lateWithin24h_storedAsAuditOnly() public {
        _assess(true);
        SafetyGate.CheckIn memory c = _checkIn(_nonce(), true, true, true);
        bytes memory sig = _signCheckIn(c, devicePk);
        vm.warp(block.timestamp + 30 minutes); // 통신 장애로 30분 뒤 재전송
        gate.submitCheckIn(c, sig);
        assertEq(uint8(_status(c.nonce)), uint8(SafetyGate.EntryStatus.LateAuditOnly));
        assertFalse(gate.isEntryAllowed(c.nonce)); // 검사 사실은 남지만 출입 근거는 아님
        assertEq(gate.getSiteStats(SITE_ID).late, 1);
        assertEq(gate.getCheckIn(c.nonce).anchoredAt, block.timestamp);
    }

    function test_checkIn_onTimeEdgeIsNotLate() public {
        _assess(true);
        SafetyGate.CheckIn memory c = _checkIn(_nonce(), true, true, true);
        c.timestamp = uint64(block.timestamp - 10 minutes);
        gate.submitCheckIn(c, _signCheckIn(c, devicePk));
        assertEq(uint8(_status(c.nonce)), uint8(SafetyGate.EntryStatus.Granted));

        SafetyGate.CheckIn memory c2 = _checkIn(_nonce(), true, true, true);
        c2.timestamp = uint64(block.timestamp - 10 minutes - 1);
        gate.submitCheckIn(c2, _signCheckIn(c2, devicePk));
        assertEq(uint8(_status(c2.nonce)), uint8(SafetyGate.EntryStatus.LateAuditOnly));
    }

    function test_checkIn_exactly24hAcceptedAsLate() public {
        SafetyGate.CheckIn memory c = _checkIn(_nonce(), true, true, true);
        c.timestamp = uint64(block.timestamp - 1 days);
        gate.submitCheckIn(c, _signCheckIn(c, devicePk));
        assertEq(uint8(_status(c.nonce)), uint8(SafetyGate.EntryStatus.LateAuditOnly));
    }

    function test_override_cannotApplyToLateRecord() public {
        _assess(true);
        SafetyGate.CheckIn memory c = _checkIn(_nonce(), false, true, true);
        bytes memory sig = _signCheckIn(c, devicePk);
        vm.warp(block.timestamp + 30 minutes);
        gate.submitCheckIn(c, sig);
        SafetyGate.Override memory o = _override(c.nonce, 1);
        bytes memory osig = _signOverride(o, supervisorPk);
        vm.expectRevert(
            abi.encodeWithSelector(
                SafetyGate.CheckInNotOverridable.selector, c.nonce, SafetyGate.EntryStatus.LateAuditOnly
            )
        );
        gate.submitOverride(o, osig);
    }

    function test_siteRecord_within1hAccepted_beyondRejected() public {
        SafetyGate.SiteRecord memory r = _siteRecord(_nonce());
        r.timestamp = uint64(block.timestamp - 50 minutes);
        gate.submitSiteRecord(r, _signSiteRecord(r, supervisorPk));

        SafetyGate.SiteRecord memory r2 = _siteRecord(_nonce());
        r2.timestamp = uint64(block.timestamp - 1 hours - 1);
        bytes memory sig = _signSiteRecord(r2, supervisorPk);
        vm.expectRevert(
            abi.encodeWithSelector(SafetyGate.StaleTimestamp.selector, r2.timestamp, uint64(block.timestamp))
        );
        gate.submitSiteRecord(r2, sig);
    }

    function test_caseAction_within1hAccepted() public {
        _act(1, 0, SCOPE, supervisorPk);
        SafetyGate.CaseAction memory a = _caseAction(2, 0, SCOPE);
        a.timestamp = uint64(block.timestamp - 50 minutes); // 승인 서명 후 50분 뒤 제출
        gate.submitCaseAction(a, _signCaseAction(a, inspectorPk));
        assertEq(uint8(gate.getCase(CASE_ID).status), uint8(SafetyGate.CaseStatus.InspectorApproved));
    }

    function test_override_beyond1hRejected() public {
        _assess(true);
        bytes32 target = _submitCheckIn(false, true, true);
        SafetyGate.Override memory o = _override(target, 1);
        o.timestamp = uint64(block.timestamp - 1 hours - 1);
        bytes memory sig = _signOverride(o, supervisorPk);
        vm.expectRevert(
            abi.encodeWithSelector(SafetyGate.StaleTimestamp.selector, o.timestamp, uint64(block.timestamp))
        );
        gate.submitOverride(o, sig);
    }

    // ==================================================================
    // 10. 위험성평가는 '해당 날짜' 것이어야 한다 (Q5 보완)
    // ==================================================================

    function test_entry_yesterdaysAssessment_doesNotCountToday() public {
        // 어제 낸 평가의 caseId를 오늘 출입 기록에 그대로 쓰면 평가를 안 하고도 출입이 열리는 구멍
        _assess(true);
        vm.warp(block.timestamp + 1 days);
        bytes32 nonce = _submitCheckIn(true, true, true);
        assertEq(uint8(_status(nonce)), uint8(SafetyGate.EntryStatus.HeldNoAssessment));
        assertFalse(gate.isEntryAllowed(nonce));
    }

    function test_entry_sameKstDayAssessment_counts() public {
        // KST 기준 같은 날이면 아침 평가로 오후 출입이 열린다
        uint256 kstMidnight = ((block.timestamp + 9 hours) / 1 days) * 1 days - 9 hours;
        vm.warp(kstMidnight + 6 hours); // KST 06:00 평가
        _assess(true);
        vm.warp(kstMidnight + 17 hours); // KST 17:00 출입
        bytes32 nonce = _submitCheckIn(true, true, true);
        assertEq(uint8(_status(nonce)), uint8(SafetyGate.EntryStatus.Granted));
    }

    function test_entry_assessmentJustBeforeKstMidnight_doesNotCountNextDay() public {
        uint256 kstMidnight = ((block.timestamp + 9 hours) / 1 days) * 1 days - 9 hours;
        vm.warp(kstMidnight + 1 days - 5 minutes); // KST 23:55 평가
        _assess(true);
        vm.warp(kstMidnight + 1 days + 5 minutes); // 다음 날 KST 00:05 출입
        bytes32 nonce = _submitCheckIn(true, true, true);
        assertEq(uint8(_status(nonce)), uint8(SafetyGate.EntryStatus.HeldNoAssessment));
    }

    function test_entry_entryRightIsOneTime() public {
        // 출입 권한(QR nonce)은 한 번만 쓸 수 있다: 같은 QR로 두 번째 출입 기록은 거부
        _assess(true);
        bytes32 nonce = _nonce();
        SafetyGate.CheckIn memory c = _checkIn(nonce, true, true, true);
        gate.submitCheckIn(c, _signCheckIn(c, devicePk));
        SafetyGate.CheckIn memory c2 = _checkIn(nonce, true, true, true); // 같은 QR, 다른 일련번호
        bytes memory sig2 = _signCheckIn(c2, devicePk);
        vm.expectRevert(abi.encodeWithSelector(SafetyGate.NonceAlreadyUsed.selector, nonce));
        gate.submitCheckIn(c2, sig2);
    }

    // ==================================================================
    // 11. 보류 사유 구분: 평가 없음 vs 위험요인 미조치 (3회차 리뷰 보완)
    // ==================================================================

    function test_held_reasonsAreDistinguished_andBothCountedAsHeld() public {
        bytes32 noAssessment = _submitCheckIn(true, true, true);
        _assess(false);
        bytes32 hazardsOpen = _submitCheckIn(true, true, true);
        assertEq(uint8(_status(noAssessment)), uint8(SafetyGate.EntryStatus.HeldNoAssessment));
        assertEq(uint8(_status(hazardsOpen)), uint8(SafetyGate.EntryStatus.HeldHazardsOpen));
        assertEq(gate.getSiteStats(SITE_ID).held, 2);
        assertFalse(gate.isEntryAllowed(hazardsOpen));
    }

    function test_override_cannotBypassOpenHazards() public {
        _assess(false);
        bytes32 nonce = _submitCheckIn(false, true, true); // 위험요인 미조치 + 보호구 불합격
        SafetyGate.Override memory o = _override(nonce, 1);
        bytes memory sig = _signOverride(o, supervisorPk);
        vm.expectRevert(
            abi.encodeWithSelector(
                SafetyGate.CheckInNotOverridable.selector, nonce, SafetyGate.EntryStatus.HeldHazardsOpen
            )
        );
        gate.submitOverride(o, sig);
    }

    function test_entry_yesterdaysHazardsOpenAssessment_isNoAssessmentToday() public {
        // 어제 평가는 오늘 기준으로는 '평가 없음'
        _assess(false);
        vm.warp(block.timestamp + 1 days);
        bytes32 nonce = _submitCheckIn(true, true, true);
        assertEq(uint8(_status(nonce)), uint8(SafetyGate.EntryStatus.HeldNoAssessment));
    }

    // ==================================================================
    // 12. 의심 상태: 기기 시계가 앞선 기록은 거부 대신 '의심'으로 저장 (Q1)
    // ==================================================================

    function test_checkIn_clockAhead_storedAsSuspect() public {
        _assess(true);
        SafetyGate.CheckIn memory c = _checkIn(_nonce(), true, true, true);
        c.timestamp = uint64(block.timestamp + 5 minutes); // 기기 시계가 5분 빠름
        gate.submitCheckIn(c, _signCheckIn(c, devicePk));
        assertEq(uint8(_status(c.nonce)), uint8(SafetyGate.EntryStatus.SuspectTimestamp));
        assertFalse(gate.isEntryAllowed(c.nonce));
        assertEq(gate.getSiteStats(SITE_ID).suspect, 1);
    }

    function test_checkIn_clockSkewWithin1Minute_isNormal() public {
        _assess(true);
        SafetyGate.CheckIn memory c = _checkIn(_nonce(), true, true, true);
        c.timestamp = uint64(block.timestamp + 1 minutes);
        gate.submitCheckIn(c, _signCheckIn(c, devicePk));
        assertEq(uint8(_status(c.nonce)), uint8(SafetyGate.EntryStatus.Granted));
    }

    function test_override_cannotApplyToSuspectRecord() public {
        _assess(true);
        SafetyGate.CheckIn memory c = _checkIn(_nonce(), false, true, true);
        c.timestamp = uint64(block.timestamp + 5 minutes);
        gate.submitCheckIn(c, _signCheckIn(c, devicePk));
        SafetyGate.Override memory o = _override(c.nonce, 1);
        bytes memory sig = _signOverride(o, supervisorPk);
        vm.expectRevert(
            abi.encodeWithSelector(
                SafetyGate.CheckInNotOverridable.selector, c.nonce, SafetyGate.EntryStatus.SuspectTimestamp
            )
        );
        gate.submitOverride(o, sig);
    }

    // ==================================================================
    // 13. QR 유효기간을 온체인에서 검사 (Q3)
    // ==================================================================

    function test_qr_usedAfterExpiry_rejected() public {
        SafetyGate.CheckIn memory c = _checkIn(_nonce(), true, true, true);
        c.qrIssuedAt = uint64(block.timestamp - 10 minutes);
        c.qrExpiresAt = uint64(block.timestamp - 5 minutes); // 5분 전에 만료된 QR로 지금 검사
        bytes memory sig = _signCheckInRaw(c, devicePk);
        vm.expectRevert(
            abi.encodeWithSelector(SafetyGate.QrNotValidAtSigning.selector, c.qrIssuedAt, c.qrExpiresAt, c.timestamp)
        );
        gate.submitCheckIn(c, sig);
    }

    function test_qr_usedBeforeIssue_rejected() public {
        // QR 발급 시각보다 앞선 서명 = '이 시점 이후에 만들어졌다'는 하한 위반
        SafetyGate.CheckIn memory c = _checkIn(_nonce(), true, true, true);
        c.qrIssuedAt = uint64(block.timestamp + 30);
        c.qrExpiresAt = uint64(block.timestamp + 4 minutes);
        bytes memory sig = _signCheckInRaw(c, devicePk);
        vm.expectRevert(
            abi.encodeWithSelector(SafetyGate.QrNotValidAtSigning.selector, c.qrIssuedAt, c.qrExpiresAt, c.timestamp)
        );
        gate.submitCheckIn(c, sig);
    }

    function test_qr_validityLongerThanMax_rejected() public {
        SafetyGate.CheckIn memory c = _checkIn(_nonce(), true, true, true);
        c.qrIssuedAt = uint64(block.timestamp - 1 minutes);
        c.qrExpiresAt = uint64(block.timestamp + 1 days); // 하루짜리 QR은 일회용 출입 권한이 아님
        bytes memory sig = _signCheckInRaw(c, devicePk);
        vm.expectRevert(abi.encodeWithSelector(SafetyGate.InvalidQrWindow.selector, c.qrIssuedAt, c.qrExpiresAt));
        gate.submitCheckIn(c, sig);
    }

    function test_qr_windowStoredOnChain() public {
        bytes32 nonce = _submitCheckIn(true, true, true);
        SafetyGate.StoredCheckIn memory s = gate.getCheckIn(nonce);
        assertEq(s.data.qrIssuedAt, block.timestamp - 1 minutes);
        assertEq(s.data.qrExpiresAt, block.timestamp + 4 minutes);
    }

    // ==================================================================
    // 14. 긴급·장비 장애 예외 출입: 감독자 + 감리(또는 발주처) 이중 서명 (Q5)
    // ==================================================================

    function _emergency(uint8 reason) internal returns (SafetyGate.EmergencyEntry memory) {
        return SafetyGate.EmergencyEntry({
            caseId: CASE_ID,
            siteId: SITE_ID,
            workerId: keccak256("worker-9"),
            reasonCode: reason,
            nonce: _nonce(),
            timestamp: uint64(block.timestamp)
        });
    }

    function _signEmergency(SafetyGate.EmergencyEntry memory e, uint256 pk) internal view returns (bytes memory) {
        return _sign(
            pk,
            keccak256(
                abi.encode(EMERGENCY_TYPEHASH, e.caseId, e.siteId, e.workerId, e.reasonCode, e.nonce, e.timestamp)
            )
        );
    }

    function test_emergency_supervisorAndInspector_recorded() public {
        SafetyGate.EmergencyEntry memory e = _emergency(1); // 게이트 장비 장애
        gate.submitEmergencyEntry(e, _signEmergency(e, supervisorPk), _signEmergency(e, inspectorPk));
        SafetyGate.StoredEmergency memory s = gate.getEmergencyEntry(e.nonce);
        assertEq(s.supervisor, supervisor);
        assertEq(s.approver, inspector);
        assertEq(s.anchoredAt, block.timestamp);
        assertEq(gate.getSiteStats(SITE_ID).emergencies, 1);
        assertEq(gate.getEmergencyEntries(SITE_ID, 0, 10).length, 1);
    }

    function test_emergency_ownerCanCoSign() public {
        SafetyGate.EmergencyEntry memory e = _emergency(2);
        gate.submitEmergencyEntry(e, _signEmergency(e, supervisorPk), _signEmergency(e, ownerPk));
        assertEq(gate.getEmergencyEntry(e.nonce).approver, owner);
    }

    function test_emergency_supervisorAloneCannot() public {
        // 감독자 혼자 두 번 서명해도 안 된다 (수동 승인만으로 안전 조건 우회 금지)
        SafetyGate.EmergencyEntry memory e = _emergency(1);
        bytes memory sup = _signEmergency(e, supervisorPk);
        vm.expectRevert(abi.encodeWithSelector(SafetyGate.MissingRole.selector, supervisor, gate.INSPECTOR_ROLE()));
        gate.submitEmergencyEntry(e, sup, sup);
    }

    function test_emergency_reviewerCannotReplaceSupervisor() public {
        SafetyGate.EmergencyEntry memory e = _emergency(1);
        bytes memory insp = _signEmergency(e, inspectorPk);
        bytes memory own = _signEmergency(e, ownerPk);
        vm.expectRevert(abi.encodeWithSelector(SafetyGate.MissingRole.selector, inspector, gate.SUPERVISOR_ROLE()));
        gate.submitEmergencyEntry(e, insp, own);
    }

    function test_emergency_reasonRequired() public {
        SafetyGate.EmergencyEntry memory e = _emergency(0);
        bytes memory a = _signEmergency(e, supervisorPk);
        bytes memory b = _signEmergency(e, inspectorPk);
        vm.expectRevert(abi.encodeWithSelector(SafetyGate.InvalidReason.selector, 0));
        gate.submitEmergencyEntry(e, a, b);
    }

    function test_emergency_staleRejected() public {
        SafetyGate.EmergencyEntry memory e = _emergency(1);
        e.timestamp = uint64(block.timestamp - 1 hours - 1);
        bytes memory a = _signEmergency(e, supervisorPk);
        bytes memory b = _signEmergency(e, inspectorPk);
        vm.expectRevert(
            abi.encodeWithSelector(SafetyGate.StaleTimestamp.selector, e.timestamp, uint64(block.timestamp))
        );
        gate.submitEmergencyEntry(e, a, b);
    }
}
