import { ethers } from "hardhat";

async function main() {
  console.log("Deploying PriceOracle...");
  
  const PriceOracle = await ethers.getContractFactory("PriceOracle");
  const priceOracle = await PriceOracle.deploy();
  await priceOracle.deployed();
  
  console.log("PriceOracle deployed to:", priceOracle.address);
  
  // Example: Add a pool (you'll need to replace with actual addresses)
  // const poolAddress = "0x..."; // Uniswap V3 pool address
  // const token0 = "0x..."; // Native token address
  // const token1 = "0x..."; // USDC address
  // await priceOracle.addPool(poolAddress, token0, token1);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  }); 