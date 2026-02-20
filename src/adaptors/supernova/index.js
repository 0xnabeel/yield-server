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

const PROJECT = 'supernova';
const CHAIN = 'ethereum';
const SUBGRAPH =
  'https://api.goldsky.com/api/public/project_cm8gyxv0x02qv01uphvy69ey6/subgraphs/sn-basic-pools-mainnet/basicsnmainnet/gn';

const query = gql`
  {
    pairs(first: 1000, orderBy: reserveUSD, orderDirection: desc, block: {number: <PLACEHOLDER>}) {
      id
      reserve0
      reserve1
      untrackedVolumeUSD
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
  // calculate apy
  dataNow = dataNow.map((el) => utils.apy(el, dataPrior, dataPrior7d, 'v3'));

  const pools = {};
  for (const p of dataNow.filter(
    (p) => p.volumeUSD1d >= 0 && (!isNaN(p.apy1d) || !isNaN(p.apy7d))
  )) {
    const url = 'https://supernova.xyz/liquidity';
    const underlyingTokens = [p.token0.id, p.token1.id];

    const poolAddress = utils.formatAddress(p.id);
    pools[poolAddress] = {
      pool: poolAddress,
      chain: utils.formatChain(CHAIN),
      project: PROJECT,
      symbol: `${p.token0.symbol}-${p.token1.symbol}`,
      tvlUsd: p.totalValueLockedUSD,
      apyBase: p.apy1d,
      apyBase7d: p.apy7d,
      underlyingTokens,
      url,
      volumeUsd1d: p.volumeUSD1d,
      volumeUsd7d: p.volumeUSD7d,
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

  console.log("allPairsLength", allPairsLength)

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

  console.log("allPools", allPools)

  const metaData = (
    await sdk.api.abi.multiCall({
      calls: allPools.map((i) => ({
        target: i,
      })),
      abi: abiPool.find((m) => m.name === 'metadata'),
      chain: CHAIN,
    })
  ).output.map((o) => o.output);

  console.log("metaData", metaData)

  const symbols = (
    await sdk.api.abi.multiCall({
      calls: allPools.map((i) => ({
        target: i,
      })),
      abi: abiPool.find((m) => m.name === 'symbol'),
      chain: CHAIN,
    })
  ).output.map((o) => o.output);

  console.log("symbols", symbols)

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

  console.log("gauges", gauges)

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

  console.log("validIndices", validIndices)

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

  console.log("rewardRate", rewardRate)

  const poolSupply = (
    await sdk.api.abi.multiCall({
      calls: validPools.map((i) => ({ target: i })),
      chain: CHAIN,
      abi: 'erc20:totalSupply',
      permitFailure: true,
    })
  ).output.map((o) => o.output);

  console.log("poolSupply", poolSupply)

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

  console.log("totalSupply", totalSupply)

  const tokens = [
    ...new Set(
      metaData
        .map((m) => [m.t0, m.t1])
        .flat()
        .concat(SNOVA)
    ),
  ];

  console.log("tokens", tokens)

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
  console.log("pricesA", pricesA)
  let prices = {};
  for (const p of pricesA.flat()) {
    prices = { ...prices, ...p };
  }

  console.log("prices", prices)

  const pools = validPools.map((p, i) => {
    const originalIndex = validIndices[i];
    const poolMeta = metaData[originalIndex];
    const r0 = poolMeta.r0 / poolMeta.dec0;
    const r1 = poolMeta.r1 / poolMeta.dec1;

    const p0 = prices[`${CHAIN}:${poolMeta.t0}`]?.price || 0;
    const p1 = prices[`${CHAIN}:${poolMeta.t1}`]?.price || 0;

    const tvlUsd = r0 * p0 + r1 * p1;

    const s = symbols[originalIndex];

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
      symbol: utils.formatSymbol(s.split('-')[1]),
      tvlUsd,
      apyReward,
      rewardTokens: apyReward ? [SNOVA] : [],
      underlyingTokens: [poolMeta.t0, poolMeta.t1],
      url: `https://supernova.xyz/deposit?token0=${poolMeta.t0}&token1=${poolMeta.t1}&type=-1`,
    };
  });

  console.log("pools", pools)

  const poolsApy = {};
  console.log("pools filtered: ", pools.filter((p) => utils.keepFinite(p)))
  for (const pool of pools.filter((p) => utils.keepFinite(p))) {
    poolsApy[pool.pool] = pool;
  }

  console.log("poolsApy", poolsApy)

  return poolsApy;
};

async function main(timestamp = null) {
  const poolsApy = await getGaugeApy();
  console.log("poolsApy", poolsApy)
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
