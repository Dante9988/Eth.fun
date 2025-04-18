// SPDX-License-Identifier: MIT
pragma solidity ^0.7.6;

interface IPriceOracle {
    function getPrice() external view returns (uint256);
    function updatePrice() external;
    function onSwap(
        address pool,
        address sender,
        address recipient,
        int256 amount0,
        int256 amount1,
        uint160 sqrtPriceX96,
        uint128 liquidity,
        int24 tick
    ) external;
    function forceUpdatePrice(uint256 newPrice) external;
} 