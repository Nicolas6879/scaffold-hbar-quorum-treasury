// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { Test } from "forge-std/Test.sol";
import { SwapGuard } from "../contracts/SwapGuard.sol";
import { IAggregatorV3 } from "../contracts/interfaces/IAggregatorV3.sol";
import { ISaucerSwapV1Router } from "../contracts/interfaces/ISaucerSwapV1Router.sol";
import { MockAggregator, MockRouter, MockStable } from "./mocks/Mocks.sol";

/// @notice Drives the guard with random swaps, prices and pool rates.
contract GuardHandler is Test {
    SwapGuard internal guard;
    MockAggregator internal feed;
    MockRouter internal router;
    uint256 public swaps;

    constructor(SwapGuard guard_, MockAggregator feed_, MockRouter router_) {
        guard = guard_;
        feed = feed_;
        router = router_;
    }

    function swap(uint64 value, uint16 slippage) external {
        value = uint64(bound(value, 1, 1e12));
        slippage = uint16(bound(slippage, 30, 1000));
        vm.deal(address(this), value);
        try guard.swapHbarForStable{ value: value }(slippage, block.timestamp + 1) {
            swaps++;
        } catch { }
    }

    function movePrice(int64 answer, uint32 age) external {
        feed.set(int256(answer), block.timestamp - bound(age, 0, 12 hours));
    }

    function movePool(uint32 rateNum) external {
        router.setRate(bound(rateNum, 1, 1e6), 1e9);
    }

    function warp(uint32 secondsAhead) external {
        vm.warp(block.timestamp + bound(secondsAhead, 0, 1 hours));
    }
}

contract SwapGuardInvariantTest is Test {
    SwapGuard internal guard;
    GuardHandler internal handler;

    function setUp() public {
        vm.warp(1_800_000_000);
        MockAggregator feed = new MockAggregator(8, 10_000_000, block.timestamp);
        MockStable usdc = new MockStable(6);
        MockRouter router = new MockRouter(usdc, 1, 1000);
        guard = new SwapGuard(
            ISaucerSwapV1Router(address(router)), IAggregatorV3(address(feed)), address(0x3ad2), address(usdc), 6, 6 hours, 300
        );
        handler = new GuardHandler(guard, feed, router);
        targetContract(address(handler));
    }

    /// @notice The guard is non-custodial: whatever happens, it never ends a transaction holding HBAR.
    function invariant_GuardHoldsNoHbar() public view {
        assertEq(address(guard).balance, 0);
    }
}
