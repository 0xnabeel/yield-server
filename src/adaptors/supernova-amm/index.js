const sdk = require('@defillama/sdk');
const axios = require('axios');
const { request, gql } = require('graphql-request');
const utils = require('../utils');

const abiPool = require('./abiPool.json');
const abiGauge = require('./abiGauge.json');
const abiVoter = require('./abiVoter.json');
const abiPoolsFactory = require('./abiPoolsFactory.json');

const poolsFactory = '0x5aEf44EDFc5A7eDd30826c724eA12D7Be15bDc30';
const gaugeManager = '0x19a410046Afc4203AEcE5fbFc7A6Ac1a4F517AE2';
const SNOVA = '0x00Da8466B296E382E5Da2Bf20962D0cB87200c78';

const PROJECT = 'supernova-amm';
const CHAIN = 'ethereum';
const SUBGRAPH =
  'https://api.goldsky.com/api/public/project_cm8gyxv0x02qv01uphvy69ey6/subgraphs/sn-basic-pools-mainnet/basicsnmainnet/gn';

const query = gql`
  {
    pairs(first: 1000, orderBy: reserveUSD, orderDirection: desc, block: {number: <PLACEHOLDER>}) {
      id
      reserve0
      reserve1
      volumeUSD
      fee
      token0 {
        symbol
        id
      }
      token1 {
        symbol
        id
      }
    }
  }
`;

