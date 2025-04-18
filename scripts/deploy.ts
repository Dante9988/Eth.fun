import { ethers } from 'hardhat';
import { deployUniswapV3 } from './UniswapV3Scripts';
import { TransactionResponse } from '@ethersproject/providers';
import { HardhatEthersSigner, HardhatEthersSigner as SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { Contract, Signer } from 'ethers';
import { IERC20 } from '../typechain-types/contracts/Token.sol/IERC20';
import { Token__factory } from '../typechain-types';
import DeployedContracts from './interfaces';
import fs from 'fs';

let accounts: any;
let deployer: HardhatEthersSigner;
let nonWhitelisted: HardhatEthersSigner;
let uniswapV3: DeployedContracts;
let ico: Contract;
let liquidityProvider: any;
let consumerPriceFeed: Contract;
let multiAMM: Contract;
let signers: any;
let signer: SignerWithAddress;
let user1: SignerWithAddress;
let user2: SignerWithAddress;
let transaction: TransactionResponse;
let tokenFactory: Token__factory;
const tokens = (n: number) => {
    return ethers.utils.parseUnits(n.toString(), 'ether');
} 

const deploy = async () => {
    tokenFactory = await ethers.getContractFactory("Token") as Token__factory;
    // signers = await ethers.getSigners();
    // signer = signers[0];
    // user1 = signers[1];
    // user2 = signers[2];
    accounts = await ethers.getSigners();
    deployer = accounts[0];
    nonWhitelisted = accounts[1];
    uniswapV3 = await deployUniswapV3(deployer, ethers.utils.parseUnits('1000000000', 18));

    // Deploy our mock price feed with initial ETH price of $3400 (with 8 decimals)
    const MockPriceFeed = await ethers.getContractFactory('MockPriceFeed');
    consumerPriceFeed = await MockPriceFeed.deploy(340000000000);
    await consumerPriceFeed.deployed();

    // Deploy MultiAMM
    const MultiAMM = await ethers.getContractFactory('MultiAMM');
    multiAMM = await MultiAMM.deploy(uniswapV3.WETH9.address);
    await multiAMM.deployed();

    console.log(`MultiAMM deployed at: ${multiAMM.address}`);

    // Deploy LiquidityProvider
    const LiquidityProvider = await ethers.getContractFactory('ICO');
    liquidityProvider = await LiquidityProvider.deploy(
        uniswapV3.V3Factory.address,
        uniswapV3.NFTManager.address,
        uniswapV3.SwapRouter.address,
        uniswapV3.WETH9.address,
        multiAMM.address,
        consumerPriceFeed.address
    );
    ico = await liquidityProvider.deployed();

    // Wrap ETH to WETH
    // let wrapTxn = await uniswapV3.WETH9.deposit({ value: tokens(1000) });
    // await wrapTxn.wait();
    // console.log(`Wrapped ETH to WETH at: ${wrapTxn.hash}`);

    // Write contract addresses to a file
    // Get the network information
    const network = await ethers.provider.getNetwork();
    const chainId = network.chainId.toString();

    // Read existing addresses or initialize new object
    let existingAddresses = {};
    try {
        existingAddresses = JSON.parse(fs.readFileSync('contractAddresses.json', 'utf8'));
    } catch (error) {
        console.log('No existing contractAddresses.json found, creating new file');
    }

    // Create new addresses object for current chainId
    const newAddresses = {
        ico: ico.address,
        multiAMM: multiAMM.address,
        ethUsdPriceFeed: consumerPriceFeed.address,
        uniswapV3Factory: uniswapV3.V3Factory.address,
        uniswapV3NFTManager: uniswapV3.NFTManager.address,
        uniswapV3SwapRouter: uniswapV3.SwapRouter.address,
        uniswapV3WETH9: uniswapV3.WETH9.address
    };

    // Update addresses for current chainId
    const updatedAddresses = {
        ...existingAddresses,
        [chainId]: newAddresses
    };

    // Write updated addresses to file
    fs.writeFileSync(
        'contractAddresses.json',
        JSON.stringify(updatedAddresses, null, 2)
    );

    console.log(`Deployed contracts to chain ${chainId}`);

    // Create a new token
    const tokenParams = {
        name: 'PUMP-Fun',
        symbol: 'PUMP',
        decimals: 18
    };

    let transaction = await ico.createTokenAndPool(tokenParams);
    await transaction.wait();
    console.log(`Token and pool created at: ${transaction.hash}`);
    const events = await ico.queryFilter(ico.filters.TokenCreated(), 0, "latest");
    const tokenAddress = events[0].args?.tokenAddress;
    console.log(`Token created at address: ${tokenAddress}`);

    // Verify pool setup
    const [balA, balB, K] = await multiAMM.getPoolBalances(tokenAddress, uniswapV3.WETH9.address);
    console.log("Initial pool state:", {
        balanceA: ethers.utils.formatEther(balA),
        balanceB: ethers.utils.formatEther(balB),
        K: K.toString()
    });

    // Initial state check
    const poolId = await multiAMM._getPoolId(tokenAddress, uniswapV3.WETH9.address);
    const poolBefore = await multiAMM.pools(poolId);
    console.log("Pool state before swap:", {
        tokenBalanceA: ethers.utils.formatEther(poolBefore.tokenBalanceA),
        tokenBalanceB: ethers.utils.formatEther(poolBefore.tokenBalanceB),
        K: poolBefore.K.toString(),
        zeroPriceActive: poolBefore.zeroPriceActive
    });

    // Check initial balances
    const deployerWETHBefore = await uniswapV3.WETH9.balanceOf(deployer.address);
    const deployerTokenBefore = await tokenFactory.attach(tokenAddress).balanceOf(deployer.address);
    const ammWETHBefore = await uniswapV3.WETH9.balanceOf(multiAMM.address);
    const ammTokenBefore = await tokenFactory.attach(tokenAddress).balanceOf(multiAMM.address);

    console.log("Balances before swap:", {
        deployer: {
            WETH: ethers.utils.formatEther(deployerWETHBefore),
            token: ethers.utils.formatEther(deployerTokenBefore)
        },
        amm: {
            WETH: ethers.utils.formatEther(ammWETHBefore),
            token: ethers.utils.formatEther(ammTokenBefore)
        }
    });

    const swapAmount = ethers.utils.parseUnits('0.005', 18);
    console.log("Attempting to swap:", ethers.utils.formatUnits(swapAmount, 18), "WETH");

    const allowanceBefore = await uniswapV3.WETH9.allowance(deployer.address, ico.address);
    console.log("ICO allowance before:", ethers.utils.formatEther(allowanceBefore));

    await uniswapV3.WETH9.connect(deployer as unknown as Signer).approve(ico.address, ethers.utils.parseUnits('100000', 18));
    await uniswapV3.WETH9.connect(deployer as unknown as Signer).approve(multiAMM.address, ethers.utils.parseUnits('100000', 18));
    const allowanceAfter = await uniswapV3.WETH9.allowance(deployer.address, ico.address);
    const allowanceAfterMultiAMM = await uniswapV3.WETH9.allowance(deployer.address, multiAMM.address);  

    console.log("ICO allowance after:", ethers.utils.formatEther(allowanceAfter));
    console.log("MultiAMM allowance after:", ethers.utils.formatEther(allowanceAfterMultiAMM));

    transaction = await ico.connect(deployer as unknown as Signer).buyToken(
        tokenAddress, 
        swapAmount
    );
    
    let receipt = await transaction.wait();
    console.log("Swap transaction:", {
        hash: transaction.hash,
        gasUsed: receipt.gasUsed.toString()
    });

    // Check final state
    let poolAfter = await multiAMM.pools(poolId);
    console.log("Pool state after swap:", {
        tokenBalanceA: ethers.utils.formatEther(poolAfter.tokenBalanceA),
        tokenBalanceB: ethers.utils.formatEther(poolAfter.tokenBalanceB),
        K: poolAfter.K.toString(),
        zeroPriceActive: poolAfter.zeroPriceActive
    });

    // Deploy PriceOracle
    const PriceOracle = await ethers.getContractFactory("PriceOracle");
    const priceOracle = await PriceOracle.deploy(
        uniswapV3.V3Factory.address,
        uniswapV3.WETH9.address,
        tokenAddress,
        { from: deployer.address }
    );
    await priceOracle.deployed();
    console.log("PriceOracle deployed to:", priceOracle.address);

    // Deploy ETHPriceStorage
    const ETHPriceStorage = await ethers.getContractFactory("ETHPriceStorage");
    const ethPriceStorage = await ETHPriceStorage.deploy(
        priceOracle.address,
        { from: deployer.address }
    );
    await ethPriceStorage.deployed();
    console.log("ETHPriceStorage deployed to:", ethPriceStorage.address);

    // Deploy PumpFunEvm
    const PumpFunEvm = await ethers.getContractFactory("PumpFunEvm");
    const pumpFunEvm = await PumpFunEvm.deploy(
        uniswapV3.V3Factory.address,
        uniswapV3.NFTManager.address,
        uniswapV3.SwapRouter.address,
        uniswapV3.WETH9.address,
        multiAMM.address,
        ethPriceStorage.address
    );
    await pumpFunEvm.deployed();
    console.log("PumpFunEvm deployed to:", pumpFunEvm.address);

    // Save contract addresses
    const addresses = {
        priceOracle: priceOracle.address,
        ethPriceStorage: ethPriceStorage.address,
        multiAMM: multiAMM.address,
        pumpFunEvm: pumpFunEvm.address
    };

    fs.writeFileSync('contractAddresses.json', JSON.stringify(addresses, null, 2));
    console.log("Contract addresses saved to contractAddresses.json");
}

deploy()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
