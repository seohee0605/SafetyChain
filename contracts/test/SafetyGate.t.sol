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
        "CheckIn(bytes32 caseId,bytes32 workerId,bytes32 siteId,bool helmetPass,bool shoesPass,bool alcoholPass,bytes32 modelHash,bytes32 evidenceHash,bytes32 nonce,uint64 timestamp)"
    );
    bytes32 constant SITE_RECORD_TYPEHASH = keccak256(
        "SiteRecord(bytes32 caseId,bytes32 siteId,bytes32 recordHash,bool hazardsControlled,bytes32 nonce,uint64 timestamp)"
    );
    bytes32 constant OVERRIDE_TYPEHASH =
        keccak256("Override(bytes32 checkInNonce,uint8 reasonCode,bytes32 nonce,uint64 timestamp)");
    bytes32 constant CASE_ACTION_TYPEHASH = keccak256(
        "CaseAction(bytes32 caseId,bytes32 scopeHash,uint8 action,uint8 reasonCode,bytes32 nonce,uint64 timestamp)"
    );

    uint256 nonceCounter;

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
        view
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
            timestamp: uint64(block.timestamp)
        });
    }

    function _signCheckIn(SafetyGate.CheckIn memory c, uint256 pk) internal view returns (bytes memory) {
        return _sign(
            pk,
            keccak256(
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
            )
        );
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
        gate.revokeSigner(role, device);

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

    function test_checkIn_backdatedOneDayRejected() public {
        SafetyGate.CheckIn memory c = _checkIn(_nonce(), true, true, true);
        c.timestamp = uint64(block.timestamp - 1 days); // "어제 점검했다"고 지금 기록
        bytes memory sig = _signCheckIn(c, devicePk);
        vm.expectRevert(
            abi.encodeWithSelector(SafetyGate.StaleTimestamp.selector, c.timestamp, uint64(block.timestamp))
        );
        gate.submitCheckIn(c, sig);
    }

    function test_checkIn_futureTimestampRejected() public {
        SafetyGate.CheckIn memory c = _checkIn(_nonce(), true, true, true);
        c.timestamp = uint64(block.timestamp + 5 minutes);
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
}
