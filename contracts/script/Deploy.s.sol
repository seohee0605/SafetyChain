// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {SafetyGate} from "../src/SafetyGate.sol";

/// @notice Deploys SafetyGate with the broadcaster as admin, then registers
/// DEVICE_ADDRESS (the gate simulator's signing key) and ADMIN_SIGNER_ADDRESSES
/// (named 안전관리자 signing keys, comma-separated) so they can submit records.
contract DeployScript is Script {
    function run() external returns (SafetyGate gate) {
        address device = vm.envAddress("DEVICE_ADDRESS");
        address[] memory adminSigners = vm.envAddress("ADMIN_SIGNER_ADDRESSES", ",");

        vm.startBroadcast();
        gate = new SafetyGate(msg.sender);
        gate.registerDevice(device);
        for (uint256 i = 0; i < adminSigners.length; i++) {
            gate.registerDevice(adminSigners[i]);
        }
        vm.stopBroadcast();

        console.log("SafetyGate deployed at:", address(gate));
        console.log("Registered device:", device);
        for (uint256 i = 0; i < adminSigners.length; i++) {
            console.log("Registered admin signer:", adminSigners[i]);
        }
    }
}
