import type { RSVSignature } from '@sig-net/signet.js';
import type { Hex, PublicClient } from 'viem';
import type {
  BuiltTransaction,
  BidirectionalEnvironment,
} from './bidirectionalTx';
import type { DerivedWorker } from './derivation';
import type { Worker } from './workerPool';

export const SOURCE_CHAINS = ['solana', 'midnight'] as const;
export type SourceChain = (typeof SOURCE_CHAINS)[number];
export const SOURCE_ENVIRONMENTS = {
  solana: ['dev', 'testnet', 'mainnet'],
  midnight: ['stagenet'],
} as const;

export const isSourceChain = (value: unknown): value is SourceChain =>
  typeof value === 'string' &&
  (SOURCE_CHAINS as readonly string[]).includes(value);

export const isSourceEnvironment = (
  sourceChain: SourceChain,
  value: unknown
): value is BidirectionalEnvironment =>
  typeof value === 'string' &&
  (SOURCE_ENVIRONMENTS[sourceChain] as readonly string[]).includes(value);

export interface SourceProgress {
  requestId?: string;
  sourceTx?: string;
  nonce?: number;
}

export interface BidirectionalSource {
  /** Read-only admission check for unresolved source operations. */
  assertReady?(): Promise<void>;
  deriveWorkers(
    client: PublicClient,
    paths: readonly string[]
  ): Promise<DerivedWorker[]>;
  /** Register both waits before returning; observe rejections until the service awaits them. */
  submit(args: {
    built: BuiltTransaction;
    worker: Worker;
    signal: AbortSignal;
    /** Report identifiers as soon as known, including after the outward wait ends. */
    onProgress?: (progress: SourceProgress) => void;
    signatureTimeoutMs: number;
    /** Whole signing + Ethereum confirmation + response window. */
    responseTimeoutMs: number;
  }): Promise<{
    requestId: string;
    sourceTx: string;
    signature: Promise<RSVSignature>;
    /** Output must be authenticated by the source's response/attestation verification. */
    response: Promise<Hex>;
  }>;
  close?(): Promise<void>;
}
