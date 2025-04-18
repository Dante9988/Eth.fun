import { ethers } from "hardhat";
import fs from "fs";
import { BigNumber } from "ethers";
import { Pool } from "@uniswap/v3-sdk";
import { Token } from "@uniswap/sdk-core";

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Deploying contracts with the account:", deployer.address);

    // CC3 Testnet addresses
    const UNISWAP_V3_FACTORY = "0xEcc68469F9c015A217215E19Fb6a183FE27aD1E9";
    const WCTC = "0x56072113e08015e1c40A3F3f656b1C1Fa78E329E";
    const USD_TCOIN = "0xa1Cc4d7aa040eA903fd00c13E7b43f8e26cbB7F8";
    const SWAP_ROUTER = "0x052ffAaAe6e24a1ff9F197c46c29dfdB53Bd61F5";
    const POSITION_MANAGER = "0x74501E231E1e8f505Fed029a1B48122114d1f51F";

    // Gas settings for EIP-1559
    const gasSettings = {
        maxFeePerGas: ethers.utils.parseUnits("2000", "gwei"),
        maxPriorityFeePerGas: ethers.utils.parseUnits("100", "gwei")
    };

    // Create Token instances
    const token0Contract = new ethers.Contract(WCTC, ["function decimals() view returns (uint8)"], deployer);
    const token1Contract = new ethers.Contract(USD_TCOIN, ["function decimals() view returns (uint8)"], deployer);
    const token0Decimals = await token0Contract.decimals();
    const token1Decimals = await token1Contract.decimals();

    const WCTCToken = new Token(80001, WCTC, token0Decimals, "WCTC", "Wrapped CTC");
    const USDTCoinToken = new Token(80001, USD_TCOIN, token1Decimals, "USD-TCoin", "USD-TCoin");

    // 1. Check if pools exist before deploying
    console.log("Checking for existing pools...");
    const factoryABI = ["function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address)"];
    const factory = new ethers.Contract(UNISWAP_V3_FACTORY, factoryABI, deployer);
    
    const feeTiers = [100, 500, 3000, 10000];
    let existingPools = [];
    let expectedPrice: BigNumber = BigNumber.from(0);
    
    for (const fee of feeTiers) {
        const poolAddress = await factory.getPool(WCTC, USD_TCOIN, fee);
        if (poolAddress !== ethers.constants.AddressZero) {
            console.log(`Found existing pool for fee tier ${fee} at ${poolAddress}`);
            existingPools.push({
                address: poolAddress,
                feeTier: fee
            });
            
            // Try to get some details about this pool
            try {
                const poolABI = [
                    "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
                    "function liquidity() external view returns (uint128)",
                    "function token0() external view returns (address)",
                    "function token1() external view returns (address)"
                ];
                const poolContract = new ethers.Contract(poolAddress, poolABI, deployer);
                const [slot0, liquidity, token0, token1] = await Promise.all([
                    poolContract.slot0(),
                    poolContract.liquidity(),
                    poolContract.token0(),
                    poolContract.token1()
                ]);

                // Create Pool instance
                const pool = new Pool(
                    WCTCToken,
                    USDTCoinToken,
                    fee,
                    slot0.sqrtPriceX96.toString(),
                    liquidity.toString(),
                    slot0.tick
                );

                // Get the price from pool
                const token0Price = pool.token0Price;
                const token1Price = pool.token1Price;
                
                // Calculate price in 8 decimals format
                let finalPrice;
                if (token0 === WCTC) {
                    // If WCTC is token0, we want token0Price (WCTC/USD-TCoin)
                    finalPrice = BigNumber.from(Math.floor(parseFloat(token0Price.toFixed(8)) * 100000000).toString());
                } else {
                    // If WCTC is token1, we want 1/token0Price
                    finalPrice = BigNumber.from(Math.floor(1 / parseFloat(token0Price.toFixed(8)) * 100000000).toString());
                }
                
                console.log(`Pool ${poolAddress} data:`);
                console.log(`  - Token0: ${token0} ${token0 === WCTC ? '(WCTC)' : token0 === USD_TCOIN ? '(USD-TCoin)' : ''}`);
                console.log(`  - Token1: ${token1} ${token1 === WCTC ? '(WCTC)' : token1 === USD_TCOIN ? '(USD-TCoin)' : ''}`);
                console.log(`  - Current tick: ${slot0.tick}`);
                console.log(`  - Liquidity: ${liquidity.toString()}`);
                console.log(`  - Raw sqrtPriceX96: ${slot0.sqrtPriceX96.toString()}`);
                console.log(`  - Token0 Price: ${token0Price.toFixed(8)}`);
                console.log(`  - Token1 Price: ${token1Price.toFixed(8)}`);
                console.log(`  - Calculated price (8 decimals): ${finalPrice.toString()}`);
                console.log(`  - Calculated price in USD: ${Number(finalPrice) / 100000000}`);

                // Instead of using hardcoded value, use our calculated price
                if (fee === 10000) { // Use the 1% pool as our primary price source
                    console.log(`  - This price will be used for oracle initialization`);
                    expectedPrice = finalPrice;
                }
            } catch (error: any) {
                console.log(`Could not get details for pool ${poolAddress}:`, error.message);
            }
        }
    }
    
    // Deploy PriceOracle
    console.log("\nDeploying PriceOracle...");
    const PriceOracle = await ethers.getContractFactory("PriceOracle");
    const priceOracle = await PriceOracle.deploy(
        UNISWAP_V3_FACTORY,
        WCTC,
        USD_TCOIN,
        { ...gasSettings }
    );
    await priceOracle.deployed();
    console.log("PriceOracle deployed to:", priceOracle.address);
    
    // Get initial price before adding pools
    const initialDefaultPrice = await priceOracle.getPrice();
    console.log("Initial default price (with 8 decimals):", initialDefaultPrice.toString());
    console.log("Initial default price in USD:", Number(initialDefaultPrice) / 100000000);

    // Add all existing pools to the oracle
    console.log("\nAdding pools to PriceOracle...");
    let activePoolAddress = ethers.constants.AddressZero;
    
    for (const pool of existingPools) {
        try {
            console.log(`Adding pool ${pool.address} (fee tier: ${pool.feeTier}) to PriceOracle...`);
            const tx = await priceOracle.addPool(pool.address, WCTC, USD_TCOIN, { ...gasSettings });
            await tx.wait();
            console.log(`Successfully added pool ${pool.address}`);
            activePoolAddress = pool.address;
        } catch (error: any) {
            console.error(`Failed to add pool ${pool.address}:`, error.message);
        }
    }

    if (activePoolAddress === ethers.constants.AddressZero) {
        console.warn("No active pools found for WCTC/USD-TCoin!");
    } else {
        // Initial price update
        console.log("\nPerforming initial price update...");
        try {
            const tx = await priceOracle.updatePrice({ ...gasSettings });
            await tx.wait();
            const updatedPrice = await priceOracle.getPrice();
            console.log("Updated WCTC price in USD (with 8 decimals):", updatedPrice.toString());
            console.log("Updated WCTC price in USD:", Number(updatedPrice) / 100000000);
            
            // Check if price was updated correctly
            if (updatedPrice.toString() === "1" || updatedPrice.toString() === "0") {
                console.log("\nSetting initial oracle price...");
                console.log("Current price is 0 (initial state), setting it from the 1% pool");
                // Force the correct price using our calculated value
                const forceTx = await (priceOracle as any).forceUpdatePrice(expectedPrice, { ...gasSettings });
                await forceTx.wait();
                const finalPrice = await priceOracle.getPrice();
                console.log("Successfully set initial price to:", finalPrice.toString());
                console.log("Initial price in USD:", Number(finalPrice) / 100000000);
            }

            // Get the expected price from our earlier calculations
            const pool3000 = existingPools.find(p => p.feeTier === 3000);
            if (pool3000) {
                const poolABI = ["function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)"];
                const poolContract = new ethers.Contract(pool3000.address, poolABI, deployer);
                const slot0 = await poolContract.slot0();
                
                console.log(`\nComparing with pool (fee tier 3000) data:`);
                console.log(`  - Pool tick: ${slot0.tick}`);

                // Create Pool instance for price calculation
                const pool = new Pool(
                    WCTCToken,
                    USDTCoinToken,
                    3000,
                    slot0.sqrtPriceX96.toString(),
                    "0", // liquidity doesn't matter for price calculation
                    slot0.tick
                );

                // Get token0 price (WCTC/USD-TCoin)
                const token0Price = pool.token0Price;
                const expectedPriceInWei = Math.floor(parseFloat(token0Price.toFixed(8)) * 100000000);
                
                console.log(`  - Expected price from pool: ${token0Price.toFixed(8)}`);
                console.log(`  - Expected price (8 decimals): ${expectedPriceInWei}`);
                console.log(`  - Actual price from oracle: ${Number(updatedPrice) / 100000000}`);
                console.log(`  - Is price hardcoded? ${updatedPrice.toString() === '54000000' ? 'Yes (0.54)' : 'No'}`);
            }
        } catch (error: any) {
            console.error("Failed to update price:", error.message);
        }
    }

    // 2. Deploy ETHPriceStorage
    console.log("\nDeploying ETHPriceStorage...");
    const ETHPriceStorage = await ethers.getContractFactory("ETHPriceStorage");
    const ethPriceStorage = await ETHPriceStorage.deploy(
        priceOracle.address,
        { ...gasSettings }
    );
    await ethPriceStorage.deployed();
    console.log("ETHPriceStorage deployed to:", ethPriceStorage.address);

    // 3. Deploy MultiAMM
    console.log("Deploying MultiAMM...");
    const MultiAMM = await ethers.getContractFactory("MultiAMM");
    const multiAMM = await MultiAMM.deploy(
        WCTC,
        { ...gasSettings }
    );
    await multiAMM.deployed();
    console.log("MultiAMM deployed to:", multiAMM.address);

    // 4. Deploy PumpFunEvm
    console.log("Deploying PumpFunEvm...");
    const PumpFunEvm = await ethers.getContractFactory("PumpFunEvm");
    const pumpFunEvm = await PumpFunEvm.deploy(
        UNISWAP_V3_FACTORY,
        POSITION_MANAGER,
        SWAP_ROUTER,
        WCTC,
        multiAMM.address,
        ethPriceStorage.address,
        { ...gasSettings }
    );
    await pumpFunEvm.deployed();
    console.log("PumpFunEvm deployed to:", pumpFunEvm.address);

    // Save contract addresses to a JSON file
    const contractAddresses = {
        priceOracle: priceOracle.address,
        ethPriceStorage: ethPriceStorage.address,
        multiAMM: multiAMM.address,
        pumpFunEvm: pumpFunEvm.address,
        uniswapV3Factory: UNISWAP_V3_FACTORY,
        wctc: WCTC,
        usdTcoin: USD_TCOIN,
        swapRouter: SWAP_ROUTER,
        positionManager: POSITION_MANAGER,
        activePool: activePoolAddress
    };

    fs.writeFileSync(
        "contractAddresses.json",
        JSON.stringify(contractAddresses, null, 2)
    );
    console.log("Contract addresses saved to contractAddresses.json");

    // Print verification commands
    console.log("\n=== Verification Commands ===");
    console.log("\n1. Verify PriceOracle:");
    console.log(`npx hardhat verify --network cc3 ${priceOracle.address} "${UNISWAP_V3_FACTORY}" "${WCTC}" "${USD_TCOIN}"`);

    console.log("\n2. Verify ETHPriceStorage:");
    console.log(`npx hardhat verify --network cc3 ${ethPriceStorage.address} "${priceOracle.address}"`);

    console.log("\n3. Verify MultiAMM:");
    console.log(`npx hardhat verify --network cc3 ${multiAMM.address} "${WCTC}"`);

    console.log("\n4. Verify PumpFunEvm:");
    console.log(`npx hardhat verify --network cc3 ${pumpFunEvm.address} "${UNISWAP_V3_FACTORY}" "${POSITION_MANAGER}" "${SWAP_ROUTER}" "${WCTC}" "${multiAMM.address}" "${ethPriceStorage.address}"`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    }); 