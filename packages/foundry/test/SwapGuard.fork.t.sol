// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { Test } from "forge-std/Test.sol";
import { SwapGuard } from "../contracts/SwapGuard.sol";
import { IAggregatorV3 } from "../contracts/interfaces/IAggregatorV3.sol";
import { ISaucerSwapV1Router } from "../contracts/interfaces/ISaucerSwapV1Router.sol";

/**
 * Opt-in test against the real Hedera testnet contracts (SaucerSwap V1 RouterV3 and Chainlink HBAR/USD).
 *   FORK=1 forge test --match-contract SwapGuardForkTest --fork-url https://testnet.hashio.io/api
 * Skipped by default so CI stays deterministic.
 */
contract SwapGuardForkTest is Test {
    ISaucerSwapV1Router internal constant ROUTER = ISaucerSwapV1Router(0x0000000000000000000000000000000000004b40);
    IAggregatorV3 internal constant FEED = IAggregatorV3(0x59bC155EB6c6C415fE43255aF66EcF0523c92B4a);
    address internal constant WHBAR = 0x0000000000000000000000000000000000003aD2;
    address internal constant USDC = 0x0000000000000000000000000000000000001549; // 0.0.5449

    function setUp() public {
        if (!vm.envOr("FORK", false)) vm.skip(true);
    }

    function test_Fork_ReadsLiveChainlinkPrice() public view {
        (, int256 answer,, uint256 updatedAt,) = FEED.latestRoundData();
        assertGt(answer, 0);
        assertGt(updatedAt, 0);
        assertEq(FEED.decimals(), 8);
    }

    /// @notice Documents the public pool's price relative to the oracle; the guard must refuse it if out of band.
    function test_Fork_PreviewAgainstPublicPool() public {
        SwapGuard guard = new SwapGuard(ROUTER, FEED, WHBAR, USDC, 6, 7 days, 300);
        (uint256 oracleOut, uint256 poolQuote, bool inBand) = guard.preview(100e8);
        emit log_named_uint("oracle USDC for 100 HBAR", oracleOut);
        emit log_named_uint("pool USDC for 100 HBAR", poolQuote);
        if (!inBand) {
            vm.deal(address(this), 100e8);
            vm.expectRevert();
            guard.swapHbarForStable{ value: 100e8 }(50, block.timestamp + 1 hours);
        }
    }
}
