import { expect } from 'chai';
import { ethers, network } from 'hardhat';
import { Contract, Signer } from 'ethers';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { deployUniswapV3, createPool, mint, swap, Addresses } from '../scripts/UniswapV3Scripts';
import { TickMath } from '@uniswap/v3-sdk';
import * as constant from '../tools/common/const';
import IUniswapV3Pool from '../artifacts/contracts/interfaces/IUniswapV3Pools.sol/IUniswapV3Pool.json';

describe('PriceOracle', () => {
    let priceOracle: Contract;
    let uniswapV3: any;
    let owner: SignerWithAddress;
    let user: SignerWithAddress;
    let signers: any;
    let poolAddress: string;
    let tokenId: string;
    
    // Constants from the contract
    const FEE_AMOUNT_LOW = {
        FEE_AMOUNT: constant.FEE_AMOUNT.LOW,
        TICK_LOWER: constant.getMinTick(constant.TICK_SPACINGS[constant.FEE_AMOUNT.LOW]),
        TICK_UPPER: constant.getMaxTick(constant.TICK_SPACINGS[constant.FEE_AMOUNT.LOW]),
    };

    const tokens = (n: number) => {
        return ethers.utils.parseUnits(n.toString(), 'ether');
    }

    beforeEach(async () => {
        signers = await ethers.getSigners();
        owner = signers[0];
        user = signers[1];

        // Transfer ETH from another signer to owner for gas
        const richSigner = signers[2];  // Use third signer as a source of funds
        await richSigner.sendTransaction({
            to: owner.address,
            value: ethers.utils.parseEther("1000.0")  // Transfer 100,000 ETH to ensure sufficient funds
        });

        // Deploy Uniswap V3 contracts
        uniswapV3 = await deployUniswapV3(owner, ethers.utils.parseUnits('1000000000', 18));

        // Deploy PriceOracle with WETH and ERC20 addresses from deployed Uniswap
        const PriceOracle = await ethers.getContractFactory('PriceOracle');
        priceOracle = await PriceOracle.deploy(
            uniswapV3.V3Factory.address,
            uniswapV3.WETH9.address,  // Use WETH instead of WCTC
            uniswapV3.ERC20.address   // Use deployed ERC20 instead of USD-TCoin
        );
        await priceOracle.deployed();

        // Wrap ETH to WETH
        let wrapTxn = await uniswapV3.WETH9.deposit({ value: tokens(1000) });
        await wrapTxn.wait();
        console.log(`Wrapped ETH to WETH at: ${wrapTxn.hash}`);

        // Log token decimals
        const wethDecimals = await uniswapV3.WETH9.decimals();
        const erc20Decimals = await uniswapV3.ERC20.decimals();
        console.log('Token decimals:', {
            WETH: wethDecimals,
            ERC20: erc20Decimals
        });

        // Approve tokens for NFTManager with higher amounts
        let approveTxn = await uniswapV3.WETH9.approve(uniswapV3.NFTManager.address, tokens(100000));
        await approveTxn.wait();
        console.log(`Approved NFTManager to spend WETH9 at: ${approveTxn.hash}`);

        // For 6 decimal ERC20, we need to adjust the approval amount
        const erc20ApprovalAmount = ethers.utils.parseUnits('100000', erc20Decimals);
        approveTxn = await uniswapV3.ERC20.approve(uniswapV3.NFTManager.address, erc20ApprovalAmount);
        await approveTxn.wait();
        console.log(`Approved NFTManager to spend ERC20 at: ${approveTxn.hash}`);

        // Log balances before pool creation
        const wethBalance = await uniswapV3.WETH9.balanceOf(owner.address);
        const erc20Balance = await uniswapV3.ERC20.balanceOf(owner.address);
        console.log('Balances before pool creation:', {
            WETH: ethers.utils.formatUnits(wethBalance, wethDecimals),
            ERC20: ethers.utils.formatUnits(erc20Balance, erc20Decimals)
        });

        // Create pool between WETH and ERC20
        const currentBlockTimestamp = (await ethers.provider.getBlock('latest')).timestamp;
        const deadline = Math.floor(currentBlockTimestamp) + 60 * 20;

        // Calculate sqrtPriceX96 for 0.35 ERC20 per 1 WETH
        const price = 0.35;
        const sqrtPriceX96 = TickMath.getSqrtRatioAtTick(
            Math.floor(Math.log(price) / Math.log(1.0001))
        ).toString();

        // Create pool using UniswapV3Scripts
        const addresses: Addresses = {
            token1: uniswapV3.WETH9.address,
            token2: uniswapV3.ERC20.address
        };

        poolAddress = await createPool(
            owner as any,
            addresses,
            FEE_AMOUNT_LOW,
            sqrtPriceX96
        );
        console.log(`Pool created at: ${poolAddress}`);

        // Mint initial liquidity with adjusted amounts for 6 decimal ERC20
        const wethAmount = '17.5';  // Will be doubled to 35 WETH (18 decimals)
        const erc20MintAmount = '50';  // Will be doubled to 100 ERC20 (18 decimals)
        console.log('Minting liquidity with amounts:', {
            WETH: wethAmount,
            ERC20: erc20MintAmount
        });

        try {
            tokenId = await mint(
                owner as any,
                addresses,
                FEE_AMOUNT_LOW,
                wethAmount,
                erc20MintAmount
            );
            console.log(`Initial liquidity minted with tokenId: ${tokenId}`);
        } catch (error) {
            console.error('Detailed mint error:', error);
            // Log allowances after error
            const wethAllowance = await uniswapV3.WETH9.allowance(owner.address, uniswapV3.NFTManager.address);
            const erc20Allowance = await uniswapV3.ERC20.allowance(owner.address, uniswapV3.NFTManager.address);
            console.log('Allowances after error:', {
                WETH: ethers.utils.formatUnits(wethAllowance, wethDecimals),
                ERC20: ethers.utils.formatUnits(erc20Allowance, erc20Decimals)
            });
            throw error;
        }

        // Approve tokens for PriceOracle with adjusted amounts
        approveTxn = await uniswapV3.WETH9.approve(priceOracle.address, tokens(100000));
        await approveTxn.wait();
        console.log(`Approved PriceOracle to spend WETH9 at: ${approveTxn.hash}`);

        approveTxn = await uniswapV3.ERC20.approve(priceOracle.address, erc20ApprovalAmount.toString());
        await approveTxn.wait();
        console.log(`Approved PriceOracle to spend ERC20 at: ${approveTxn.hash}`);

        // Log final balances
        const finalWethBalance = await uniswapV3.WETH9.balanceOf(owner.address);
        const finalErc20Balance = await uniswapV3.ERC20.balanceOf(owner.address);
        console.log('Final balances:', {
            WETH: ethers.utils.formatUnits(finalWethBalance, wethDecimals),
            ERC20: ethers.utils.formatUnits(finalErc20Balance, erc20Decimals)
        });
    });

    describe('Initialization', () => {
        it('should initialize with correct values', async () => {
            expect(await priceOracle.factory()).to.equal(uniswapV3.V3Factory.address);
            expect(await priceOracle.WCTC()).to.equal(uniswapV3.WETH9.address);
            expect(await priceOracle.USD_TCoin()).to.equal(uniswapV3.ERC20.address);
            expect(await priceOracle.getPrice()).to.equal(ethers.utils.parseUnits('0.35', 8)); // Initial price
        });
    });

    describe('Price Updates', () => {
        it('should update price from pool slot0', async () => {
            await priceOracle.updatePrice();
            const price = await priceOracle.getPrice();
            // Price should be close to 0.35 ERC20 per 1 WETH
            expect(price).to.be.closeTo(
                ethers.utils.parseUnits('0.35', 8),
                ethers.utils.parseUnits('0.01', 8)
            );
        });

        it('should handle swap event correctly', async () => {
            // Get current slot0 data
            const pool = await ethers.getContractAt(IUniswapV3Pool.abi, poolAddress);
            const [sqrtPriceX96] = await pool.slot0();

            await priceOracle.onSwap(
                poolAddress,
                owner.address,
                user.address,
                tokens(1),
                tokens(0.35),
                sqrtPriceX96,
                tokens(1000),
                0
            );

            const price = await priceOracle.getPrice();
            expect(price).to.be.closeTo(
                ethers.utils.parseUnits('0.35', 8),
                ethers.utils.parseUnits('0.01', 8)
            );
        });

        it('should ignore swap event from non-tracked pool', async () => {
            const initialPrice = await priceOracle.getPrice();
            
            await priceOracle.onSwap(
                ethers.constants.AddressZero,
                owner.address,
                user.address,
                tokens(1),
                tokens(0.35),
                ethers.utils.parseUnits('447213595499957939278635775', 0),
                tokens(1000),
                0
            );

            const finalPrice = await priceOracle.getPrice();
            expect(finalPrice).to.equal(initialPrice);
        });

        it('should update price after swap', async () => {
            // Perform a swap
            const addresses: Addresses = {
                token1: uniswapV3.WETH9.address,
                token2: uniswapV3.ERC20.address
            };

            await swap(
                owner as any,
                addresses,
                poolAddress,
                '1',
                true
            );

            await priceOracle.updatePrice();
            const price = await priceOracle.getPrice();
            expect(price).to.be.closeTo(
                ethers.utils.parseUnits('0.35', 8),
                ethers.utils.parseUnits('0.01', 8)
            );
        });

        it('should handle multiple swaps and maintain price accuracy', async () => {
            const addresses: Addresses = {
                token1: uniswapV3.WETH9.address,
                token2: uniswapV3.ERC20.address
            };

            // Perform multiple swaps in sequence
            for (let i = 0; i < 3; i++) {
                await swap(
                    owner as any,
                    addresses,
                    poolAddress,
                    '1',
                    true
                );
                await priceOracle.updatePrice();
                const price = await priceOracle.getPrice();
                expect(price).to.be.closeTo(
                    ethers.utils.parseUnits('0.35', 8),
                    ethers.utils.parseUnits('0.01', 8)
                );
            }
        });

        it('should handle large price movements', async () => {
            const addresses: Addresses = {
                token1: uniswapV3.WETH9.address,
                token2: uniswapV3.ERC20.address
            };

            // Perform a large swap to simulate significant price movement
            await swap(
                owner as any,
                addresses,
                poolAddress,
                '100', // Large amount
                true
            );

            await priceOracle.updatePrice();
            const price = await priceOracle.getPrice();
            // Price should still be within reasonable bounds
            expect(price).to.be.gt(ethers.utils.parseUnits('0.1', 8));
            expect(price).to.be.lt(ethers.utils.parseUnits('1', 8));
        });

        it('should handle pool reinitialization', async () => {
            // Add the pool to PriceOracle first
            await priceOracle.addPool(
                poolAddress,
                uniswapV3.WETH9.address,
                uniswapV3.ERC20.address
            );
            
            // Get initial price
            await priceOracle.updatePrice();
            const initialPrice = await priceOracle.getPrice();
            console.log('Initial price:', initialPrice.toString());
            
            // Remove the pool
            await priceOracle.removePool(poolAddress);
            
            // Re-add the pool
            await priceOracle.addPool(
                poolAddress,
                uniswapV3.WETH9.address,
                uniswapV3.ERC20.address
            );

            // Update price and verify
            await priceOracle.updatePrice();
            const finalPrice = await priceOracle.getPrice();
            console.log('Final price:', finalPrice.toString());
            
            // Price should be close to initial price
            expect(finalPrice).to.be.closeTo(
                initialPrice,
                ethers.utils.parseUnits('0.01', 8)
            );
        });

        it('should handle multiple fee tiers', async () => {
            // Create a new pool with a different fee tier
            const FEE_AMOUNT_MEDIUM = {
                FEE_AMOUNT: constant.FEE_AMOUNT.MEDIUM,
                TICK_LOWER: constant.getMinTick(constant.TICK_SPACINGS[constant.FEE_AMOUNT.MEDIUM]),
                TICK_UPPER: constant.getMaxTick(constant.TICK_SPACINGS[constant.FEE_AMOUNT.MEDIUM]),
            };

            const addresses: Addresses = {
                token1: uniswapV3.WETH9.address,
                token2: uniswapV3.ERC20.address
            };

            // Calculate sqrtPriceX96 for 0.35 ERC20 per 1 WETH
            const targetPrice = 0.35;
            const sqrtPriceX96 = TickMath.getSqrtRatioAtTick(
                Math.floor(Math.log(targetPrice) / Math.log(1.0001))
            ).toString();

            const newPoolAddress = await createPool(
                owner as any,
                addresses,
                FEE_AMOUNT_MEDIUM,
                sqrtPriceX96
            );
            console.log('New pool created at:', newPoolAddress);

            // Add both pools to PriceOracle
            await priceOracle.addPool(
                poolAddress,
                uniswapV3.WETH9.address,
                uniswapV3.ERC20.address
            );
            console.log('Added first pool to PriceOracle');

            await priceOracle.addPool(
                newPoolAddress,
                uniswapV3.WETH9.address,
                uniswapV3.ERC20.address
            );
            console.log('Added second pool to PriceOracle');

            // Verify pools are added
            const pool1Config = await priceOracle.pools(poolAddress);
            const pool2Config = await priceOracle.pools(newPoolAddress);
            console.log('Pool configs:', {
                pool1: { isActive: pool1Config.isActive },
                pool2: { isActive: pool2Config.isActive }
            });

            // Mint liquidity to the new pool
            await mint(
                owner as any,
                addresses,
                FEE_AMOUNT_MEDIUM,
                '17.5',  // Will be doubled to 35 WETH
                '50'  // Will be doubled to 100 ERC20
            );
            console.log('Minted liquidity to new pool');

            // Update price and verify
            await priceOracle.updatePrice();
            const currentPrice = await priceOracle.getPrice();
            console.log('Current price:', currentPrice.toString());
            
            // Price should be close to target price
            expect(currentPrice).to.be.closeTo(
                ethers.utils.parseUnits(targetPrice.toString(), 8),
                ethers.utils.parseUnits('0.01', 8)
            );
        });

        it('should handle edge cases in price calculation', async () => {
            // Test with very small price
            const targetPrice = 0.000001;
            const smallSqrtPriceX96 = TickMath.getSqrtRatioAtTick(
                Math.floor(Math.log(targetPrice) / Math.log(1.0001))
            ).toString();

            const addresses: Addresses = {
                token1: uniswapV3.WETH9.address,
                token2: uniswapV3.ERC20.address
            };

            // Create a new pool with very small amounts
            const newPoolAddress = await createPool(
                owner as any,
                addresses,
                FEE_AMOUNT_LOW,
                smallSqrtPriceX96
            );

            // Add pool to PriceOracle
            await priceOracle.addPool(
                newPoolAddress,
                uniswapV3.WETH9.address,
                uniswapV3.ERC20.address
            );

            // Mint minimal liquidity
            await mint(
                owner as any,
                addresses,
                FEE_AMOUNT_LOW,
                '0.0001',  // Will be doubled to 0.0002 WETH
                '0.0000001'  // Will be doubled to 0.0000002 ERC20
            );

            // Update price and verify
            await priceOracle.updatePrice();
            const currentPrice = await priceOracle.getPrice();
            console.log('Current price:', currentPrice.toString());
            
            // Price should be close to target price
            expect(currentPrice).to.be.closeTo(
                ethers.utils.parseUnits(targetPrice.toString(), 8),
                ethers.utils.parseUnits('0.000001', 8)
            );
        });
    });

    describe('Error Handling', () => {
        it('should revert when adding invalid pool', async () => {
            await expect(
                priceOracle.addPool(
                    ethers.constants.AddressZero,
                    uniswapV3.WETH9.address,
                    uniswapV3.ERC20.address
                )
            ).to.be.revertedWith('Invalid pool address');
        });

        it('should revert when removing non-existent pool', async () => {
            await expect(
                priceOracle.removePool(ethers.constants.AddressZero)
            ).to.be.revertedWith('Pool not active');
        });

        it('should handle non-existent pools in updatePrice', async () => {
            // This should not revert, just skip non-existent pools
            await expect(priceOracle.updatePrice()).to.not.be.reverted;
        });
    });
}); 