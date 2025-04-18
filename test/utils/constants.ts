export const FEE_AMOUNTS = {
    LOW: 500,
    MEDIUM: 3000,
    HIGH: 10000
};

export const TICK_SPACINGS = {
    [FEE_AMOUNTS.LOW]: 10,
    [FEE_AMOUNTS.MEDIUM]: 60,
    [FEE_AMOUNTS.HIGH]: 200
};

export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

export const getMinTick = (tickSpacing: number) => Math.ceil(MIN_TICK / tickSpacing) * tickSpacing;
export const getMaxTick = (tickSpacing: number) => Math.floor(MAX_TICK / tickSpacing) * tickSpacing;

export const encodePriceSqrt = (reserve1: number, reserve0: number) => {
    return Math.sqrt(reserve1 / reserve0) * 2 ** 96;
}; 