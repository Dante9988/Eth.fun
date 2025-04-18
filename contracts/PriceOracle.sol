// SPDX-License-Identifier: MIT
pragma solidity ^0.7.6;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IPriceOracle.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import "./interfaces/IUniswapV3Factory.sol";

interface IERC20 {
    function decimals() external view returns (uint8);
}

contract PriceOracle is IPriceOracle, Ownable, ReentrancyGuard {
    struct PoolConfig {
        address poolAddress;
        address token0;
        address token1;
        uint8 token0Decimals;
        uint8 token1Decimals;
        bool isActive;
    }

    // WCTC and USD-TCoin addresses
    address public immutable WCTC;
    address public immutable USD_TCoin;
    
    // Uniswap V3 Factory address
    address public immutable factory;
    
    // Fee tiers to check
    uint24[] public feeTiers = [100, 500, 3000, 10000];
    
    int256 private price;
    uint8 private decimals_ = 8;
    mapping(address => PoolConfig) public pools;
    address[] public poolList;
    
    event PoolAdded(address indexed pool, address token0, address token1);
    event PoolRemoved(address indexed pool);
    event PriceUpdated(int256 newPrice);
    event PriceUpdateFailed();
    
    constructor(
        address _factory,
        address _wctc,
        address _usdTcoin
    ) {
        require(_factory != address(0), "Invalid factory address");
        require(_wctc != address(0), "Invalid WCTC address");
        require(_usdTcoin != address(0), "Invalid USD-TCoin address");
        
        factory = _factory;
        WCTC = _wctc;
        USD_TCoin = _usdTcoin;
        
        // Initially set price to 0, will be updated correctly when updatePrice() is called
        price = 0;
    }
    
    // Helper function to debug pool information
    function debugPool(address poolAddress) external view returns (
        address token0,
        address token1,
        uint8 token0Decimals,
        uint8 token1Decimals,
        uint160 sqrtPriceX96,
        int24 tick,
        uint128 liquidity,
        bool isActive
    ) {
        if (poolAddress == address(0)) return (address(0), address(0), 0, 0, 0, 0, 0, false);
        
        PoolConfig memory pool = pools[poolAddress];
        
        IUniswapV3Pool v3Pool = IUniswapV3Pool(poolAddress);
        (uint160 _sqrtPriceX96, int24 _tick,,,,,) = v3Pool.slot0();
        uint128 _liquidity = v3Pool.liquidity();
        
        return (
            pool.token0,
            pool.token1,
            pool.token0Decimals,
            pool.token1Decimals,
            _sqrtPriceX96,
            _tick,
            _liquidity,
            pool.isActive
        );
    }
    
    // Helper function to process a pool and get its price
    function _processPool(address poolAddress) private view returns (uint256 priceFromPool, uint128 liquidity) {
        if (poolAddress == address(0)) return (0, 0);
        
        IUniswapV3Pool v3Pool = IUniswapV3Pool(poolAddress);
        (uint160 sqrtPriceX96, int24 tick,,,,,) = v3Pool.slot0();
        liquidity = v3Pool.liquidity();
        
        // Skip pools with no liquidity
        if (liquidity == 0) return (0, 0);
        
        // Get tokens in correct order
        address token0 = v3Pool.token0();
        address token1 = v3Pool.token1();
        
        // Get decimals from the actual tokens - not from the stored pool config
        // This ensures we always have the right decimal values
        uint8 token0Decimals = IERC20(token0).decimals();
        uint8 token1Decimals = IERC20(token1).decimals();
        
        // Calculate price based on token ordering
        if (token0 == WCTC && token1 == USD_TCoin) {
            // Direct case: price is USD-TCoin per WCTC
            priceFromPool = calculatePriceFromSqrtPriceX96(
                sqrtPriceX96,
                token0Decimals,
                token1Decimals
            );
        } else if (token1 == WCTC && token0 == USD_TCoin) {
            // Inverse case: price is WCTC per USD-TCoin, need to invert
            uint256 inversePrice = calculatePriceFromSqrtPriceX96(
                sqrtPriceX96,
                token0Decimals,
                token1Decimals
            );
            
            // Invert the price - we need USD-TCoin per WCTC, not WCTC per USD-TCoin
            // Use 10^16 to maintain precision
            if (inversePrice > 0) {
                priceFromPool = (10**16) / inversePrice;
            }
        } else {
            // For any other token pair, we treat them as general tokens
            // Get price directly from sqrtPriceX96 without token checks
            priceFromPool = calculatePriceFromSqrtPriceX96(
                sqrtPriceX96,
                token0Decimals,
                token1Decimals
            );
        }
    }
    
    function calculatePriceFromPool(
        IUniswapV3Pool v3Pool,
        uint160 sqrtPriceX96
    ) internal view returns (uint256) {
        // Following the exact same calculation that works in the test:
        // 1. sqrtPrice = sqrtPriceX96 / 2^96
        // 2. price = sqrtPrice * sqrtPrice
        // 3. scale to 8 decimals
        
        // To prevent overflow, we:
        // 1. First divide sqrtPriceX96 by 2^48 (half of 96)
        // 2. Square the result
        // 3. Divide by remaining 2^48
        // This is equivalent to: (sqrtPriceX96/2^96)^2
        uint256 sqrtPrice = uint256(sqrtPriceX96) / (2 ** 48);
        uint256 price = (sqrtPrice * sqrtPrice) / (2 ** 96);

        // Scale to 8 decimals (multiply by 10^8)
        return price * 1e8;
    }

    function _updatePrice() internal {
        uint256 bestPrice = 0;
        uint128 highestLiquidity = 0;
        
        // Check all pools, not just WCTC/USD-TCoin pools
        for (uint i = 0; i < poolList.length; i++) {
            PoolConfig memory pool = pools[poolList[i]];
            if (!pool.isActive) continue;
            
            IUniswapV3Pool v3Pool = IUniswapV3Pool(pool.poolAddress);
            (uint160 sqrtPriceX96, int24 tick,,,,,) = v3Pool.slot0();
            uint128 liquidity = v3Pool.liquidity();
            
            // Skip pools with no liquidity
            if (liquidity == 0) continue;
            
            uint256 priceFromPool = calculatePriceFromPool(v3Pool, sqrtPriceX96);
            
            // Skip pools with no price
            if (priceFromPool == 0) continue;
            
            // Track the pool with the highest liquidity
            if (liquidity > highestLiquidity) {
                highestLiquidity = liquidity;
                bestPrice = priceFromPool;
            }
        }
        
        // If we found a good price, update it
        if (bestPrice > 0) {
            price = int256(bestPrice);
            emit PriceUpdated(price);
        } else {
            emit PriceUpdateFailed();
        }
    }
    
    function addPool(
        address poolAddress,
        address token0,
        address token1
    ) public onlyOwner {
        require(poolAddress != address(0), "Invalid pool address");
        require(token0 != address(0) && token1 != address(0), "Invalid token addresses");
        
        // Check if pool already exists
        if (pools[poolAddress].poolAddress != address(0)) {
            // If pool exists but is inactive, reactivate it
            if (!pools[poolAddress].isActive) {
                pools[poolAddress].isActive = true;
                emit PoolAdded(poolAddress, token0, token1);
            }
            return;
        }
        
        uint8 token0Decimals = IERC20(token0).decimals();
        uint8 token1Decimals = IERC20(token1).decimals();
        
        pools[poolAddress] = PoolConfig({
            poolAddress: poolAddress,
            token0: token0,
            token1: token1,
            token0Decimals: token0Decimals,
            token1Decimals: token1Decimals,
            isActive: true
        });
        
        poolList.push(poolAddress);
        emit PoolAdded(poolAddress, token0, token1);
    }
    
    function removePool(address poolAddress) external onlyOwner {
        require(pools[poolAddress].isActive, "Pool not active");
        pools[poolAddress].isActive = false;
        emit PoolRemoved(poolAddress);
    }
    
    // This function should be called by a keeper or external service
    function updatePrice() external override {
        _updatePrice();
    }

    // This function should be called by a keeper or external service
    // that listens to Uniswap V3 Swap events
    function onSwap(
        address pool,
        address sender,
        address recipient,
        int256 amount0,
        int256 amount1,
        uint160 sqrtPriceX96,
        uint128 liquidity,
        int24 tick
    ) external override {
        // Only process swaps from our tracked pools
        PoolConfig memory poolConfig = pools[pool];
        if (!poolConfig.isActive) return;

        IUniswapV3Pool v3Pool = IUniswapV3Pool(pool);
        uint256 priceFromSwap = calculatePriceFromPool(v3Pool, sqrtPriceX96);

        // Only update price if it's non-zero
        if (priceFromSwap > 0) {
            price = int256(priceFromSwap);
            emit PriceUpdated(price);
        }
    }
    
    function calculatePriceFromSqrtPriceX96(
        uint160 sqrtPriceX96,
        uint8 token0Decimals,
        uint8 token1Decimals
    ) internal pure returns (uint256) {
        if (sqrtPriceX96 == 0) return 0;

        uint256 sqrtPrice = uint256(sqrtPriceX96);
        uint256 priceQ192 = sqrtPrice * sqrtPrice;
        int256 decimalDiff = int256(token1Decimals) - int256(token0Decimals);

        uint256 numerator = priceQ192 * 1e8; // Apply scale first (before dividing)
        uint256 denominator = 2 ** 192;

        if (decimalDiff > 0) {
            numerator *= 10 ** uint256(decimalDiff);
        } else if (decimalDiff < 0) {
            denominator *= 10 ** uint256(-decimalDiff);
        }

        return numerator / denominator;
    }
    
    // Price getter functions
    function getPrice() external view override returns (uint256) {
        return uint256(price);
    }
    
    function getDecimals() external view returns (uint8) {
        return decimals_;
    }

    // Add a function to force update the price (for emergencies or initialization)
    function forceUpdatePrice(uint256 newPrice) external override onlyOwner {
        price = int256(newPrice);
        emit PriceUpdated(price);
    }
} 
