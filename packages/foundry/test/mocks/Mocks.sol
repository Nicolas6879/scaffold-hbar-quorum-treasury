// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import { IAggregatorV3 } from "../../contracts/interfaces/IAggregatorV3.sol";
import { ISaucerSwapV1Router } from "../../contracts/interfaces/ISaucerSwapV1Router.sol";

contract MockAggregator is IAggregatorV3 {
    uint8 public override decimals;
    uint80 public roundId = 1;
    int256 public answer;
    uint256 public updatedAt;

    constructor(uint8 decimals_, int256 answer_, uint256 updatedAt_) {
        decimals = decimals_;
        answer = answer_;
        updatedAt = updatedAt_;
    }

    function set(int256 answer_, uint256 updatedAt_) external {
        answer = answer_;
        updatedAt = updatedAt_;
        roundId++;
    }

    function latestRoundData() external view override returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }
}

contract MockStable {
    mapping(address => uint256) public balanceOf;
    uint8 public immutable decimals;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }
}

/// @notice Constant-rate router: out = in * rateNum / rateDen. Records the last call for assertions.
contract MockRouter is ISaucerSwapV1Router {
    MockStable public immutable stable;
    uint256 public rateNum;
    uint256 public rateDen;
    /// @notice When set, swaps deliver less than quoted (simulates price moving between quote and swap).
    uint256 public deliverBps = 10_000;

    uint256 public lastValue;
    uint256 public lastAmountOutMin;
    address public lastTo;
    uint256 public lastDeadline;

    constructor(MockStable stable_, uint256 rateNum_, uint256 rateDen_) {
        stable = stable_;
        rateNum = rateNum_;
        rateDen = rateDen_;
    }

    function setRate(uint256 rateNum_, uint256 rateDen_) external {
        rateNum = rateNum_;
        rateDen = rateDen_;
    }

    function setDeliverBps(uint256 bps) external {
        deliverBps = bps;
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path)
        public
        view
        override
        returns (uint256[] memory amounts)
    {
        require(path.length == 2, "path");
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = (amountIn * rateNum) / rateDen;
    }

    function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external
        payable
        override
        returns (uint256[] memory amounts)
    {
        require(block.timestamp <= deadline, "UniswapV2Router: EXPIRED");
        amounts = getAmountsOut(msg.value, path);
        amounts[1] = (amounts[1] * deliverBps) / 10_000;
        require(amounts[1] >= amountOutMin, "UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT");
        lastValue = msg.value;
        lastAmountOutMin = amountOutMin;
        lastTo = to;
        lastDeadline = deadline;
        stable.mint(to, amounts[1]);
    }
}
