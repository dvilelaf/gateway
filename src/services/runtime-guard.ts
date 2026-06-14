export const LIVE_MUTATIONS_ENV = 'GATEWAY_LIVE_MUTATIONS_ENABLED';

const SAFE_NETWORK_MARKERS = ['testnet', 'devnet', 'sepolia', 'goerli', 'amoy', 'fuji', 'local'];

export interface MainnetMutationGuardInput {
  chain: string;
  network: string;
  operation: string;
}

export function assertMainnetMutationAllowed(input: MainnetMutationGuardInput): void {
  if (!isMainnetNetwork(input.network)) {
    return;
  }
  if (envFlagEnabled(LIVE_MUTATIONS_ENV)) {
    return;
  }
  throw new Error(
    `mainnet mutation disabled for ${input.chain}/${input.network}/${input.operation}; ` +
      `set ${LIVE_MUTATIONS_ENV}=true only behind Marlin live gates`,
  );
}

export function isMainnetNetwork(network: string): boolean {
  const normalized = network.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return !SAFE_NETWORK_MARKERS.some((marker) => normalized.includes(marker));
}

function envFlagEnabled(name: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes((process.env[name] ?? '').trim().toLowerCase());
}
