// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { Test } from "forge-std/Test.sol";
import { SwapGuard } from "../contracts/SwapGuard.sol";
import { IAggregatorV3 } from "../contracts/interfaces/IAggregatorV3.sol";
import { ISaucerSwapV1Router } from "../contracts/interfaces/ISaucerSwapV1Router.sol";
import { MockAggregator, MockRouter, MockStable } from "./mocks/Mocks.sol";

contract SwapGuardTest is Test {
    // HBAR = $0.10 with an 8-decimal feed; 1 HBAR = 1e8 tinybar; USDC has 6 decimals.
    int256 internal constant PRICE = 10_000_000;
    uint256 internal constant ONE_HBAR = 1e8;
    uint256 internal constant MAX_AGE = 6 hours;
    uint16 internal constant BAND = 300; // 3 %
    address internal constant WHBAR = address(0x3ad2);

    MockAggregator internal feed;
    MockStable internal usdc;
    MockRouter internal router;
    SwapGuard internal guard;
    address internal treasury = makeAddr("treasury");

    function setUp() public {
        vm.warp(1_800_000_000);
        feed = new MockAggregator(8, PRICE, block.timestamp);
        usdc = new MockStable(6);
        // Pool at exactly the oracle price: 1e8 tinybar -> 100_000 (0.10 USDC).
        router = new MockRouter(usdc, 1, 1000);
        guard = _guard(BAND);
        vm.deal(treasury, 1_000 * ONE_HBAR);
    }

    function _guard(uint16 band) internal returns (SwapGuard) {
        return new SwapGuard(
            ISaucerSwapV1Router(address(router)), IAggregatorV3(address(feed)), WHBAR, address(usdc), 6, MAX_AGE, band
        );
    }

    function _swap(uint256 value, uint16 slippage) internal returns (uint256) {
        vm.prank(treasury);
        return guard.swapHbarForStable{ value: value }(slippage, block.timestamp + 1 hours);
    }

    // ------------------------------------------------------------------ happy path

    function test_SwapAtOraclePrice_SendsStableToCaller() public {
        uint256 out = _swap(100 * ONE_HBAR, 50);
        assertEq(out, 10_000_000, "100 HBAR at $0.10 = 10 USDC");
        assertEq(usdc.balanceOf(treasury), 10_000_000);
        assertEq(router.lastTo(), treasury, "output must go to msg.sender, never a caller-chosen recipient");
    }

    function test_AmountOutMinIsDerivedFromOracle() public {
        _swap(100 * ONE_HBAR, 50);
        assertEq(router.lastAmountOutMin(), (10_000_000 * 9950) / 10_000);
    }

    function test_ForwardsExactValueInTinybar() public {
        _swap(7 * ONE_HBAR, 100);
        assertEq(router.lastValue(), 7 * ONE_HBAR);
        assertEq(address(guard).balance, 0, "guard never keeps HBAR");
    }

    function test_EmitsGuardedSwap() public {
        vm.expectEmit(true, false, false, true, address(guard));
        emit SwapGuard.GuardedSwap(treasury, 100 * ONE_HBAR, 10_000_000, 10_000_000, 10_000_000, 1, PRICE);
        _swap(100 * ONE_HBAR, 50);
    }

    function test_PassesDeadlineThroughToRouter() public {
        vm.prank(treasury);
        guard.swapHbarForStable{ value: ONE_HBAR }(50, block.timestamp + 123);
        assertEq(router.lastDeadline(), block.timestamp + 123);
    }

    // ------------------------------------------------------------------ input validation

    function test_RevertsOnZeroValue() public {
        vm.expectRevert(SwapGuard.ZeroValue.selector);
        _swap(0, 50);
    }

    function test_RevertsAfterDeadline() public {
        vm.prank(treasury);
        vm.expectRevert(abi.encodeWithSelector(SwapGuard.DeadlinePassed.selector, block.timestamp - 1, block.timestamp));
        guard.swapHbarForStable{ value: ONE_HBAR }(50, block.timestamp - 1);
    }

    function test_SlippageBelowPoolFeeIsRejected() public {
        vm.expectRevert(abi.encodeWithSelector(SwapGuard.SlippageOutOfRange.selector, uint16(29)));
        _swap(ONE_HBAR, 29);
    }

    function test_SlippageAboveCapIsRejected() public {
        vm.expectRevert(abi.encodeWithSelector(SwapGuard.SlippageOutOfRange.selector, uint16(1001)));
        _swap(ONE_HBAR, 1001);
    }

    function test_SlippageBoundsAreInclusive() public {
        _swap(ONE_HBAR, 30);
        _swap(ONE_HBAR, 1000);
    }

    // ------------------------------------------------------------------ oracle checks

    function test_RevertsOnZeroPrice() public {
        feed.set(0, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(SwapGuard.BadPrice.selector, int256(0)));
        _swap(ONE_HBAR, 50);
    }

    function test_RevertsOnNegativePrice() public {
        feed.set(-1, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(SwapGuard.BadPrice.selector, int256(-1)));
        _swap(ONE_HBAR, 50);
    }

    function test_RevertsOnStalePrice() public {
        uint256 updated = block.timestamp - MAX_AGE - 1;
        feed.set(PRICE, updated);
        vm.expectRevert(abi.encodeWithSelector(SwapGuard.StalePrice.selector, updated, block.timestamp));
        _swap(ONE_HBAR, 50);
    }

    function test_PriceExactlyAtMaxAgeIsAccepted() public {
        feed.set(PRICE, block.timestamp - MAX_AGE);
        _swap(ONE_HBAR, 50);
    }

    function test_RevertsOnPriceFromTheFuture() public {
        feed.set(PRICE, block.timestamp + 1);
        vm.expectRevert(abi.encodeWithSelector(SwapGuard.StalePrice.selector, block.timestamp + 1, block.timestamp));
        _swap(ONE_HBAR, 50);
    }

    // ------------------------------------------------------------------ pool band

    /// @dev The real SaucerSwap testnet WHBAR/USDC pool quoted ~22x the oracle price on 2026-10-03.
    function test_RejectsPoolFarAboveOracle() public {
        router.setRate(22, 1000);
        vm.expectRevert(abi.encodeWithSelector(SwapGuard.PoolPriceOutOfBand.selector, 10_000_000, 220_000_000));
        _swap(100 * ONE_HBAR, 50);
    }

    function test_RejectsPoolBelowOracle() public {
        router.setRate(9, 10_000); // 10 % below
        vm.expectRevert(abi.encodeWithSelector(SwapGuard.PoolPriceOutOfBand.selector, 10_000_000, 9_000_000));
        _swap(100 * ONE_HBAR, 50);
    }

    function test_BandEdgesAreInclusive() public {
        router.setRate(103, 100_000); // +3 %
        _swap(100 * ONE_HBAR, 50);
        router.setRate(97, 100_000); // -3 %
        _swap(100 * ONE_HBAR, 400);
    }

    function test_RevertsIfPoolDeliversLessThanOracleMinimum() public {
        // Quote is in band but the fill is worse (price moved between quote and swap).
        router.setDeliverBps(9_900);
        vm.expectRevert(bytes("UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT"));
        _swap(100 * ONE_HBAR, 50);
    }

    function test_Preview_ReportsOutOfBandWithoutReverting() public {
        router.setRate(22, 1000);
        (uint256 oracleOut, uint256 poolQuote, bool inBand) = guard.preview(100 * ONE_HBAR);
        assertEq(oracleOut, 10_000_000);
        assertEq(poolQuote, 220_000_000);
        assertFalse(inBand);
    }

    // ------------------------------------------------------------------ math and config

    function test_QuoteFromOracle_DecimalMatrix() public {
        assertEq(guard.quoteFromOracle(ONE_HBAR, PRICE), 100_000, "8-dec feed, 6-dec stable");
        MockAggregator feed18 = new MockAggregator(18, 1e17, block.timestamp);
        SwapGuard g18 = new SwapGuard(
            ISaucerSwapV1Router(address(router)),
            IAggregatorV3(address(feed18)),
            WHBAR,
            address(usdc),
            18,
            MAX_AGE,
            BAND
        );
        assertEq(g18.quoteFromOracle(ONE_HBAR, 1e17), 1e17, "18-dec feed, 18-dec stable");
    }

    function test_ConstructorRejectsInvalidConfig() public {
        ISaucerSwapV1Router r = ISaucerSwapV1Router(address(router));
        IAggregatorV3 f = IAggregatorV3(address(feed));
        vm.expectRevert(SwapGuard.InvalidConfig.selector);
        new SwapGuard(ISaucerSwapV1Router(address(0)), f, WHBAR, address(usdc), 6, MAX_AGE, BAND);
        vm.expectRevert(SwapGuard.InvalidConfig.selector);
        new SwapGuard(r, f, WHBAR, WHBAR, 6, MAX_AGE, BAND);
        vm.expectRevert(SwapGuard.InvalidConfig.selector);
        new SwapGuard(r, f, WHBAR, address(usdc), 6, 0, BAND);
        vm.expectRevert(SwapGuard.InvalidConfig.selector);
        new SwapGuard(r, f, WHBAR, address(usdc), 6, MAX_AGE, 0);
        vm.expectRevert(SwapGuard.InvalidConfig.selector);
        new SwapGuard(r, f, WHBAR, address(usdc), 6, MAX_AGE, 10_000);
    }

    function test_ReadsFeedDecimalsAtDeploy() public view {
        assertEq(guard.feedDecimals(), 8);
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_OracleQuoteIsLinear(uint64 tinybar) public view {
        vm.assume(tinybar > 0);
        assertEq(guard.quoteFromOracle(uint256(tinybar) * 2, PRICE) / 2, guard.quoteFromOracle(tinybar, PRICE));
    }

    function testFuzz_RejectsAnyPoolOutsideBand(uint32 rateNum) public {
        uint256 oracleOut = 10_000_000; // 100 HBAR
        uint256 poolOut = (100 * ONE_HBAR * uint256(rateNum)) / 1e9;
        vm.assume(poolOut < (oracleOut * 9700) / 10_000 || poolOut > (oracleOut * 10_300) / 10_000);
        router.setRate(rateNum, 1e9);
        vm.expectRevert();
        _swap(100 * ONE_HBAR, 50);
    }

    function testFuzz_NeverHoldsHbar(uint64 value) public {
        vm.assume(value > 0 && value < 1_000 * ONE_HBAR);
        _swap(value, 50);
        assertEq(address(guard).balance, 0);
    }
}
