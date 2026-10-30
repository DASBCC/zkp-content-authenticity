/** Define los datos públicos de la aplicación y evita incorporar secretos de fuente al cliente. */
import type { Abi, Address, Hash } from "viem";

export interface Configuration {
  network: string; chainId: string; registryAddress: Address; verifierAddress: Address; artifactId: string;
  owner: Address; root: string; rootEnabled: boolean; protocolVersion: string; protocolDomain: string;
  experimental: boolean; signingEnabled: boolean; walletRpcUrl: string; rpcPath: string; registryAbi: Abi; maxFileBytes: number;
  deploymentReady?: boolean; bootstrapOwner?: Address; localWalletAvailable?: boolean;
  tools?: Record<string, string>; circuitMetrics?: Record<string, string | number | boolean>; setup?: { origin: string; trust: string; participants: number | null; power: number };
  pendingOwner?: Address;
  walletDeploymentAvailable?: boolean; explorerUrl?: string | null;
}
export interface ContentRecord { contentHash: bigint; protocolVersion: bigint; registrant: Address; registeredAt: bigint; exists: boolean }
export interface ProofResult {
  artifactId: string; proof: unknown; publicSignals: string[];
  solidity: { pA: string[]; pB: string[][]; pC: string[]; publicSignals: string[] };
  metrics: { witnessMs: number; proveMs: number; verifyMs: number; proofBytes: number };
}
export interface PublicReceipt { transactionHash: Hash; blockNumber: bigint; gasUsed: bigint; confirmationMs: number }
export type Stage = "selected" | "hashing" | "hashed" | "permission" | "queued" | "authorizing" | "authorized" | "witness" | "proving" | "verifying" | "ready" | "wallet" | "submitted" | "confirmed";
export interface WalletProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}
declare global { interface Window { ethereum?: WalletProvider } }
