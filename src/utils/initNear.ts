import { useEnv } from './useEnv';
import * as nearAPI from 'near-api-js';
import * as signetJs from 'signet.js';

export const initNear = async ({
  contractAddress,
}: {
  contractAddress: string;
}) => {
  const { nearAccount, nearNetworkId, nearPrivateKey } = useEnv();
  const keyStore = new nearAPI.keyStores.InMemoryKeyStore();
  const keyPair = nearAPI.KeyPair.fromString(nearPrivateKey);
  await keyStore.setKey(nearNetworkId, nearAccount, keyPair);
  const config = {
    networkId: nearNetworkId,
    keyStore,
    nodeUrl:
      nearNetworkId === 'mainnet'
        ? 'https://free.rpc.fastnear.com'
        : 'https://test.rpc.fastnear.com',
    helperUrl:
      nearNetworkId === 'mainnet'
        ? 'https://helper.mainnet.near.org'
        : 'https://helper.testnet.near.org',
  };
  const connection = await nearAPI.connect(config);
  const account = await connection.account(nearAccount);
  const chainSigContract = new (
    signetJs as any
  ).chains.near.ChainSignatureContract({
    networkId: nearNetworkId,
    contractId: contractAddress,
    accountId: nearAccount,
    keypair: keyPair,
  });
  return { connection, account, keyPair, chainSigContract };
};

export const initNearNew = async ({
  contractAddress,
  environment,
}: {
  contractAddress: string;
  environment: 'dev' | 'testnet' | 'mainnet';
}) => {
  const {
    nearAccountIdMainnet,
    nearAccountIdTestnet,
    nearPrivateKeyMainnet,
    nearPrivateKeyTestnet,
  } = useEnv();

  const { nearAccount, nearPrivateKey, nearNetworkId } = {
    dev: {
      nearAccount: nearAccountIdTestnet,
      nearPrivateKey: nearPrivateKeyTestnet,
      nearNetworkId: 'testnet',
    },
    testnet: {
      nearAccount: nearAccountIdTestnet,
      nearPrivateKey: nearPrivateKeyTestnet,
      nearNetworkId: 'testnet',
    },
    mainnet: {
      nearAccount: nearAccountIdMainnet,
      nearPrivateKey: nearPrivateKeyMainnet,
      nearNetworkId: 'mainnet',
    },
  }[environment];

  if (!nearAccount) {
    throw new Error(
      `NEAR account ID for ${environment} environment is missing. Please set the ${
        environment === 'mainnet'
          ? 'nearAccountIdMainnet'
          : 'nearAccountIdTestnet'
      } environment variable.`
    );
  }

  if (!nearPrivateKey) {
    throw new Error(
      `NEAR private key for ${environment} environment is missing. Please set the ${
        environment === 'mainnet'
          ? 'nearPrivateKeyMainnet'
          : 'nearPrivateKeyTestnet'
      } environment variable.`
    );
  }

  const keyStore = new nearAPI.keyStores.InMemoryKeyStore();
  const keyPair = nearAPI.KeyPair.fromString(nearPrivateKey);
  await keyStore.setKey(nearNetworkId, nearAccount, keyPair);
  const config = {
    networkId: nearNetworkId,
    keyStore,
    nodeUrl:
      nearNetworkId === 'mainnet'
        ? 'https://free.rpc.fastnear.com'
        : 'https://test.rpc.fastnear.com',
    helperUrl:
      nearNetworkId === 'mainnet'
        ? 'https://helper.mainnet.near.org'
        : 'https://helper.testnet.near.org',
  };
  const connection = await nearAPI.connect(config);
  const account = await connection.account(nearAccount);
  const chainSigContract = new (
    signetJs as any
  ).chains.near.ChainSignatureContract({
    networkId: nearNetworkId,
    contractId: contractAddress,
    accountId: nearAccount,
    keypair: keyPair,
  });
  return { connection, account, keyPair, chainSigContract };
};
