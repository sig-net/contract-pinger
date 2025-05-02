const { Connection, Keypair } = require("@solana/web3.js");
const anchor = require("@coral-xyz/anchor");
const { contracts } = require("signet.js");
const { useEnv } = require("./useEnv");

const initSolana = () => {
  const {
    solanaRpcUrl,
    solanaPrivateKey,
    chainSigAddressSolana,
    chainSigRootPublicKeySolana,
  } = useEnv();
  const connection = new Connection(solanaRpcUrl, "confirmed");
  const keypairArray = JSON.parse(solanaPrivateKey);
  const keypair = Keypair.fromSecretKey(new Uint8Array(keypairArray));
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const requesterKeypair = Keypair.generate();
  const chainSigContract = new contracts.solana.ChainSignatureContract({
    provider,
    programId: chainSigAddressSolana,
    rootPublicKey: chainSigRootPublicKeySolana,
    requesterAddress: requesterKeypair.publicKey.toString(),
  });

  return { chainSigContract, provider, requesterKeypair };
};

const initSolanaNew = ({ contractAddress, environment }) => {
  const {
    solanaRpcUrlDevnet,
    solanaRpcUrlMainnet,
    solanaPrivateKeyDevnet,
    solanaPrivateKeyMainnet,
  } = useEnv();

  const solanaRpcUrl =
    environment === "mainnet" ? solanaRpcUrlMainnet : solanaRpcUrlDevnet;
  const solanaPrivateKey =
    environment === "mainnet"
      ? solanaPrivateKeyMainnet
      : solanaPrivateKeyDevnet;

  const connection = new Connection(solanaRpcUrl, "confirmed");
  const keypairArray = JSON.parse(solanaPrivateKey);
  const keypair = Keypair.fromSecretKey(new Uint8Array(keypairArray));
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  const requesterKeypair = Keypair.generate();
  const chainSigContract = new contracts.solana.ChainSignatureContract({
    provider,
    programId: contractAddress,
    requesterAddress: requesterKeypair.publicKey.toString(),
  });

  return { chainSigContract, provider, requesterKeypair };
};

module.exports = { initSolana, initSolanaNew };
