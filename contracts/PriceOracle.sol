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
        
        // Initialize with a default price of 0.35 USD-TCoin per 1 WCTC
        price = 35000000; // 0.35 with 8 decimals
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

    function _updatePrice() internal {
        uint256 oldPrice = uint256(price);
        int256 totalPrice;
        uint256 activePools;
        
        // First check existing pools
        for (uint i = 0; i < poolList.length; i++) {
            PoolConfig memory pool = pools[poolList[i]];
            if (!pool.isActive) continue;
            
            IUniswapV3Pool v3Pool = IUniswapV3Pool(pool.poolAddress);
            (uint160 sqrtPriceX96, int24 tick,,,,,) = v3Pool.slot0();
            
            // Calculate price from sqrtPriceX96
            uint256 priceFromPool = calculatePriceFromSqrtPriceX96(
                sqrtPriceX96,
                pool.token0Decimals,
                pool.token1Decimals
            );
            
            totalPrice += int256(priceFromPool);
            activePools++;
        }
        
        // Then check for new pools
        for (uint i = 0; i < feeTiers.length; i++) {
            address poolAddress = IUniswapV3Factory(factory).getPool(WCTC, USD_TCoin, feeTiers[i]);
            if (poolAddress == address(0)) continue;
            
            // If pool exists but not in our list or is inactive, add/activate it
            if (!pools[poolAddress].isActive) {
                // If pool exists in our list but is inactive, just activate it
                if (pools[poolAddress].poolAddress != address(0)) {
                    pools[poolAddress].isActive = true;
                } else {
                    // Otherwise add it as a new pool
                    addPool(poolAddress, WCTC, USD_TCoin);
                }
                
                // Get price from new/activated pool
                IUniswapV3Pool v3Pool = IUniswapV3Pool(poolAddress);
                (uint160 sqrtPriceX96, int24 tick,,,,,) = v3Pool.slot0();
                
                uint256 priceFromPool = calculatePriceFromSqrtPriceX96(
                    sqrtPriceX96,
                    IERC20(WCTC).decimals(),
                    IERC20(USD_TCoin).decimals()
                );
                
                totalPrice += int256(priceFromPool);
                activePools++;
            }
        }
        
        // If no active pools, keep the current price
        if (activePools == 0) {
            return;
        }
        
        // Update price with average of all active pools
        price = totalPrice / int256(activePools);
        emit PriceUpdated(price);
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
    ) external nonReentrant {
        // Only process swaps from our tracked pools
        PoolConfig memory poolConfig = pools[pool];
        if (!poolConfig.isActive) return;

        // Calculate new price directly from the swap's sqrtPriceX96
        uint256 priceFromSwap = calculatePriceFromSqrtPriceX96(
            sqrtPriceX96,
            poolConfig.token0Decimals,
            poolConfig.token1Decimals
        );

        // Update price immediately with this pool's price
        price = int256(priceFromSwap);
        emit PriceUpdated(price);
    }
    
    function calculatePriceFromSqrtPriceX96(
        uint160 sqrtPriceX96,
        uint8 token0Decimals,
        uint8 token1Decimals
    ) internal pure returns (uint256) {
        // Convert sqrtPriceX96 to uint256 for more precision
        uint256 sqrtPrice = uint256(sqrtPriceX96);
        
        // Square the price and maintain precision
        uint256 priceQ192 = (sqrtPrice * sqrtPrice);
        
        // Scale to our target decimals (8) while maintaining precision
        uint256 price = priceQ192;
        
        // Adjust for decimal differences between tokens first
        if (token1Decimals > token0Decimals) {
            price = price * (10 ** uint256(token1Decimals - token0Decimals));
        } else if (token0Decimals > token1Decimals) {
            price = price / (10 ** uint256(token0Decimals - token1Decimals));
        }
        
        // Now scale to our 8 decimals format
        // We need to divide by 2^192 (96 * 2 for squaring)
        // And multiply by 10^8 for our decimal format
        price = (price * (10 ** 8)) >> 192;
        
        return price;
    }
    
    // Price getter functions
    function getPrice() external view override returns (uint256) {
        return uint256(price);
    }
    
    function getDecimals() external view returns (uint8) {
        return decimals_;
    }
} 
