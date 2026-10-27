// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {SafetyGate} from "../src/SafetyGate.sol";

// 배포 + 초기 서명자(게이트 기기·감독자) 등록 "제안".
// env: DEVICE_ADDRESS, ADMIN_SIGNER_ADDRESSES(콤마), OWNER_ADDRESS, 그리고 아래 둘 중 하나
//   - INSPECTOR_ADDRESS     : 감리 지갑 주소만 넘긴다 (권장). 등록 승인은 배포 후 감리가 감리 화면에서 지갑으로 서명한다.
//   - INSPECTOR_PRIVATE_KEY : 예전 방식. 스크립트가 감리 키로 승인 서명까지 한다 (로컬 테스트·백업용).
contract DeployScript is Script {
    function run() external returns (SafetyGate gate) {
        address device = vm.envAddress("DEVICE_ADDRESS");
        address[] memory supervisors = vm.envAddress("ADMIN_SIGNER_ADDRESSES", ",");
        address owner = vm.envAddress("OWNER_ADDRESS");
        uint256 inspectorPk = vm.envOr("INSPECTOR_PRIVATE_KEY", uint256(0));
        address inspector = inspectorPk != 0 ? vm.addr(inspectorPk) : vm.envAddress("INSPECTOR_ADDRESS");

        vm.startBroadcast();
        gate = new SafetyGate(msg.sender, inspector, owner);

        _propose(gate, gate.GATE_DEVICE_ROLE(), device, inspectorPk);
        for (uint256 i = 0; i < supervisors.length; i++) {
            _propose(gate, gate.SUPERVISOR_ROLE(), supervisors[i], inspectorPk);
        }
        vm.stopBroadcast();

        console.log("SafetyGate deployed at:", address(gate));
        console.log("Inspector:", inspector);
        console.log("Owner:", owner);
        console.log("Gate device:", device);
        for (uint256 i = 0; i < supervisors.length; i++) {
            console.log("Supervisor:", supervisors[i]);
        }
        if (inspectorPk == 0) {
            console.log("Signer proposals are PENDING. Approve them with the inspector/owner wallet in the audit screen.");
        }
    }

    function _propose(SafetyGate gate, bytes32 role, address account, uint256 approverPk) internal {
        uint256 id = gate.proposeSigner(role, account);
        if (approverPk == 0) return; // 감리·발주처가 지갑으로 승인
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(approverPk, gate.signerApprovalDigest(id));
        gate.approveSigner(id, abi.encodePacked(r, s, v));
    }
}
