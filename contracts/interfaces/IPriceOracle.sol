// SPDX-License-Identifier: MIT
pragma solidity ^0.7.6;

interface IPriceOracle {
    function getPrice() external view returns (uint256);
    function updatePrice() external;
} 