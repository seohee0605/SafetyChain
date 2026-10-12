// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {SafetyGate} from "../src/SafetyGate.sol";

/// @notice SafetyGate 배포 + 초기 서명자 등록.
///
/// 브로드캐스터(= 백엔드 릴레이 계정)가 시공사 운영 관리자가 된다.
/// 서명자 등록은 "시공사 제안 → 감리 승인" 2단계라서, 데모 배포에서는 감리 키로 승인 서명까지 만든다.
///
/// 필요한 환경변수
///   DEVICE_ADDRESS            게이트 기기 서명 주소
///   ADMIN_SIGNER_ADDRESSES    시공사 감독자(안전관리자) 서명 주소들, 콤마 구분
///   INSPECTOR_PRIVATE_KEY     감리 서명 키 (등록 승인 서명용)
///   OWNER_ADDRESS             발주처 서명 주소
contract DeployScript is Script {
    function run() external returns (SafetyGate gate) {
        address device = vm.envAddress("DEVICE_ADDRESS");
        address[] memory supervisors = vm.envAddress("ADMIN_SIGNER_ADDRESSES", ",");
        uint256 inspectorPk = vm.envUint("INSPECTOR_PRIVATE_KEY");
        address owner = vm.envAddress("OWNER_ADDRESS");

        vm.startBroadcast();
        gate = new SafetyGate(msg.sender, vm.addr(inspectorPk), owner);

        _proposeAndApprove(gate, gate.GATE_DEVICE_ROLE(), device, inspectorPk);
        for (uint256 i = 0; i < supervisors.length; i++) {
            _proposeAndApprove(gate, gate.SUPERVISOR_ROLE(), supervisors[i], inspectorPk);
        }
        vm.stopBroadcast();

        console.log("SafetyGate deployed at:", address(gate));
        console.log("Inspector:", vm.addr(inspectorPk));
        console.log("Owner:", owner);
        console.log("Gate device:", device);
        for (uint256 i = 0; i < supervisors.length; i++) {
            console.log("Supervisor:", supervisors[i]);
        }
    }

    function _proposeAndApprove(SafetyGate gate, bytes32 role, address account, uint256 approverPk) internal {
        uint256 id = gate.proposeSigner(role, account);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(approverPk, gate.signerApprovalDigest(id));
        gate.approveSigner(id, abi.encodePacked(r, s, v));
    }
}
