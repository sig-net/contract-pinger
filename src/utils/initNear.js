const nearAPI = require('near-api-js');
const { connect, KeyPair, keyStores } = nearAPI;
const { useEnv } = require('./useEnv');
const { utils } = require('signet.js');

const initNear = async ({ contractAddress }) => {
  const { nearAccount, nearNetworkId, nearPrivateKey } = useEnv();

  const keyStore = new keyStores.InMemoryKeyStore();
  const keyPair = KeyPair.fromString(nearPrivateKey);
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

  const connection = await connect(config);
  const account = await connection.account(nearAccount);

  const chainSigContract = new utils.chains.near.ChainSignatureContract({
    networkId: nearNetworkId,
    contractId: contractAddress,
    accountId: nearAccount,
    keypair: keyPair,
  });

  return { connection, account, keyPair, chainSigContract };
};

const initNearNew = async ({ contractAddress, environment }) => {
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

  const keyStore = new keyStores.InMemoryKeyStore();
  const keyPair = KeyPair.fromString(nearPrivateKey);
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

  const connection = await connect(config);
  const account = await connection.account(nearAccount);

  const chainSigContract = new utils.chains.near.ChainSignatureContract({
    networkId: nearNetworkId,
    contractId: contractAddress,
    accountId: nearAccount,
    keypair: keyPair,
  });

  return { connection, account, keyPair, chainSigContract };
};

module.exports = { initNear, initNearNew };
