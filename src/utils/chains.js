const { EVM, Bitcoin, Cosmos, BTCRpcAdapters } = require('signet.js');
const { useEnv } = require('./useEnv');

const initChains = (contract) => {
  const { sepoliaInfuraUrl } = useEnv();

  return {
    evm: new EVM({
      rpcUrl: sepoliaInfuraUrl,
      contract: contract,
    }),

    btc: new Bitcoin({
      network: "testnet",
      btcRpcAdapter: new BTCRpcAdapters.Mempool(
        "https://mempool.space/testnet4/api"
      ),
      contract: contract,
    }),

    cosmos: new Cosmos({
      chainId: "osmo-test-5",
      contract: contract,
    }),
  };
};

module.exports = { initChains }; 