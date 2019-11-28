import ethAbi from 'web3-eth-abi';
import padStart from 'lodash/padStart';
import padEnd from 'lodash/padEnd';
import orderBy from 'lodash/orderBy';
import flatten from 'lodash/flatten';
import BigNumber from 'bignumber.js';
import { bytesToString } from './utils';

const formatAddress = v => '0x' + v.slice(26).toLowerCase();
const funcSigTopic = v => padEnd(ethAbi.encodeFunctionSignature(v), 66, '0');

const EVENT_GIVE = funcSigTopic('give(uint256,address)');
const EVENT_DAI_ADAPTER_EXIT = funcSigTopic('exit(address,uint256)');
const EVENT_DAI_ADAPTER_JOIN = funcSigTopic('join(address,uint256)');
const EVENT_VAT_FROB = funcSigTopic('frob(bytes32,address,address,address,int256,int256)');
const EVENT_MANAGER_FROB = funcSigTopic('frob(uint256,int256,int256)');

const decodeManagerFrob = data => {
  const sig = ethAbi
    .encodeFunctionSignature('frob(uint256,int256,int256)')
    .slice(2);
  const decoded = ethAbi.decodeParameters(
    [
      'uint256', // id
      'int256', // dink
      'int256' // dart
    ],
    '0x' + data.replace(new RegExp('^.+?' + sig), '')
  );
  return {
    id: decoded[0].toString(),
    dink: decoded[1],
    dart: decoded[2] // can't be used directly because would need to be scaled up using vat.ilks[ilk].rate
  };
};

const decodeVatFrob = data => {
  const sig = ethAbi
    .encodeFunctionSignature(
      'frob(bytes32,address,address,address,int256,int256)'
    )
    .slice(2);
  const decoded = ethAbi.decodeParameters(
    [
      'bytes32', // ilk
      'address', // u (urnHandler)
      'address', // v (urnHandler)
      'address', // w (urnHandler)
      'int256', // dink
      'int256' // dart
    ],
    '0x' + data.replace(new RegExp('^.+?' + sig), '')
  );
  return {
    ilk: bytesToString(decoded[0].toString()),
    urnHandler: decoded[1].toString(),
    dink: decoded[4].toString(),
    dart: decoded[5].toString()
  };
};

