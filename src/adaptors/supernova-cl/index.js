const sdk = require('@defillama/sdk');
const axios = require('axios');
const { request, gql } = require('graphql-request');
const utils = require('../utils');

// Supernova CL (Algebra) on Ethereum
const gaugeManager = '0x19a410046Afc4203AEcE5fbFc7A6Ac1a4F517AE2';
const SNOVA = '0x00Da8466B296E382E5Da2Bf20962D0cB87200c78';
const nullAddress = '0x0000000000000000000000000000000000000000';
const PROJECT = 'supernova-cl';
const CHAIN = 'ethereum';
const SUBGRAPH =
    'https://api.goldsky.com/api/public/project_cm8gyxv0x02qv01uphvy69ey6/subgraphs/core/algebrasnmainnet/gn';

const query = gql`
{
  pools(first: 1000, orderBy: totalValueLockedUSD, orderDirection: desc, block: {number: <PLACEHOLDER>}) {
    id
    reserve0: totalValueLockedToken0
    reserve1: totalValueLockedToken1
    volumeUSD
    volumeToken0
    fee
    token0 {
      symbol
      id
      decimals
    }
    token1 {
      symbol
      id
      decimals
    }
  }
}
`;

const queryPrior = gql`
{
  pools(first: 1000 orderBy: totalValueLockedUSD orderDirection: desc, block: {number: <PLACEHOLDER>}) { 
    id 
    volumeUSD
    volumeToken0
  }
}
`;

async function getPoolVolumes(timestamp = null) {
    const [block, blockPrior] = await utils.getBlocks(CHAIN, timestamp, [
        SUBGRAPH,
    ]);

    const [_, blockPrior7d] = await utils.getBlocks(
        CHAIN,
        timestamp,
        [SUBGRAPH],
        604800
    );

    // pull data
    let dataNow = await request(SUBGRAPH, query.replace('<PLACEHOLDER>', block));
    dataNow = dataNow.pools;

    // pull 24h offset data to calculate fees from swap volume
    let queryPriorC = queryPrior;
    let dataPrior = await request(
        SUBGRAPH,
        queryPriorC.replace('<PLACEHOLDER>', blockPrior)
    );
    dataPrior = dataPrior.pools;

    // 7d offset
    const dataPrior7d = (
        await request(SUBGRAPH, queryPriorC.replace('<PLACEHOLDER>', blockPrior7d))
    ).pools;

    // calculate tvl
    dataNow = await utils.tvl(dataNow, CHAIN);
    // calculate apy
    dataNow = dataNow.map((el) => utils.apy(el, dataPrior, dataPrior7d, 'v3'));

    const pools = {}
    for (const p of dataNow.filter(p => p.volumeUSD1d >= 0 && (!isNaN(p.apy1d) || !isNaN(p.apy7d)))) {
        const url = 'https://supernova.xyz/liquidity/' + p.id;
        const poolMeta = 'CL' + ' - ' + (Number(p.feeTier) / 10000).toString() + '%';
        const underlyingTokens = [p.token0.id, p.token1.id];

        const poolAddress = utils.formatAddress(p.id);
        pools[poolAddress] = {
            pool: poolAddress,
            chain: utils.formatChain('base'),
            project: PROJECT,
            poolMeta,
            symbol: `${p.token0.symbol}-${p.token1.symbol}`,
            tvlUsd: p.totalValueLockedUSD,
            apyBase: p.apy1d,
            apyBase7d: p.apy7d,
            underlyingTokens,
            url,
            volumeUsd1d: p.volumeUSD1d,
            volumeUsd7d: p.volumeUSD7d,
        }
    }

    return pools;
}

