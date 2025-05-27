import { useEnv } from './useEnv';
import * as nearAPI from 'near-api-js';
import * as signetJs from 'signet.js';

export const initNear = async ({ contractAddress }: { contractAddress: string }) => {
  const { nearAccount, nearNetworkId, nearPrivateKey } = useEnv();
  const keyStore = new nearAPI.keyStores.InMemoryKeyStore();
  const keyPair = nearAPI.KeyPair.fromString(nearPrivateKey);
  await keyStore.setKey(nearNetworkId, nearAccount, keyPair);
  const config = {
    networkId: nearNetworkId,
    keyStore,
    nodeUrl: nearNetworkId === 'mainnet' ? 'https://free.rpc.fastnear.com' : 'https://test.rpc.fastnear.com',
    helperUrl: nearNetworkId === 'mainnet' ? 'https://helper.mainnet.near.org' : 'https://helper.testnet.near.org',
  };
  const connection = await nearAPI.connect(config);
  const account = await connection.account(nearAccount);
  const chainSigContract = new (signetJs as any).chains.near.ChainSignatureContract({ networkId: nearNetworkId, contractId: contractAddress, accountId: nearAccount, keypair: keyPair });
  return { connection, account, keyPair, chainSigContract };
};

export const initNearNew = async ({ contractAddress, environment }: { contractAddress: string, environment: 'dev' | 'testnet' | 'mainnet' }) => {
  const { nearAccountIdMainnet, nearAccountIdTestnet, nearPrivateKeyMainnet, nearPrivateKeyTestnet } = useEnv();
  const config = {
    dev: { nearAccount: nearAccountIdTestnet, nearPrivateKey: nearPrivateKeyTestnet, nearNetworkId: 'testnet' },
    testnet: { nearAccount: nearAccountIdTestnet, nearPrivateKey: nearPrivateKeyTestnet, nearNetworkId: 'testnet' },
    mainnet: { nearAccount: nearAccountIdMainnet, nearPrivateKey: nearPrivateKeyMainnet, nearNetworkId: 'mainnet' },
  }[environment];
  const keyStore = new nearAPI.keyStores.InMemoryKeyStore();
  const keyPair = nearAPI.KeyPair.fromString(config.nearPrivateKey);
  await keyStore.setKey(config.nearNetworkId, config.nearAccount, keyPair);
  const connection = await nearAPI.connect({
    networkId: config.nearNetworkId,
    keyStore,
    nodeUrl: config.nearNetworkId === 'mainnet' ? 'https://free.rpc.fastnear.com' : 'https://test.rpc.fastnear.com',
    helperUrl: config.nearNetworkId === 'mainnet' ? 'https://helper.mainnet.near.org' : 'https://helper.testnet.near.org',
  });
  const account = await connection.account(config.nearAccount);
  const chainSigContract = new (signetJs as any).chains.near.ChainSignatureContract({ networkId: config.nearNetworkId, contractId: contractAddress, accountId: config.nearAccount, keypair: keyPair });
  return { connection, account, keyPair, chainSigContract };
};