export default async function getEventHistory(cdpManager, managedCdp, cache) {
  const MCD_JOIN_DAI = cdpManager.get('smartContract').getContractAddress('MCD_JOIN_DAI');
  const MCD_JOIN_SAI = cdpManager.get('smartContract').getContractAddress('MCD_JOIN_SAI');
  const CDP_MANAGER = cdpManager.get('smartContract').getContractAddress('CDP_MANAGER');
  const MIGRATION = cdpManager.get('smartContract').getContractAddress('MIGRATION');
  const MCD_VAT = cdpManager.get('smartContract').getContractAddress('MCD_VAT');

  const id = managedCdp.id;
  if (cache[id]) return cache[id];

  const web3 = cdpManager.get('web3');

  // 8600000 is 2019-09-22 on mainnet and 2018-09-04 on kovan
  const fromBlock = [1, 42].includes(web3.networkId()) ? 8600000 : 1;

  const utils = web3._web3.utils;
  const toHex = v => BigNumber(v).toString(16);
  const fromWei = v => utils.fromWei(toHex(v));
  const fromHexWei = v => utils.fromWei(utils.toBN(toHex(v)).toString()).toString();
  const numberFromHex = v => utils.toBN(toHex(v)).toNumber();

  const promisesBlockTimestamp = {};
  const getBlockTimestamp = block => {
    if (!promisesBlockTimestamp[block]) {
      promisesBlockTimestamp[block] = web3.getBlock(block, false);
    }
    return promisesBlockTimestamp[block];
  };

  const urnHandler = (await cdpManager.getUrn(id)).toLowerCase();
  const ilk = managedCdp.ilk;

  const { NewCdp } = cdpManager
    .get('smartContract')
    .getContract('CDP_MANAGER').interface.events;

  const lookups = [
    {
      request: web3.getPastLogs({
        address: CDP_MANAGER,
        topics: [
          utils.keccak256(utils.toHex(NewCdp.signature)),
          null,
          null,
          '0x' + padStart(id.toString(16), 64, '0')
        ],
        fromBlock
      }),
      result: r =>
        r.map(({ blockNumber: block, transactionHash: txHash }) => {
          return {
            type: 'OPEN',
            order: 0,
            block,
            txHash,
            id,
            ilk
          };
        })
    },
    {
      request: web3.getPastLogs({
        address: CDP_MANAGER,
        topics: [
          EVENT_MANAGER_FROB,
          null,
          '0x' + padStart(id.toString(16), 64, '0')
        ],
        fromBlock
      }),
      result: async r =>
        r.reduce(async (acc, { blockNumber: block, data, topics }) => {
          let { dart } = decodeManagerFrob(data);
          acc = await acc;
          dart = new BigNumber(dart);
          // Imprecise debt amount frobbed (not scaled by vat.ilks[ilk].rate)
          if (dart.lt(0) || dart.gt(0)) {
            // Lookup the dai join events on this block for this proxy address
            const proxy = topics[1];
            const joinDaiEvents = await web3.getPastLogs({
              address: [MCD_JOIN_DAI, MCD_JOIN_SAI],
              topics: [
                dart.lt(0) ? EVENT_DAI_ADAPTER_JOIN : EVENT_DAI_ADAPTER_EXIT,
                proxy
              ],
              fromBlock: block,
              toBlock: block
            });
            acc.push(
              ...joinDaiEvents.map(
                ({ address, blockNumber: block, transactionHash: txHash, topics }) => ({
                  type: dart.lt(0) ? 'PAY_BACK' : 'GENERATE',
                  order: 2,
                  block,
                  txHash,
                  id,
                  ilk,
                  adapter: address.toLowerCase(),
                  proxy: formatAddress(topics[1]),
                  recipient: formatAddress(topics[2]),
                  amount: fromHexWei(topics[3])
                })
              )
            );
          }
          return acc;
        }, [])
    },
    {
      request: web3.getPastLogs({
        address: MCD_VAT,
        topics: [
          EVENT_VAT_FROB,
          null,
          '0x' + padStart(urnHandler.slice(2), 64, '0')
        ],
        fromBlock
      }),
      result: r =>
        r.map(
          ({ address, blockNumber: block, transactionHash: txHash, data }) => {
            let { ilk, dink } = decodeVatFrob(data);
            dink = new BigNumber(dink);
            return dink.lt(0) || dink.gt(0)
              ? {
                  type: dink.lt(0) ? 'WITHDRAW' : 'DEPOSIT',
                  order: dink.lt(0) ? 3 : 1,
                  block,
                  txHash,
                  id,
                  ilk,
                  gem: managedCdp.currency.symbol,
                  adapter: address.toLowerCase(),
                  amount: Math.abs(fromWei(dink.toString())).toString()
                }
              : null;
          }
        )
    },
    {
      request: web3.getPastLogs({
        address: CDP_MANAGER,
        topics: [EVENT_GIVE, null, '0x' + padStart(id.toString(16), 64, '0')],
        fromBlock
      }),
      result: r =>
        r.map(({ blockNumber: block, transactionHash: txHash, topics }) => {
          const prevOwner = formatAddress(topics[1]);
          return {
            type: prevOwner === MIGRATION ? 'MIGRATE' : 'GIVE',
            order: 1,
            block,
            txHash,
            prevOwner,
            id: numberFromHex(topics[2]),
            newOwner: formatAddress(topics[3])
          };
        })
    }
  ];

  // eslint-disable-next-line require-atomic-updates
  cache[id] = (async () => {
    const results = await Promise.all(lookups.map(l => l.request));
    return orderBy(
      await Promise.all(
        flatten(await Promise.all(results.map((r, i) => lookups[i].result(r))))
          .filter(r => r !== null)
          .map(async e => {
            // eslint-disable-next-line require-atomic-updates
            e.timestamp = (await getBlockTimestamp(e.block)).timestamp;
            return e;
          })
      ),
      ['block', 'order'],
      ['desc', 'desc']
    ).map(e => {
      delete e.order;
      return e;
    });
  })();

  return cache[id];
}
