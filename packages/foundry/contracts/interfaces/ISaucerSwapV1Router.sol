// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @notice SaucerSwap V1 RouterV3 (Uniswap V2-style), subset used by SwapGuard.
/// @dev On Hedera the path uses the WHBAR *token* address, and `msg.value` is in tinybar.
interface ISaucerSwapV1Router {
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts);

    function swapExactETHForTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline)
        external
        payable
        returns (uint256[] memory amounts);
}
