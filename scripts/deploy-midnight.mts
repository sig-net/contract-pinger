import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js/contracts';
import {
  contractAddressFromHex,
  deriveMidnightResponseKey,
} from '@sig-net/midnight';
import {
  buildDeployTransaction,
  ensureFeeReady,
  estimateUnprovenTransactionFee,
  submitUnprovenTransaction,
} from '@sig-net/midnight-contract-deploy';
import {
  compiledContract,
  ledger,
  PRIVATE_STATE_ID,
  pureCircuits,
} from '../src/midnight/caller.mjs';
import { resolveMidnightConfig } from '../src/midnight/config.mjs';
import { openMidnightSession } from '../src/midnight/provider.mjs';

interface DeploymentReceipt {
  contractAddress: string;
  centralAddress: string;
  destinationChainId: string;
  networkId: string;
  status: 'prepared' | 'submitted' | 'initialised';
  transactionId?: string;
}

const initialiseOnly = process.argv.includes('--initialise');
const unsupported = process.argv
  .slice(2)
  .filter(arg => arg !== '--initialise' && arg !== '--help');
if (process.argv.includes('--help')) {
  console.log(
    'deploy:midnight [--initialise]\nDeploy the Midnight pinger for Sepolia. --initialise joins the recorded/existing caller without deploying again.'
  );
} else {
  if (unsupported.length > 0)
    throw new Error(`Unknown arguments: ${unsupported.join(', ')}`);
  const config = resolveMidnightConfig(process.env, false);
  await mkdir(config.stateDirectory, { recursive: true, mode: 0o700 });
  const receiptPath = join(config.stateDirectory, 'deployment.json');
  let receipt: DeploymentReceipt | undefined;
  try {
    receipt = JSON.parse(
      await readFile(receiptPath, 'utf8')
    ) as DeploymentReceipt;
    if (!/^[0-9a-f]{64}$/i.test(receipt.contractAddress))
      throw new Error('Invalid deployment receipt address');
    if (
      receipt.centralAddress !== config.centralAddress ||
      receipt.networkId !== config.node.networkId ||
      receipt.destinationChainId !== '11155111'
    ) {
      throw new Error(
        'Deployment receipt belongs to another network, Signet contract or destination chain'
      );
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
  if (
    receipt &&
    config.callerAddress &&
    receipt.contractAddress !== config.callerAddress
  ) {
    throw new Error(
      'Configured caller differs from the saved deployment receipt'
    );
  }
  if (!initialiseOnly && (receipt || config.callerAddress)) {
    throw new Error(
      'A caller is already recorded/configured; use --initialise to resume its response-key pin'
    );
  }
  const session = await openMidnightSession(config);
  try {
    let address = config.callerAddress ?? receipt?.contractAddress;
    if (!initialiseOnly) {
      const tx = await buildDeployTransaction(
        compiledContract,
        config.node.networkId,
        session.keys.shieldedSecretKeys.coinPublicKey,
        { secretKey: config.operatorSecret },
        pureCircuits.operatorCommitment(config.operatorSecret),
        contractAddressFromHex(config.centralAddress),
        11155111n
      );
      address = tx.contractAddress;
      receipt = {
        contractAddress: address,
        centralAddress: config.centralAddress,
        destinationChainId: '11155111',
        networkId: config.node.networkId,
        status: 'prepared',
      };
      // Persist before submission: a timeout must not lead to a second deployment.
      await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', {
        mode: 0o600,
      });
      console.log(`Midnight caller address (prepared): ${address}`);
      const fee = await estimateUnprovenTransactionFee(
        session.wallet,
        tx.serializedTransaction
      );
      await ensureFeeReady(
        session.wallet,
        session.keys,
        await session.wallet.waitForSyncedState(),
        config.node.networkId,
        undefined,
        fee
      );
      receipt.transactionId = await submitUnprovenTransaction(
        session.wallet,
        session.keys,
        tx.serializedTransaction
      );
      receipt.status = 'submitted';
      await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', {
        mode: 0o600,
      });
      console.log(
        `Midnight caller deployment submitted: ${receipt.transactionId}`
      );
    }
    if (!address)
      throw new Error(
        '--initialise requires a configured caller address or saved deployment receipt'
      );
    const caller = await findDeployedContract(session.providers, {
      contractAddress: address,
      compiledContract,
      privateStateId: PRIVATE_STATE_ID,
      initialPrivateState: { secretKey: config.operatorSecret },
    });
    const state =
      await session.providers.publicDataProvider.queryContractState(address);
    if (!state)
      throw new Error(
        `Caller is not indexed yet: ${address}. Retry --initialise after it appears.`
      );
    const current = ledger(state.data);
    if (current.destinationChainId !== 11155111n)
      throw new Error('Caller destination is not Sepolia');
    const responseKey = deriveMidnightResponseKey(
      config.rootPublicKey,
      address
    );
    if (current.initialised === 0n) {
      await caller.callTx.initialise(responseKey);
    } else if (
      current.mpcResponseKey.x !== responseKey.x ||
      current.mpcResponseKey.y !== responseKey.y ||
      current.mpcResponseKey.identity !== responseKey.identity
    ) {
      throw new Error(
        'Existing caller response key does not match the configured MPC root'
      );
    }
    receipt = {
      ...receipt,
      contractAddress: address,
      centralAddress: config.centralAddress,
      destinationChainId: '11155111',
      networkId: config.node.networkId,
      status: 'initialised',
    };
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', {
      mode: 0o600,
    });
    console.log(`MPC_MIDNIGHT_CALLER_ADDRESS=${address}`);
    console.log(`Deployment receipt: ${receiptPath}`);
  } finally {
    await session.close();
  }
}
