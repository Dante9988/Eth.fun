// SPDX-License-Identifier: MIT
pragma solidity ^0.7.6;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IPriceOracle.sol";

contract ETHPriceStorage is Ownable {
    IPriceOracle public priceOracle;
    uint256 public ethPrice; // Price in USD with 8 decimals
    uint8 public constant decimals = 8;

    event PriceUpdated(uint256 oldPrice, uint256 newPrice);

    constructor(address _priceOracle) {
        priceOracle = IPriceOracle(_priceOracle);
        // Initialize with a default price (2000 USD)
        ethPrice = 2000 * 10**8;
    }

    function updatePrice() external {
        uint256 oldPrice = ethPrice;
        uint256 newPrice = priceOracle.getPrice();
        ethPrice = newPrice;
        emit PriceUpdated(oldPrice, newPrice);
    }

    function getPrice() external view returns (uint256) {
        return ethPrice;
    }

    function setPriceOracle(address _priceOracle) external onlyOwner {
        require(_priceOracle != address(0), "Invalid price oracle address");
        priceOracle = IPriceOracle(_priceOracle);
    }
} 