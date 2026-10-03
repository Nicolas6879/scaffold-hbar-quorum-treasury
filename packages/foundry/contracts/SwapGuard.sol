// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { IAggregatorV3 } from "./interfaces/IAggregatorV3.sol";
import { ISaucerSwapV1Router } from "./interfaces/ISaucerSwapV1Router.sol";

/**
 * @title SwapGuard
 * @notice Swaps HBAR for a USD stablecoin on SaucerSwap V1 only if the pool agrees with Chainlink.
 *
 * A treasury proposal calls this contract (through a scheduled ContractCall paid by the treasury)
 * instead of calling the router directly. Before swapping, the guard:
 *   1. reads Chainlink HBAR/USD and refuses non-positive or stale prices;
 *   2. computes the stablecoin amount the oracle says `msg.value` is worth (stable assumed = $1);
 *   3. asks the pool for its quote and refuses if it is outside +/- `bandBps` of the oracle value —
 *      a pool far *above* the oracle is as suspicious as one below (broken or manipulated liquidity);
 *   4. swaps with `amountOutMin` derived on-chain from the oracle, and sends the output to `msg.sender`.
 *
 * The guard holds no funds and no state besides immutables. Units: on Hedera `msg.value` inside the
 * EVM is tinybar (8 decimals), not weibar.
 */
contract SwapGuard {
    /// @notice HBAR has 8 decimals inside the Hedera EVM (tinybar).
    uint256 private constant HBAR_DECIMALS = 8;
    uint256 private constant BPS = 10_000;
    /// @notice SaucerSwap V1 charges 0.3 %; a slippage below this can never fill.
    uint16 public constant MIN_SLIPPAGE_BPS = 30;
    /// @notice Upper bound so a caller cannot turn the guard into a no-op.
    uint16 public constant MAX_SLIPPAGE_BPS = 1_000;

    ISaucerSwapV1Router public immutable router;
    IAggregatorV3 public immutable priceFeed;
    address public immutable whbar;
    address public immutable stable;
    uint8 public immutable stableDecimals;
    uint8 public immutable feedDecimals;
    uint256 public immutable maxPriceAge;
    uint16 public immutable bandBps;

    error ZeroValue();
    error DeadlinePassed(uint256 deadline, uint256 nowTs);
    error BadPrice(int256 answer);
    error StalePrice(uint256 updatedAt, uint256 nowTs);
    error SlippageOutOfRange(uint16 slippageBps);
    error PoolPriceOutOfBand(uint256 oracleOut, uint256 poolOut);
    error InvalidConfig();

    event GuardedSwap(
        address indexed treasury,
        uint256 hbarIn,
        uint256 stableOut,
        uint256 oracleOut,
        uint256 poolQuote,
        uint80 roundId,
        int256 price
    );

    constructor(
        ISaucerSwapV1Router router_,
        IAggregatorV3 priceFeed_,
        address whbar_,
        address stable_,
        uint8 stableDecimals_,
        uint256 maxPriceAge_,
        uint16 bandBps_
    ) {
        if (
            address(router_) == address(0) || address(priceFeed_) == address(0) || whbar_ == address(0)
                || stable_ == address(0) || whbar_ == stable_ || maxPriceAge_ == 0 || bandBps_ == 0 || bandBps_ >= BPS
        ) revert InvalidConfig();
        router = router_;
        priceFeed = priceFeed_;
        whbar = whbar_;
        stable = stable_;
        stableDecimals = stableDecimals_;
        feedDecimals = priceFeed_.decimals();
        maxPriceAge = maxPriceAge_;
        bandBps = bandBps_;
    }

    /**
     * @param slippageBps Accepted shortfall versus the oracle value (30–1000 bps).
     * @param deadline Unix time after which the swap must not run. For a scheduled proposal, set it after
     *        the schedule's expiration time, because the swap runs when the timelock ends.
     * @return stableOut Amount of stablecoin sent to `msg.sender`.
     */
    function swapHbarForStable(uint16 slippageBps, uint256 deadline) external payable returns (uint256 stableOut) {
        if (msg.value == 0) revert ZeroValue();
        if (block.timestamp > deadline) revert DeadlinePassed(deadline, block.timestamp);
        if (slippageBps < MIN_SLIPPAGE_BPS || slippageBps > MAX_SLIPPAGE_BPS) revert SlippageOutOfRange(slippageBps);

        (uint80 roundId, int256 price) = _freshPrice();
        uint256 oracleOut = quoteFromOracle(msg.value, price);

        address[] memory path = new address[](2);
        path[0] = whbar;
        path[1] = stable;
        uint256 poolQuote = router.getAmountsOut(msg.value, path)[1];
        if (!_withinBand(poolQuote, oracleOut)) revert PoolPriceOutOfBand(oracleOut, poolQuote);

        uint256 amountOutMin = (oracleOut * (BPS - slippageBps)) / BPS;
        uint256[] memory amounts =
            router.swapExactETHForTokens{ value: msg.value }(amountOutMin, path, msg.sender, deadline);
        stableOut = amounts[amounts.length - 1];

        emit GuardedSwap(msg.sender, msg.value, stableOut, oracleOut, poolQuote, roundId, price);
    }

    /// @notice Stablecoin units the oracle says `tinybar` HBAR is worth, assuming 1 stable = $1.
    function quoteFromOracle(uint256 tinybar, int256 price) public view returns (uint256) {
        // out = tinybar / 10^8 * price / 10^feedDec * 10^stableDec
        return (tinybar * uint256(price) * 10 ** stableDecimals) / 10 ** (HBAR_DECIMALS + feedDecimals);
    }

    /// @notice Current oracle value and pool quote for `tinybar`, without swapping (for UIs and proposals).
    function preview(uint256 tinybar) external view returns (uint256 oracleOut, uint256 poolQuote, bool inBand) {
        (, int256 price) = _freshPrice();
        oracleOut = quoteFromOracle(tinybar, price);
        address[] memory path = new address[](2);
        path[0] = whbar;
        path[1] = stable;
        poolQuote = router.getAmountsOut(tinybar, path)[1];
        inBand = _withinBand(poolQuote, oracleOut);
    }

    function _freshPrice() private view returns (uint80 roundId, int256 price) {
        uint256 updatedAt;
        (roundId, price,, updatedAt,) = priceFeed.latestRoundData();
        if (price <= 0) revert BadPrice(price);
        if (updatedAt > block.timestamp || block.timestamp - updatedAt > maxPriceAge) {
            revert StalePrice(updatedAt, block.timestamp);
        }
    }

    function _withinBand(uint256 poolQuote, uint256 oracleOut) private view returns (bool) {
        uint256 low = (oracleOut * (BPS - bandBps)) / BPS;
        uint256 high = (oracleOut * (BPS + bandBps)) / BPS;
        return poolQuote >= low && poolQuote <= high;
    }
}
