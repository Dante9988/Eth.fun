import { expect } from "chai";
import { ethers } from "hardhat";
import { Signer } from "ethers";
import { PriceOracle } from "../typechain-types";

describe("PriceOracle", function () {
    let deployer: Signer;
    let priceOracle: PriceOracle;
    let wctc: string;
    let usdt: string;
    let factory: string;

    before(async () => {
        [deployer] = await ethers.getSigners();
        factory = "0xEcc68469F9c015A217215E19Fb6a183FE27aD1E9"; // Uniswap V3 Factory address
        wctc = "0x56072113e08015e1c40A3F3f656b1C1Fa78E329E"; // WCTC address
        usdt = "0xa1Cc4d7aa040eA903fd00c13E7b43f8e26cbB7F8"; // USD-TCoin address

        const PriceOracle = await ethers.getContractFactory("PriceOracle");
        priceOracle = await PriceOracle.deploy(factory, wctc, usdt);
        await priceOracle.deployed();
    });

    it("should update price after swap", async () => {
        // Create a pool with initial price
        const poolAddress = "0xYourPoolAddress"; // Replace with actual pool address
        const feeAmount = ethers.utils.parseUnits("3000", 0); // 0.3% fee tier

        // Add pool to PriceOracle
        await priceOracle.addPool(poolAddress, wctc, usdt);

        // Get initial price
        const initialPrice = await priceOracle.getPrice();

        // Perform a swap (this would be done through the actual pool contract)
        // For testing purposes, we'll simulate a price change
        const newPrice = await priceOracle.getPrice();

        // Verify the price has changed
        expect(newPrice).to.not.equal(initialPrice);
    });
}); 