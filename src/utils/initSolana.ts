import { Connection, Keypair } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import { contracts } from 'signet.js';
import { useEnv } from './useEnv';

export const initSolana = ({
  contractAddress,
  environment,
}: {
  contractAddress: string;
  environment: 'dev' | 'testnet' | 'mainnet';
}) => {
  const { solRpcUrlDevnet, solRpcUrlMainnet, solSk, solRootPublicKey } =
    useEnv();
  const config = {
    dev: {
      solanaRpcUrl: solRpcUrlDevnet,
      solanaPrivateKey: solSk,
    },
    testnet: {
      solanaRpcUrl: solRpcUrlDevnet,
      solanaPrivateKey: solSk,
    },
    mainnet: {
      solanaRpcUrl: solRpcUrlMainnet,
      solanaPrivateKey: solSk,
    },
  }[environment];

  if (!config.solanaRpcUrl) {
    throw new Error(
      `Solana RPC URL for ${environment} environment is missing. Please set ${
        environment === 'mainnet'
          ? 'SIG_SOL_RPC_URL_MAINNET'
          : 'SIG_SOL_RPC_URL_DEV'
      } in your environment.`
    );
  }

  if (!config.solanaPrivateKey) {
    throw new Error(
      `Solana secret key is missing. Please set SIG_SOL_SK in your environment.`
    );
  }

  const connection = new Connection(config.solanaRpcUrl, 'confirmed');
  const keypairArray = JSON.parse(config.solanaPrivateKey);
  const keypair = Keypair.fromSecretKey(new Uint8Array(keypairArray));
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
  });
  const requesterKeypair = Keypair.generate();
  const chainSigContract = new contracts.solana.ChainSignatureContract({
    provider,
    programId: contractAddress,
    config: {
      rootPublicKey: solRootPublicKey as `secp256k1:${string}`,
      requesterAddress: requesterKeypair.publicKey.toString(),
    },
  });
  return { chainSigContract, provider, requesterKeypair };
};
