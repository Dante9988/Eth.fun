import { ethers } from "hardhat";
import fs from "fs";

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

    // 1. Deploy PriceOracle
    console.log("Deploying PriceOracle...");
    const PriceOracle = await ethers.getContractFactory("PriceOracle");
    const priceOracle = await PriceOracle.deploy(
        UNISWAP_V3_FACTORY,
        WCTC,
        USD_TCOIN,
        { ...gasSettings }
    );
    await priceOracle.deployed();
    console.log("PriceOracle deployed to:", priceOracle.address);

    // Setup PriceOracle pools
    console.log("Setting up PriceOracle pools...");
    const factoryABI = ["function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address)"];
    const factory = new ethers.Contract(UNISWAP_V3_FACTORY, factoryABI, deployer);

    // Check fee tiers in order: LOW -> MEDIUM -> HIGH
    const feeTiers = [100, 500, 3000, 10000];
    let activePoolAddress = ethers.constants.AddressZero;

    for (const fee of feeTiers) {
        const poolAddress = await factory.getPool(WCTC, USD_TCOIN, fee);
        if (poolAddress !== ethers.constants.AddressZero) {
            console.log(`Found pool for fee tier ${fee} at ${poolAddress}`);
            try {
                const tx = await priceOracle.addPool(poolAddress, WCTC, USD_TCOIN, { ...gasSettings });
                await tx.wait();
                console.log(`Added pool for fee tier ${fee}`);
                activePoolAddress = poolAddress;
            } catch (error) {
                console.error(`Failed to add pool for fee tier ${fee}:`, error);
            }
        }
    }

    if (activePoolAddress === ethers.constants.AddressZero) {
        console.warn("No active pools found for WCTC/USD-TCoin!");
    } else {
        // Initial price update
        console.log("Performing initial price update...");
        try {
            const tx = await priceOracle.updatePrice({ ...gasSettings });
            await tx.wait();
            const currentPrice = await priceOracle.getPrice();
            console.log("Initial WCTC price in USD (with 8 decimals):", currentPrice.toString());
        } catch (error) {
            console.error("Failed to update price:", error);
        }
    }

    // 2. Deploy ETHPriceStorage
    console.log("Deploying ETHPriceStorage...");
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