// SPDX-License-Identifier: MIT
pragma solidity ^0.7.6;
pragma abicoder v2;

import "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import "../interfaces/IUniswapV3Factory.sol";
import "../interfaces/IUniswapV3Pools.sol";
import "../interfaces/INonfungiblePositionManager.sol";
import "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import "../interfaces/IMultiAMM.sol";
import "../libs/PriceLib.sol"; 
import "../interfaces/ILiquidityManager.sol";
import "hardhat/console.sol";
import "../ETHPriceStorage.sol";
import "../SqrtPriceCalculator.sol";
import "./CollectFeesManager.sol";

abstract contract LiquidityManager is ILiquidityManager, SqrtPriceCalculator, CollectFeesManager {
    using PriceLib for address;

    IUniswapV3Factory public immutable factory;
    ISwapRouter public immutable swapRouter;
    IMultiAMM public immutable amm;
    address public immutable WETH9;
    mapping(address => bool) public whitelisted;
    ETHPriceStorage public ethPriceStorage;
    uint256 public constant MARKET_CAP_THRESHOLD = 85_000 * 1e8;

    modifier onlyWhitelisted() {
        require(whitelisted[msg.sender], "Only whitelisted users can call this function");
        _;
    }

    constructor(
        address _factory,
        address _nonfungiblePositionManager,
        address _swapRouter,
        address _weth9,
        address _amm,
        address _ico,
        address _ethPriceStorage
    ) CollectFeesManager(_nonfungiblePositionManager, msg.sender) {
        factory = IUniswapV3Factory(_factory);
        nonfungiblePositionManager = INonfungiblePositionManager(_nonfungiblePositionManager);
        swapRouter = ISwapRouter(_swapRouter);
        WETH9 = _weth9;
        amm = IMultiAMM(_amm);
        whitelisted[owner] = true;
        whitelisted[_ico] = true;
        ethPriceStorage = ETHPriceStorage(_ethPriceStorage);
    }

    function getOwnerShares(address tokenAddress) external view override returns (uint256, uint256) {
        return amm.getUserShare(tokenAddress, WETH9, msg.sender);
    }

    function getTokenPrice(address tokenAddress, address tokenB) external view override returns (uint256 priceAinB, uint256 priceBinA) {
        return amm.getTokenPrice(tokenAddress, tokenB);
    }

    function addWhitelistedUser(address user) external override onlyOwner {
        whitelisted[user] = true;
    }

    function removeWhitelistedUser(address user) external override onlyOwner {
        whitelisted[user] = false;
    }

    function createPool(
        address tokenA,
        address tokenB,
        uint24 fee,
        uint256 amountA,
        uint256 amountB,
        uint160 sqrtPriceX96
    ) public virtual override onlyWhitelisted returns (
        address poolAddress
    ) {
        require(tokenA != tokenB, "Identical addresses");
        require(amountA > 0 && amountB > 0, "Amounts must be greater than 0");
        require(tokenA != address(0) && tokenB != address(0), "Invalid token addresses");

        // Sort tokens for pool creation
        (address token0, address token1) = tokenA < tokenB 
            ? (tokenA, tokenB) 
            : (tokenB, tokenA);

        if (factory.getPool(tokenA, tokenB, fee) == address(0)) {
            poolAddress = nonfungiblePositionManager.createAndInitializePoolIfNecessary(
                token0,
                token1,
                fee,
                sqrtPriceX96
            );
            require(poolAddress != address(0), "Pool creation failed.");
            
            emit PoolCreated(poolAddress);
        } else {
            poolAddress = factory.getPool(tokenA, tokenB, fee);
        }

        return poolAddress;
    }

    function mintPosition(
        MintPositionParams calldata params
    ) public virtual override onlyWhitelisted returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1) {
        address poolAddress = factory.getPool(params.tokenA, params.tokenB, params.fee);
        require(poolAddress != address(0), "Pool does not exist");

        // Transfer tokens to this contract first
        require(IERC20(params.tokenA).transferFrom(msg.sender, address(this), params.amountA), "Transfer A failed");
        require(IERC20(params.tokenB).transferFrom(msg.sender, address(this), params.amountB), "Transfer B failed");

        // Approve tokens for the position manager
        require(IERC20(params.tokenA).approve(address(nonfungiblePositionManager), params.amountA), "Token A approval failed");
        require(IERC20(params.tokenB).approve(address(nonfungiblePositionManager), params.amountB), "Token B approval failed");

        // Sort tokens
        require(params.tokenA != params.tokenB, 'IDENTICAL_ADDRESSES');
        (address token0, address token1) = params.tokenA < params.tokenB 
            ? (params.tokenA, params.tokenB) 
            : (params.tokenB, params.tokenA);
        require(token0 != address(0), 'ZERO_ADDRESS');

        // Determine amounts based on sorted tokens
        (uint256 amount0Desired, uint256 amount1Desired) = token0 == params.tokenA 
            ? (params.amountA, params.amountB)
            : (params.amountB, params.amountA);

        INonfungiblePositionManager.MintParams memory mintParams = INonfungiblePositionManager.MintParams({
            token0: token0,
            token1: token1,
            fee: params.fee,
            tickLower: params.tickLower,
            tickUpper: params.tickUpper,
            amount0Desired: amount0Desired,
            amount1Desired: amount1Desired,
            amount0Min: params.amount0Min,
            amount1Min: params.amount1Min,
            recipient: params.recipient,
            deadline: params.deadline
        });

        (tokenId, liquidity, amount0, amount1) = nonfungiblePositionManager.mint(mintParams);
        require(tokenId != 0, "Minting position failed");

        emit LiquidityAdded(
            tokenId,
            poolAddress,
            params.tokenA,
            params.tokenB
        );
    }

    function bundleLiquidity(
        MintPositionParams calldata params
    ) public virtual override onlyWhitelisted returns (address poolAddress, uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1) {
        poolAddress = createPool(
            params.tokenA,
            params.tokenB,
            params.fee,
            params.amountA,
            params.amountB,
            params.sqrtPriceX96
        );
        require(poolAddress != address(0), "Pool creation failed");
        
        (tokenId, liquidity, amount0, amount1) = mintPosition(params);
        require(tokenId != 0, "Minting position failed");
    }

    function bondingCurve(address tokenAddress) internal returns (uint256 tokenId) {
        // Check if the market cap is above the threshold
        uint256 marketCap = getMarketCapInUSD(tokenAddress);
        if (marketCap >= MARKET_CAP_THRESHOLD) {

            // Withdraw liquidity from AMM
            (uint share, ) = amm.getUserShare(tokenAddress, WETH9, address(this));
            (uint amountAOut, uint amountBOut) = amm.removeLiquidity(tokenAddress, WETH9, share);

            // Determine token0 and token1 based on address
            uint256 adjustedRatio = (amountBOut * 10**18) / amountAOut; // token1/token0
            uint160 sqrtPriceX96 = calculateSqrtPriceX96(adjustedRatio);

            (int24 tickLower, int24 tickUpper) = calculateTicks(sqrtPriceX96, FEE_HIGH, true);

            (address token0, address token1) = tokenAddress < WETH9 
                ? (tokenAddress, WETH9) 
                : (WETH9, tokenAddress);
            
            MintPositionParams memory mintParams = MintPositionParams({
                tokenA: token0,
                tokenB: token1,
                fee: FEE_HIGH,
                tickLower: tickLower,
                tickUpper: tickUpper,
                amountA: token0 == tokenAddress ? amountAOut : amountBOut,  // Match sorted amounts
                amountB: token0 == tokenAddress ? amountBOut : amountAOut,
                amount0Min: 0,
                amount1Min: 0,
                recipient: address(this),
                deadline: block.timestamp + 1000,
                sqrtPriceX96: sqrtPriceX96
            });
            
            (, tokenId, , , ) = this.bundleLiquidity(mintParams);
        }
    }

    function getTokenPriceInUSD(address tokenAddress) public view returns (uint256) {
        uint256 ethPrice = ethPriceStorage.getPrice();
        (uint256 priceInWETH, ) = amm.getTokenPrice(tokenAddress, WETH9);
        return (priceInWETH * ethPrice) / 10**8; // Adjust for decimals
    }

    function getMarketCapInUSD(address tokenAddress) public view returns (uint256 marketCapInUSD) {
        uint256 ethPrice = ethPriceStorage.getPrice();
        (uint256 priceInWETH, ) = amm.getTokenPrice(tokenAddress, WETH9);
        uint256 totalSupply = IERC20(tokenAddress).totalSupply();
        return (totalSupply * priceInWETH * ethPrice) / 10**26; // Adjust for decimals
    }

    function withdrawFees(address token0, address token1) external onlyWhitelisted {
        require(IERC20(token0).transfer(msg.sender, IERC20(token0).balanceOf(address(this))), "Token0 transfer failed");
        require(IERC20(token1).transfer(msg.sender, IERC20(token1).balanceOf(address(this))), "Token1 transfer failed");
    }
}

