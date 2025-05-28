import { Connection, Keypair, PublicKey } from '@solana/web3.js';
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
  const {
    solRpcUrlDevnet,
    solRpcUrlMainnet,
    solSk,
  } = useEnv();
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
  const connection = new Connection(config.solanaRpcUrl, 'confirmed');
  const keypairArray = JSON.parse(config.solanaPrivateKey);
  const keypair = Keypair.fromSecretKey(new Uint8Array(keypairArray));
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: 'confirmed',
  });
  const requesterKeypair = Keypair.generate();
  // You may want to pass a real rootPublicKey here if needed
  const chainSigContract = new contracts.solana.ChainSignatureContract({
    provider,
    programId: contractAddress,
    rootPublicKey: '' as `secp256k1:${string}`,
    requesterAddress: requesterKeypair.publicKey.toString(),
  });
  return { chainSigContract, provider, requesterKeypair };
};