const getGaugeApy = async () => {
    const chunkSize = 400;
    let currentOffset = 1650; // Ignore older non-Slipstream pools
    let unfinished = true;
    let allPoolsData = [];

    while (unfinished) {
        const poolsChunkUnfiltered = (
            await sdk.api.abi.call({
                target: sugar,
                params: [chunkSize, currentOffset],
                abi: abiSugar.find((m) => m.name === 'all'),
                chain: 'base',
            })
        ).output;

        const poolsChunk = poolsChunkUnfiltered.filter(t => Number(t.type) > 0 && t.gauge != nullAddress);

        unfinished = poolsChunkUnfiltered.length !== 0;
        currentOffset += chunkSize;
        allPoolsData.push(...poolsChunk);
    }

    unfinished = true;
    currentOffset = 0;
    let allTokenData = [];

    while (unfinished) {
        const tokensChunk = (
            await sdk.api.abi.call({
                target: sugar,
                params: [chunkSize, currentOffset, sugar, []],
                abi: abiSugar.find((m) => m.name === 'tokens'),
                chain: 'base',
            })
        ).output;

        unfinished = tokensChunk.length !== 0;
        currentOffset += chunkSize;
        allTokenData.push(...tokensChunk);
    }

    const tokens = [
        ...new Set(
            allPoolsData
                .map((m) => [m.token0, m.token1])
                .flat()
                .concat(AERO)
        ),
    ];

    const maxSize = 50;
    const pages = Math.ceil(tokens.length / maxSize);
    let pricesA = [];
    let x = '';
    for (const p of [...Array(pages).keys()]) {
        x = tokens
            .slice(p * maxSize, maxSize * (p + 1))
            .map((i) => `base:${i}`)
            .join(',')
            .replaceAll('/', '');
        pricesA = [
            ...pricesA,
            (await axios.get(`https://coins.llama.fi/prices/current/${x}`)).data
                .coins,
        ];
    }
    let prices = {};
    for (const p of pricesA.flat()) {
        prices = { ...prices, ...p };
    }

    let allStakedData = [];
    for (let pool of allPoolsData) {
        // don't waste RPC calls if gauge has no staked liquidity
        if (Number(pool.gauge_liquidity) == 0) {
            allStakedData.push({ 'amount0': 0, 'amount1': 0 });
            continue;
        }

        const wideTickAmount = tickWidthMappings[Number(pool.type)] !== undefined ? tickWidthMappings[Number(pool.type)] : 5;
        const lowTick = Number(pool.tick) - (wideTickAmount * Number(pool.type));
        const highTick = Number(pool.tick) + ((wideTickAmount - 1) * Number(pool.type));

        const ratioA = (
            await sdk.api.abi.call({
                target: sugarHelper,
                params: [lowTick],
                abi: abiSugarHelper.find((m) => m.name === 'getSqrtRatioAtTick'),
                chain: 'base',
            })
        ).output;

        const ratioB = (
            await sdk.api.abi.call({
                target: sugarHelper,
                params: [highTick],
                abi: abiSugarHelper.find((m) => m.name === 'getSqrtRatioAtTick'),
                chain: 'base',
            })
        ).output;

        // fetch staked liquidity around wide set of ticks
        const stakedAmounts = (
            await sdk.api.abi.call({
                target: sugarHelper,
                params: [pool.sqrt_ratio, ratioA, ratioB, pool.gauge_liquidity],
                abi: abiSugarHelper.find((m) => m.name === 'getAmountsForLiquidity'),
                chain: 'base',
            })
        ).output;

        allStakedData.push(stakedAmounts);
    }

    const pools = allPoolsData.map((p, i) => {
        const token0Data = allTokenData.find(({ token_address }) => token_address == p.token0);
        const token1Data = allTokenData.find(({ token_address }) => token_address == p.token1);

        const p0 = prices[`base:${p.token0}`]?.price;
        const p1 = prices[`base:${p.token1}`]?.price;

        const tvlUsd = ((p.reserve0 / (10 ** token0Data.decimals)) * p0) + ((p.reserve1 / (10 ** token1Data.decimals)) * p1);

        // use wider staked TVL across many ticks
        const stakedTvlUsd = ((allStakedData[i]['amount0'] / (10 ** token0Data.decimals)) * p0) + ((allStakedData[i]['amount1'] / (10 ** token1Data.decimals)) * p1);

        const s = token0Data.symbol + '-' + token1Data.symbol;

        const apyReward =
            (((p.emissions / 1e18) * 86400 * 365 * prices[`base:${AERO}`]?.price) /
                stakedTvlUsd) *
            100;

        const url = 'https://supernova.xyz/liquidity/' + p.lp;
        const poolMeta = 'CL' + p.type.toString() + ' - ' + (p.pool_fee / 10000).toString() + '%';

        return {
            pool: utils.formatAddress(p.lp),
            chain: utils.formatChain('base'),
            project: PROJECT,
            symbol: s,
            tvlUsd,
            apyReward,
            rewardTokens: apyReward ? [AERO] : [],
            underlyingTokens: [p.token0, p.token1],
            poolMeta,
            url,
        };
    });

    const poolsApy = {};
    for (const pool of pools.filter((p) => utils.keepFinite(p))) {
        poolsApy[pool.pool] = pool;
    }

    return poolsApy;
};

async function main(timestamp = null) {
    const poolsApy = await getGaugeApy();
    const poolsVolumes = await getPoolVolumes(timestamp);

    // left-join volumes onto APY output to avoid filtering out pools
    return Object.values(poolsApy).map((pool) => {
        const v = poolsVolumes[pool.pool];
        return {
            ...pool,
            apyBase: v?.apyBase,
            apyBase7d: v?.apyBase7d,
            volumeUsd1d: v?.volumeUsd1d,
            volumeUsd7d: v?.volumeUsd7d,
        };
    });
}

module.exports = {
    timetravel: false,
    apy: main,
};
