import { fileURLToPath } from 'node:url';
import type { MidnightProviders } from '@midnight-ntwrk/midnight-js/types';
import { makeCompiledContract } from '@sig-net/midnight-contract-deploy';
import {
  Contract,
  ledger,
  pureCircuits,
  type Witnesses,
} from '../../contracts/midnight/managed/contract/index.js';

export { Contract, ledger, pureCircuits };

/** Operator identity used only as a private circuit witness. */
export interface CallerPrivateState {
  readonly secretKey: Uint8Array;
}

/** Generated circuit identifiers; adding a circuit changes this type automatically. */
export type CallerCircuitId =
  keyof Contract<CallerPrivateState>['provableCircuits'];

/** Private-state identifier shared by deployment and joined caller sessions. */
export const PRIVATE_STATE_ID = 'midnight-pinger';

/** Provider set required by the generated pinger caller. */
export type CallerProviders = MidnightProviders<
  CallerCircuitId,
  typeof PRIVATE_STATE_ID,
  CallerPrivateState
>;

/** Exact generated input shape; capacities are enforced by the compiled circuit. */
export type CallerTransaction = Parameters<
  Contract<CallerPrivateState>['circuits']['submitNative']
>[1];

/** Caller-owned request indexes; simulator tests verify their actual compiled paths. */
export const NATIVE_REQUESTS_PATH: readonly number[] = [0];
export const ERC20_REQUESTS_PATH: readonly number[] = [1];

/** Private witnesses never disclose the operator's identity secret. */
export const witnesses: Witnesses<CallerPrivateState> = {
  operatorSecretKey: ({ privateState }) => [
    privateState,
    privateState.secretKey,
  ],
};

/** Compiled proof assets resolved relative to the repository module. */
export const managedPath = fileURLToPath(
  new URL('../../contracts/midnight/managed', import.meta.url)
);

/** Contract binding shared by the deploy command and runner sessions. */
export const compiledContract = makeCompiledContract<
  Contract<CallerPrivateState>,
  CallerPrivateState
>('midnight-pinger', Contract, witnesses, managedPath);