const queryPrior = gql`
  {
    pairs (first: 1000 orderBy: reserveUSD orderDirection: desc, block: {number: <PLACEHOLDER>}) { 
      id 
      volumeUSD 
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
  dataNow = dataNow.pairs;

  // pull 24h offset data to calculate fees from swap volume
  let queryPriorC = queryPrior;
  let dataPrior = await request(
    SUBGRAPH,
    queryPriorC.replace('<PLACEHOLDER>', blockPrior)
  );
  dataPrior = dataPrior.pairs;

  // 7d offset
  const dataPrior7d = (
    await request(SUBGRAPH, queryPriorC.replace('<PLACEHOLDER>', blockPrior7d))
  ).pairs;

  // calculate tvl
  dataNow = await utils.tvl(dataNow, CHAIN);
  // map fee to feeTier (0.01 -> 1% -> 10000)
  dataNow = dataNow.map((p) => ({
    ...p,
    feeTier: Number(p.fee) * 1000000,
    // ensure volumeUSD is a number
    volumeUSD: p.volumeUSD || 0
  }));
  // calculate apy
  dataNow = dataNow.map((el) => {
    // handle case where prior volume is missing
    const p1d = dataPrior.find(p => p.id === el.id);
    const p7d = dataPrior7d.find(p => p.id === el.id);
    return utils.apy(el, p1d ? [p1d] : [], p7d ? [p7d] : []);
  });

  const pools = {};
  for (const p of dataNow) {
    const poolAddress = utils.formatAddress(p.id);
    // utils.apy might return NaN if volume data is missing
    const apyBase = isNaN(p.apy1d) ? 0 : p.apy1d;
    const apyBase7d = isNaN(p.apy7d) ? 0 : p.apy7d;
    const volumeUsd1d = isNaN(p.volumeUSD1d) ? 0 : p.volumeUSD1d;
    const volumeUsd7d = isNaN(p.volumeUSD7d) ? 0 : p.volumeUSD7d;

    const url = 'https://supernova.xyz/liquidity';
    const underlyingTokens = [p.token0.id, p.token1.id];

    pools[poolAddress] = {
      pool: poolAddress,
      chain: utils.formatChain(CHAIN),
      project: PROJECT,
      symbol: `${p.token0.symbol}-${p.token1.symbol}`,
      tvlUsd: p.totalValueLockedUSD,
      apyBase,
      apyBase7d,
      underlyingTokens,
      url,
      volumeUsd1d,
      volumeUsd7d,
    };
  }

  return pools;
}

const getGaugeApy = async () => {
  const allPairsLength = (
    await sdk.api.abi.call({
      target: poolsFactory,
      abi: abiPoolsFactory.find((m) => m.name === 'allPairsLength'),
      chain: CHAIN,
    })
  ).output;

  const allPools = (
    await sdk.api.abi.multiCall({
      calls: [...Array(Number(allPairsLength)).keys()].map((i) => ({
        target: poolsFactory,
        params: [i],
      })),
      abi: abiPoolsFactory.find((m) => m.name === 'allPairs'),
      chain: CHAIN,
    })
  ).output.map((o) => o.output);

  const metaData = (
    await sdk.api.abi.multiCall({
      calls: allPools.map((i) => ({
        target: i,
      })),
      abi: abiPool.find((m) => m.name === 'metadata'),
      chain: CHAIN,
    })
  ).output.map((o) => o.output);

  const symbols = (
    await sdk.api.abi.multiCall({
      calls: allPools.map((i) => ({
        target: i,
      })),
      abi: abiPool.find((m) => m.name === 'symbol'),
      chain: CHAIN,
    })
  ).output.map((o) => o.output);

  const gauges = (
    await sdk.api.abi.multiCall({
      calls: allPools.map((i) => ({
        target: gaugeManager,
        params: [i],
      })),
      abi: abiVoter.find((m) => m.name === 'gauges'),
      chain: CHAIN,
    })
  ).output.map((o) => o.output);

  // remove pools without valid gauges
  const validIndices = [];
  const validGauges = [];
  const validPools = [];

  gauges.forEach((gauge, index) => {
    if (gauge && gauge !== '0x0000000000000000000000000000000000000000') {
      validIndices.push(index);
      validGauges.push(gauge);
      validPools.push(allPools[index]);
    }
  });

  const rewardRate = (
    await sdk.api.abi.multiCall({
      calls: validGauges.map((i) => ({
        target: i,
      })),
      abi: abiGauge.find((m) => m.name === 'rewardRate'),
      chain: CHAIN,
      permitFailure: true,
    })
  ).output.map((o) => o.output);

  const poolSupply = (
    await sdk.api.abi.multiCall({
      calls: validPools.map((i) => ({ target: i })),
      chain: CHAIN,
      abi: 'erc20:totalSupply',
      permitFailure: true,
    })
  ).output.map((o) => o.output);

  const totalSupply = (
    await sdk.api.abi.multiCall({
      calls: validGauges.map((i) => ({
        target: i,
      })),
      abi: abiGauge.find((m) => m.name === 'totalSupply'),
      chain: CHAIN,
      permitFailure: true,
    })
  ).output.map((o) => o.output);

  const tokens = [
    ...new Set(
      metaData
        .map((m) => [m.t0, m.t1])
        .flat()
        .concat(SNOVA)
    ),
  ];

  const maxSize = 50;
  const pages = Math.ceil(tokens.length / maxSize);
  let pricesA = [];
  let x = '';
  for (const p of [...Array(pages).keys()]) {
    x = tokens
      .slice(p * maxSize, maxSize * (p + 1))
      .map((i) => `${CHAIN}:${i}`)
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

  const pools = validPools.map((p, i) => {
    const originalIndex = validIndices[i];
    const poolMeta = metaData[originalIndex];
    const s = symbols[originalIndex];
    const r0 = poolMeta.r0 / poolMeta.dec0;
    const r1 = poolMeta.r1 / poolMeta.dec1;

    const p0 = prices[`${CHAIN}:${poolMeta.t0}`]?.price || 0;
    const p1 = prices[`${CHAIN}:${poolMeta.t1}`]?.price || 0;

    const tvlUsd = r0 * p0 + r1 * p1;

    const pairPrice = tvlUsd > 0 && totalSupply[i] > 0
      ? (tvlUsd * 1e18) / totalSupply[i]
      : 0;

    // Only staked supply is eligible for the rewardRate's emissions
    let stakedSupplyRatio = 1;
    if (totalSupply[i] && totalSupply[i] !== '0') {
      stakedSupplyRatio = poolSupply[i] / totalSupply[i];
    }

    const snovaPrice = prices[`${CHAIN}:${SNOVA}`]?.price || 0;
    const apyReward =
      tvlUsd > 0 && snovaPrice > 0
        ? (((rewardRate[i] / 1e18) * 86400 * 365 * snovaPrice) / tvlUsd) *
        stakedSupplyRatio *
        100
        : 0;

    return {
      pool: utils.formatAddress(p),
      chain: utils.formatChain(CHAIN),
      project: PROJECT,
      symbol: s.includes('-') ? s.split('-').slice(1).join('-').replace('/', '-') : s,
      tvlUsd,
      apyReward,
      rewardTokens: apyReward ? [SNOVA] : [],
      underlyingTokens: [poolMeta.t0, poolMeta.t1],
      url: `https://supernova.xyz/deposit?token0=${poolMeta.t0}&token1=${poolMeta.t1}&type=-1`,
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
  let poolsVolumes = {};
  try {
    poolsVolumes = await getPoolVolumes(timestamp);
  } catch (e) {
    console.log('Failed to fetch volume data from subgraph:', e.message);
  }

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
  url: 'https://supernova.xyz/liquidity',
};
