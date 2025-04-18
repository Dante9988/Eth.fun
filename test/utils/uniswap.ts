import { ethers } from 'hardhat';
import { Signer, Contract } from 'ethers';
import UniswapV3Pool from '@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json';

export interface Addresses {
    token1: string;
    token2: string;
    factory?: string; // Optional factory address
}

export interface FeeAmount {
    FEE_AMOUNT: number;
    TICK_LOWER: number;
    TICK_UPPER: number;
}

export async function createPool(
    deployer: Signer,
    addresses: Addresses,
    feeAmount: FeeAmount,
    sqrtPriceX96: string
) {
    if (!addresses.factory) {
        throw new Error("Factory address is required. Please provide it in the addresses object.");
    }
    
    const factory = new Contract(
        addresses.factory,
        [
            'function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool)',
            'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)'
        ],
        deployer
    );

    // Check if pool already exists
    let poolAddress = await factory.getPool(
        addresses.token1,
        addresses.token2,
        feeAmount.FEE_AMOUNT
    );
    
    if (poolAddress === ethers.constants.AddressZero) {
        // Create a new pool
        await factory.createPool(
            addresses.token1,
            addresses.token2,
            feeAmount.FEE_AMOUNT
        );
        
        // Get the new pool address
        poolAddress = await factory.getPool(
            addresses.token1,
            addresses.token2,
            feeAmount.FEE_AMOUNT
        );
        
        // Initialize the pool
        const poolContract = new Contract(poolAddress, UniswapV3Pool.abi, deployer);
        await poolContract.initialize(sqrtPriceX96);
    }

    return poolAddress;
}

export async function mint(
    deployer: Signer,
    addresses: Addresses,
    feeAmount: FeeAmount,
    amount0: string,
    amount1: string
) {
    if (!addresses.factory) {
        throw new Error("Factory address is required. Please provide it in the addresses object.");
    }
    
    const signerAddress = await deployer.getAddress();
    
    const factory = new Contract(
        addresses.factory,
        [
            'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)'
        ],
        deployer
    );
    
    const poolAddress = await factory.getPool(
        addresses.token1,
        addresses.token2,
        feeAmount.FEE_AMOUNT
    );
    
    if (poolAddress === ethers.constants.AddressZero) {
        throw new Error("Pool not found. Please create the pool first.");
    }
    
    // Get the pool contract
    const poolContract = new Contract(poolAddress, UniswapV3Pool.abi, deployer);
    
    // Mint liquidity
    await poolContract.mint(
        signerAddress,
        feeAmount.TICK_LOWER,
        feeAmount.TICK_UPPER,
        ethers.utils.parseUnits(amount0, 18),
        ethers.utils.parseUnits(amount1, 18),
        '0x'
    );
}

export async function swap(
    deployer: Signer,
    addresses: Addresses,
    poolAddress: string,
    amount: string,
    zeroForOne: boolean
) {
    const poolContract = new Contract(poolAddress, UniswapV3Pool.abi, deployer);
    const signerAddress = await deployer.getAddress();
    
    await poolContract.swap(
        signerAddress,
        zeroForOne,
        ethers.utils.parseUnits(amount, 18),
        zeroForOne ? ethers.utils.parseUnits('4295128740', 0) : ethers.utils.parseUnits('1461446703485210103287273052203988822378723970341', 0),
        '0x'
    );
} 