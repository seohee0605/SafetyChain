// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SafetyGate} from "../src/SafetyGate.sol";

contract SafetyGateTest is Test {
    SafetyGate gate;

    address admin = makeAddr("admin");
    uint256 devicePk = 0xA11CE;
    address device;
    uint256 otherDevicePk = 0xB0B;
    address otherDevice;

    bytes32 constant SITE_ID = keccak256("site-1");
    bytes32 constant CASE_ID = keccak256("site-1|2026-09-10");
    bytes32 constant MODEL_HASH = keccak256("yolo-v8n-weights");

    bytes32 constant CHECKIN_TYPEHASH = keccak256(
        "CheckIn(bytes32 caseId,bytes32 workerId,bytes32 siteId,bool helmetPass,bool shoesPass,bool alcoholPass,bytes32 modelHash,bytes32 nonce,uint64 timestamp)"
    );

    bytes32 constant SITE_RECORD_TYPEHASH = keccak256(
        "SiteRecord(bytes32 caseId,bytes32 siteId,bytes32 recordHash,bool hazardsControlled,bytes32 nonce,uint64 timestamp)"
    );

    bytes32 constant CASE_REVIEW_TYPEHASH = keccak256(
        "CaseReview(bytes32 caseId,bytes32 reviewScopeHash,bool reviewResult,bytes32 nonce,uint64 timestamp)"
    );

    function setUp() public {
        device = vm.addr(devicePk);
        otherDevice = vm.addr(otherDevicePk);

        vm.prank(admin);
        gate = new SafetyGate(admin);
    }

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("SafetyChain")),
                keccak256(bytes("1")),
                block.chainid,
                address(gate)
            )
        );
    }

    function _signCheckIn(SafetyGate.CheckIn memory c, uint256 pk) internal view returns (bytes memory) {
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
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _sampleCheckIn(bytes32 nonce) internal view returns (SafetyGate.CheckIn memory) {
        return SafetyGate.CheckIn({
            caseId: CASE_ID,
            workerId: keccak256("worker-1"),
            siteId: SITE_ID,
            helmetPass: true,
            shoesPass: true,
            alcoholPass: true,
            modelHash: MODEL_HASH,
            nonce: nonce,
            timestamp: uint64(block.timestamp)
        });
    }

    function _signSiteRecord(SafetyGate.SiteRecord memory r, uint256 pk) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                SITE_RECORD_TYPEHASH, r.caseId, r.siteId, r.recordHash, r.hazardsControlled, r.nonce, r.timestamp
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(rr, s, v);
    }

    function _sampleSiteRecord(bytes32 nonce) internal view returns (SafetyGate.SiteRecord memory) {
        return SafetyGate.SiteRecord({
            caseId: CASE_ID,
            siteId: SITE_ID,
            recordHash: keccak256("daily-risk-assessment-doc"),
            hazardsControlled: true,
            nonce: nonce,
            timestamp: uint64(block.timestamp)
        });
    }

    function _signCaseReview(SafetyGate.CaseReview memory r, uint256 pk) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(CASE_REVIEW_TYPEHASH, r.caseId, r.reviewScopeHash, r.reviewResult, r.nonce, r.timestamp)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        (uint8 v, bytes32 rr, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(rr, s, v);
    }

    function _sampleCaseReview(bytes32 nonce) internal view returns (SafetyGate.CaseReview memory) {
        return SafetyGate.CaseReview({
            caseId: CASE_ID,
            reviewScopeHash: keccak256("reviewed-checkins-and-siterecords"),
            reviewResult: true,
            nonce: nonce,
            timestamp: uint64(block.timestamp)
        });
    }

    // ---- registerDevice / revokeDevice ----

    function test_adminCanRegisterDevice() public {
        vm.prank(admin);
        gate.registerDevice(device);
        assertTrue(gate.isNonceUsed(bytes32(0)) == false); // sanity: fresh state
    }

    function test_nonAdminCannotRegisterDevice() public {
        vm.prank(device);
        vm.expectRevert();
        gate.registerDevice(device);
    }

    function test_adminCanRevokeDevice() public {
        vm.startPrank(admin);
        gate.registerDevice(device);
        gate.revokeDevice(device);
        vm.stopPrank();

        SafetyGate.CheckIn memory c = _sampleCheckIn(keccak256("nonce-revoked"));
        bytes memory sig = _signCheckIn(c, devicePk);

        vm.expectRevert();
        gate.submitCheckIn(c, sig);
    }

    // ---- submitCheckIn happy path ----

    function test_submitCheckIn_success() public {
        vm.prank(admin);
        gate.registerDevice(device);

        SafetyGate.CheckIn memory c = _sampleCheckIn(keccak256("nonce-1"));
        bytes memory sig = _signCheckIn(c, devicePk);

        vm.expectEmit(true, true, false, true);
        emit SafetyGate.CheckInRecorded(c.siteId, c.workerId, 0, true, device);

        gate.submitCheckIn(c, sig);

        assertTrue(gate.isNonceUsed(c.nonce));

        SafetyGate.CheckIn[] memory checkIns = gate.getCheckIns(SITE_ID, 0, 1);
        assertEq(checkIns.length, 1);
        assertEq(checkIns[0].workerId, c.workerId);
        assertEq(checkIns[0].caseId, CASE_ID);
        assertEq(checkIns[0].nonce, c.nonce);
    }

    function test_submitCheckIn_allPassedFalse_whenAnyCheckFails() public {
        vm.prank(admin);
        gate.registerDevice(device);

        SafetyGate.CheckIn memory c = _sampleCheckIn(keccak256("nonce-fail"));
        c.helmetPass = false;
        bytes memory sig = _signCheckIn(c, devicePk);

        vm.expectEmit(true, true, false, true);
        emit SafetyGate.CheckInRecorded(c.siteId, c.workerId, 0, false, device);

        gate.submitCheckIn(c, sig);
    }

    // ---- replay protection ----

    function test_submitCheckIn_revertsOnReusedNonce() public {
        vm.prank(admin);
        gate.registerDevice(device);

        SafetyGate.CheckIn memory c = _sampleCheckIn(keccak256("nonce-replay"));
        bytes memory sig = _signCheckIn(c, devicePk);

        gate.submitCheckIn(c, sig);

        vm.expectRevert();
        gate.submitCheckIn(c, sig);
    }

    // ---- device attestation ----

    function test_submitCheckIn_revertsOnUnregisteredDevice() public {
        SafetyGate.CheckIn memory c = _sampleCheckIn(keccak256("nonce-unreg"));
        bytes memory sig = _signCheckIn(c, otherDevicePk);

        vm.expectRevert();
        gate.submitCheckIn(c, sig);
    }

    function test_submitCheckIn_revertsOnTamperedPayload() public {
        vm.prank(admin);
        gate.registerDevice(device);

        SafetyGate.CheckIn memory c = _sampleCheckIn(keccak256("nonce-tamper"));
        bytes memory sig = _signCheckIn(c, devicePk);

        c.helmetPass = false; // tamper after signing

        vm.expectRevert();
        gate.submitCheckIn(c, sig);
    }

    // ---- view helpers ----

    function test_isNonceUsed_falseInitially() public view {
        assertFalse(gate.isNonceUsed(keccak256("never-used")));
    }

    function test_getCheckIns_rangeAcrossMultipleSites() public {
        vm.prank(admin);
        gate.registerDevice(device);

        SafetyGate.CheckIn memory c1 = _sampleCheckIn(keccak256("nonce-a"));
        gate.submitCheckIn(c1, _signCheckIn(c1, devicePk));

        SafetyGate.CheckIn memory c2 = _sampleCheckIn(keccak256("nonce-b"));
        gate.submitCheckIn(c2, _signCheckIn(c2, devicePk));

        SafetyGate.CheckIn[] memory checkIns = gate.getCheckIns(SITE_ID, 0, 2);
        assertEq(checkIns.length, 2);
        assertEq(checkIns[0].nonce, c1.nonce);
        assertEq(checkIns[1].nonce, c2.nonce);
    }

    // ---- submitSiteRecord ----

    function test_submitSiteRecord_success() public {
        vm.prank(admin);
        gate.registerDevice(device);

        SafetyGate.SiteRecord memory r = _sampleSiteRecord(keccak256("site-record-nonce-1"));
        bytes memory sig = _signSiteRecord(r, devicePk);

        vm.expectEmit(true, false, false, true);
        emit SafetyGate.SiteRecordSubmitted(r.siteId, 0, true, device);

        gate.submitSiteRecord(r, sig);

        assertTrue(gate.isNonceUsed(r.nonce));

        SafetyGate.SiteRecord[] memory records = gate.getSiteRecords(SITE_ID, 0, 1);
        assertEq(records.length, 1);
        assertEq(records[0].recordHash, r.recordHash);
        assertEq(records[0].caseId, CASE_ID);
        assertEq(records[0].hazardsControlled, true);
    }

    function test_submitSiteRecord_revertsOnReusedNonce() public {
        vm.prank(admin);
        gate.registerDevice(device);

        SafetyGate.SiteRecord memory r = _sampleSiteRecord(keccak256("site-record-nonce-replay"));
        bytes memory sig = _signSiteRecord(r, devicePk);

        gate.submitSiteRecord(r, sig);

        vm.expectRevert();
        gate.submitSiteRecord(r, sig);
    }

    function test_submitSiteRecord_and_submitCheckIn_shareNoncePool() public {
        vm.prank(admin);
        gate.registerDevice(device);

        bytes32 sharedNonce = keccak256("shared-nonce");

        SafetyGate.CheckIn memory c = _sampleCheckIn(sharedNonce);
        gate.submitCheckIn(c, _signCheckIn(c, devicePk));

        SafetyGate.SiteRecord memory r = _sampleSiteRecord(sharedNonce);
        vm.expectRevert();
        gate.submitSiteRecord(r, _signSiteRecord(r, devicePk));
    }

    function test_submitSiteRecord_revertsOnUnregisteredDevice() public {
        SafetyGate.SiteRecord memory r = _sampleSiteRecord(keccak256("site-record-nonce-unreg"));
        bytes memory sig = _signSiteRecord(r, otherDevicePk);

        vm.expectRevert();
        gate.submitSiteRecord(r, sig);
    }

    function test_submitSiteRecord_revertsOnTamperedPayload() public {
        vm.prank(admin);
        gate.registerDevice(device);

        SafetyGate.SiteRecord memory r = _sampleSiteRecord(keccak256("site-record-nonce-tamper"));
        bytes memory sig = _signSiteRecord(r, devicePk);

        r.hazardsControlled = false; // tamper after signing

        vm.expectRevert();
        gate.submitSiteRecord(r, sig);
    }

    function test_getSiteRecords_rangeAcrossMultiple() public {
        vm.prank(admin);
        gate.registerDevice(device);

        SafetyGate.SiteRecord memory r1 = _sampleSiteRecord(keccak256("site-record-a"));
        gate.submitSiteRecord(r1, _signSiteRecord(r1, devicePk));

        SafetyGate.SiteRecord memory r2 = _sampleSiteRecord(keccak256("site-record-b"));
        gate.submitSiteRecord(r2, _signSiteRecord(r2, devicePk));

        SafetyGate.SiteRecord[] memory records = gate.getSiteRecords(SITE_ID, 0, 2);
        assertEq(records.length, 2);
        assertEq(records[0].nonce, r1.nonce);
        assertEq(records[1].nonce, r2.nonce);
    }

    // ---- submitCaseReview (감독자 최종 서명) ----

    function test_submitCaseReview_success() public {
        vm.prank(admin);
        gate.registerDevice(device);

        SafetyGate.CaseReview memory r = _sampleCaseReview(keccak256("case-review-nonce-1"));
        bytes memory sig = _signCaseReview(r, devicePk);

        vm.expectEmit(true, false, false, true);
        emit SafetyGate.CaseReviewSubmitted(r.caseId, 0, true, device);

        gate.submitCaseReview(r, sig);

        assertTrue(gate.isNonceUsed(r.nonce));

        SafetyGate.CaseReview[] memory reviews = gate.getCaseReviews(CASE_ID, 0, 1);
        assertEq(reviews.length, 1);
        assertEq(reviews[0].reviewScopeHash, r.reviewScopeHash);
        assertEq(reviews[0].reviewResult, true);
    }

    function test_submitCaseReview_revertsOnReusedNonce() public {
        vm.prank(admin);
        gate.registerDevice(device);

        SafetyGate.CaseReview memory r = _sampleCaseReview(keccak256("case-review-nonce-replay"));
        bytes memory sig = _signCaseReview(r, devicePk);

        gate.submitCaseReview(r, sig);

        vm.expectRevert();
        gate.submitCaseReview(r, sig);
    }

    function test_submitCaseReview_sharesNoncePoolWithOthers() public {
        vm.prank(admin);
        gate.registerDevice(device);

        bytes32 sharedNonce = keccak256("shared-nonce-review");

        SafetyGate.SiteRecord memory sr = _sampleSiteRecord(sharedNonce);
        gate.submitSiteRecord(sr, _signSiteRecord(sr, devicePk));

        SafetyGate.CaseReview memory r = _sampleCaseReview(sharedNonce);
        vm.expectRevert();
        gate.submitCaseReview(r, _signCaseReview(r, devicePk));
    }

    function test_submitCaseReview_revertsOnUnregisteredDevice() public {
        SafetyGate.CaseReview memory r = _sampleCaseReview(keccak256("case-review-nonce-unreg"));
        bytes memory sig = _signCaseReview(r, otherDevicePk);

        vm.expectRevert();
        gate.submitCaseReview(r, sig);
    }

    function test_submitCaseReview_revertsOnTamperedPayload() public {
        vm.prank(admin);
        gate.registerDevice(device);

        SafetyGate.CaseReview memory r = _sampleCaseReview(keccak256("case-review-nonce-tamper"));
        bytes memory sig = _signCaseReview(r, devicePk);

        r.reviewResult = false; // tamper after signing

        vm.expectRevert();
        gate.submitCaseReview(r, sig);
    }

    function test_getCaseReviews_rangeAcrossMultiple() public {
        vm.prank(admin);
        gate.registerDevice(device);

        SafetyGate.CaseReview memory r1 = _sampleCaseReview(keccak256("case-review-a"));
        gate.submitCaseReview(r1, _signCaseReview(r1, devicePk));

        SafetyGate.CaseReview memory r2 = _sampleCaseReview(keccak256("case-review-b"));
        gate.submitCaseReview(r2, _signCaseReview(r2, devicePk));

        SafetyGate.CaseReview[] memory reviews = gate.getCaseReviews(CASE_ID, 0, 2);
        assertEq(reviews.length, 2);
        assertEq(reviews[0].nonce, r1.nonce);
        assertEq(reviews[1].nonce, r2.nonce);
    }
}
