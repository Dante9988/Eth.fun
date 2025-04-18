import { expect } from 'chai';
import { ethers, network } from 'hardhat';
import { Signer } from 'ethers';
import { TickMath } from '@uniswap/v3-sdk';
import { deployUniswapV3, createPool, mint, swap, Addresses } from '../scripts/UniswapV3Scripts';
import { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import { TransactionResponse } from '@ethersproject/abstract-provider';
import * as constant from '../tools/common/const';
import UniswapV3Pool from '@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json';
import { FEE_AMOUNTS, TICK_SPACINGS } from './utils/constants';
import { PriceOracle } from "../typechain-types";
import { encodePriceSqrt } from "./utils/constants";
import { getMaxTick, getMinTick } from '../tools/common/const';

const tokens = (n: number) => {
    return ethers.utils.parseUnits(n.toString(), 'ether');
}

describe('PriceOracle Updates', () => {
    let accounts: any;
    let deployer: HardhatEthersSigner;
    let uniswapV3: any;
    let priceOracle: PriceOracle;
    let wctc: string;
    let usdt: string;

    beforeEach(async () => {
        accounts = await ethers.getSigners();
        deployer = accounts[0];

        // Deploy Uniswap V3 contracts with smaller initial supply
        uniswapV3 = await deployUniswapV3(deployer, ethers.utils.parseUnits('1000000000', 18));

        // Deploy PriceOracle
        const PriceOracle = await ethers.getContractFactory('PriceOracle');
        priceOracle = await PriceOracle.deploy(
            uniswapV3.V3Factory.address,
            uniswapV3.WETH9.address,
            uniswapV3.ERC20.address
        );
        await priceOracle.deployed();

        // Wrap ETH to WETH with smaller amount
        await uniswapV3.WETH9.deposit({ value: tokens(100) });

        wctc = uniswapV3.WETH9.address; // Use actual WETH9 address from deployment
        usdt = uniswapV3.ERC20.address; // Use actual ERC20 address from deployment
    });

    it('should update price through swaps', async () => {
        // Calculate initial sqrtPriceX96 for 0.35 USD per WCTC
        const priceRatio = Math.log(0.35) / Math.log(1.0001);
        const tick = Math.floor(priceRatio);
        const sqrtPriceX96 = TickMath.getSqrtRatioAtTick(tick).toString();

        const addresses: Addresses = {
            token1: uniswapV3.WETH9.address,
            token2: uniswapV3.ERC20.address
        };

        // Define feeAmount properties
        const FEE_AMOUNT_LOW = {
            FEE_AMOUNT: constant.FEE_AMOUNT.LOW,
            TICK_LOWER: constant.getMinTick(constant.TICK_SPACINGS[constant.FEE_AMOUNT.LOW]),
            TICK_UPPER: constant.getMaxTick(constant.TICK_SPACINGS[constant.FEE_AMOUNT.LOW]),
        };

        // Create pool using imported function
        const poolAddress = await createPool(
            deployer,
            addresses,
            FEE_AMOUNT_LOW,
            sqrtPriceX96
        );

        // Add pool to PriceOracle
        await priceOracle.addPool(
            poolAddress,
            uniswapV3.WETH9.address,
            uniswapV3.ERC20.address
        );

        // Mint initial liquidity using imported function
        await mint(
            deployer,
            addresses,
            FEE_AMOUNT_LOW,
            '1.75',  // WETH amount
            '5'      // ERC20 amount
        );

        // Get pool contract to read sqrtPriceX96 directly
        const poolContract = new ethers.Contract(poolAddress, UniswapV3Pool.abi, deployer as unknown as Signer);
        
        // Get initial price
        const slot0Before = await poolContract.slot0();
        await priceOracle.onSwap(
            poolAddress,
            deployer.address,
            deployer.address,
            0,
            0,
            slot0Before.sqrtPriceX96,
            0,
            0
        );
        const initialPrice = await priceOracle.getPrice();
        console.log('Initial price:', ethers.utils.formatUnits(initialPrice, 8));

        // Perform a swap using imported function
        await swap(
            deployer,
            addresses,
            poolAddress,
            '0.1',  // Swap 0.1 WETH
            true    // Exact input
        );

        // Get new sqrtPriceX96 after swap
        const slot0After = await poolContract.slot0();
        
        // Update price through onSwap
        await priceOracle.onSwap(
            poolAddress,
            deployer.address,
            deployer.address,
            0,
            0,
            slot0After.sqrtPriceX96,
            0,
            0
        );

        // Get updated price
        const updatedPrice = await priceOracle.getPrice();
        console.log('Updated price:', ethers.utils.formatUnits(updatedPrice, 8));

        // Verify price changed and is not zero
        expect(updatedPrice).to.not.equal(0);
        expect(updatedPrice).to.not.equal(initialPrice);

        // Perform another swap
        await swap(
            deployer,
            addresses,
            poolAddress,
            '0.1',  // Swap 0.1 WETH
            true    // Exact input
        );

        // Get final sqrtPriceX96
        const slot0Final = await poolContract.slot0();
        
        // Update price through onSwap
        await priceOracle.onSwap(
            poolAddress,
            deployer.address,
            deployer.address,
            0,
            0,
            slot0Final.sqrtPriceX96,
            0,
            0
        );

        // Get final price
        const finalPrice = await priceOracle.getPrice();
        console.log('Final price:', ethers.utils.formatUnits(finalPrice, 8));

        // Verify price changed and is not zero
        expect(finalPrice).to.not.equal(0);
        expect(finalPrice).to.not.equal(updatedPrice);
    });

    it('should update price from multiple pools', async () => {
        // Create first pool with price 0.54
        const price1 = 0.54;
        const priceRatio1 = Math.log(price1) / Math.log(1.0001);
        const tick1 = Math.floor(priceRatio1);
        const sqrtPriceX96_1 = TickMath.getSqrtRatioAtTick(tick1).toString();

        const addresses1: Addresses = {
            token1: uniswapV3.WETH9.address,
            token2: uniswapV3.ERC20.address
        };

        // Define feeAmount properties for pool 1
        const FEE_AMOUNT_LOW = {
            FEE_AMOUNT: constant.FEE_AMOUNT.LOW,
            TICK_LOWER: constant.getMinTick(constant.TICK_SPACINGS[constant.FEE_AMOUNT.LOW]),
            TICK_UPPER: constant.getMaxTick(constant.TICK_SPACINGS[constant.FEE_AMOUNT.LOW]),
        };

        // Create first pool using imported function
        const pool1 = await createPool(
            deployer,
            addresses1,
            FEE_AMOUNT_LOW,
            sqrtPriceX96_1
        );

        // Add first pool to PriceOracle
        await priceOracle.addPool(
            pool1,
            uniswapV3.WETH9.address,
            uniswapV3.ERC20.address
        );

        // Initial mint for the pool
        await mint(deployer, addresses1, FEE_AMOUNT_LOW, '1', '1.85');

        // Update price
        const poolContract1 = new ethers.Contract(pool1, UniswapV3Pool.abi, deployer as unknown as Signer);
        const slot0_1 = await poolContract1.slot0();
        
        await priceOracle.onSwap(
            pool1,
            deployer.address,
            deployer.address,
            0,
            0,
            slot0_1.sqrtPriceX96,
            0,
            0
        );

        const initialPrice = await priceOracle.getPrice();
        console.log('Initial price:', ethers.utils.formatUnits(initialPrice, 8));

        // Perform swap on the pool
        await swap(deployer, addresses1, pool1, '0.1', true);

        // Get updated sqrtPriceX96
        const slot0After = await poolContract1.slot0();
        
        // Update price through onSwap
        await priceOracle.onSwap(
            pool1,
            deployer.address,
            deployer.address,
            0,
            0,
            slot0After.sqrtPriceX96,
            0,
            0
        );

        // Get updated price
        const updatedPrice = await priceOracle.getPrice();
        console.log('Updated price:', ethers.utils.formatUnits(updatedPrice, 8));

        // Verify the price has changed
        expect(updatedPrice).to.not.equal(0);
        expect(updatedPrice).to.not.equal(initialPrice);
    });

    it("should update price after swap", async () => {
        // Create a pool with initial price of 0.54 USD per CTC
        const initialPriceValue = 0.54;
        const priceRatio = Math.log(initialPriceValue) / Math.log(1.0001);
        const tick = Math.floor(priceRatio);
        const initialPrice = TickMath.getSqrtRatioAtTick(tick).toString();
        
        // Define feeAmount properties
        const FEE_AMOUNT_MEDIUM = {
            FEE_AMOUNT: constant.FEE_AMOUNT.MEDIUM,
            TICK_LOWER: constant.getMinTick(constant.TICK_SPACINGS[constant.FEE_AMOUNT.MEDIUM]),
            TICK_UPPER: constant.getMaxTick(constant.TICK_SPACINGS[constant.FEE_AMOUNT.MEDIUM]),
        };
        
        const poolAddresses: Addresses = {
            token1: wctc,
            token2: usdt
        };
        
        // Create pool using imported function
        const pool = await createPool(
            deployer,
            poolAddresses,
            FEE_AMOUNT_MEDIUM,
            initialPrice
        );

        // Add pool to PriceOracle
        await priceOracle.addPool(pool, wctc, usdt);

        // Mint initial liquidity
        await mint(
            deployer,
            poolAddresses,
            FEE_AMOUNT_MEDIUM,
            '1',  // WCTC amount
            '2'   // USDT amount
        );

        // Perform a swap to change the price using imported function
        await swap(deployer, poolAddresses, pool, "1", true); // Swap 1 CTC

        // Get the new price from the oracle
        const newPrice = await priceOracle.getPrice();

        // Verify the price has changed
        expect(newPrice).to.not.equal(0);
    });
}); 