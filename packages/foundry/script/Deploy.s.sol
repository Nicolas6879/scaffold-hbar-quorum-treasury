//SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { ScaffoldETHDeploy } from "./DeployHelpers.s.sol";
import { SwapGuard } from "../contracts/SwapGuard.sol";
import { IAggregatorV3 } from "../contracts/interfaces/IAggregatorV3.sol";
import { ISaucerSwapV1Router } from "../contracts/interfaces/ISaucerSwapV1Router.sol";

/**
 * @notice Deploys SwapGuard wired to SaucerSwap V1 and Chainlink HBAR/USD on Hedera testnet.
 *   yarn foundry:deploy --network hedera_testnet
 * Every address can be overridden with an env var for mainnet or another pool.
 */
contract DeployScript is ScaffoldETHDeploy {
    function run() external ScaffoldEthDeployerRunner {
        SwapGuard guard = new SwapGuard(
            ISaucerSwapV1Router(vm.envOr("SAUCERSWAP_V1_ROUTER", address(0x0000000000000000000000000000000000004b40))),
            IAggregatorV3(vm.envOr("CHAINLINK_HBAR_USD", address(0x59bC155EB6c6C415fE43255aF66EcF0523c92B4a))),
            vm.envOr("WHBAR_TOKEN", address(0x0000000000000000000000000000000000003aD2)),
            vm.envOr("STABLE_TOKEN", address(0x0000000000000000000000000000000000001549)),
            uint8(vm.envOr("STABLE_DECIMALS", uint256(6))),
            vm.envOr("MAX_PRICE_AGE", uint256(6 hours)),
            uint16(vm.envOr("BAND_BPS", uint256(300)))
        );
        deployments.push(Deployment({ name: "SwapGuard", addr: address(guard) }));
    }
}
