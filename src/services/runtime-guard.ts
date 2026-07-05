export const LIVE_MUTATIONS_ENV = 'GATEWAY_LIVE_MUTATIONS_ENABLED';
export const BRIDGE_EXECUTE_ENV = 'GATEWAY_LIVE_BRIDGE_EXECUTE_ENABLED';
export const BRIDGE_PROVIDER_ALLOWLIST_ENV = 'GATEWAY_BRIDGE_PROVIDER_ALLOWLIST';

const SAFE_NETWORK_MARKERS = ['testnet', 'devnet', 'sepolia', 'goerli', 'amoy', 'fuji', 'local'];
const usedBridgeAuthorizationNonces = new Set<string>();

export interface MainnetMutationGuardInput {
  chain: string;
  expectedAccountAddress?: unknown;
  expectedConnectorId?: unknown;
  expectedGas?: unknown;
  expectedNotional?: unknown;
  expectedSlippageBps?: unknown;
  expectedWalletAddress?: unknown;
  internalProviderIntentSource?: string;
  liveActionAuthorization?: LiveActionAuthorization;
  network: string;
  operation: string;
}

export interface LiveActionAuthorization {
  action?: unknown;
  blockers?: unknown;
  account_address?: unknown;
  bridge_authorization_nonce?: unknown;
  bridge_provider?: unknown;
  bridge_provider_route_id?: unknown;
  bridge_quote_id?: unknown;
  bridge_route_payload_hash?: unknown;
  bridge_source_chain_id?: unknown;
  bridge_tx_calldata_hash?: unknown;
  bridge_tx_target?: unknown;
  bridge_tx_value?: unknown;
  connector_id?: unknown;
  expires_at_utc?: unknown;
  gas?: unknown;
  gateway_live_flags?: unknown;
  network?: unknown;
  notional?: unknown;
  signature?: unknown;
  slippage_bps?: unknown;
  source?: unknown;
  scope?: unknown;
  status?: unknown;
  version?: unknown;
  wallet_address?: unknown;
}

export interface BridgeExecutionExpectation {
  calldataHash: unknown;
  provider: unknown;
  providerRouteId: unknown;
  quoteId: unknown;
  routePayloadHash: unknown;
  sourceChainId: unknown;
  target: unknown;
  value: unknown;
}

export function assertMainnetMutationAllowed(input: MainnetMutationGuardInput): void {
  if (!isMainnetNetwork(input.network)) {
    return;
  }
  if (isMarlinProviderIntentSwapAuthorization(input)) {
    return;
  }
  if (isMarlinRuntimeProfile()) {
    throw new Error(
      `direct mainnet mutation disabled for ${input.chain}/${input.network}/${input.operation} in Marlin runtime; ` +
        'submit through a scoped Marlin provider intent',
    );
  }
  const operationEnv = liveOperationEnv(input.operation);
  if (envFlagEnabled(operationEnv)) {
    return;
  }
  throw new Error(
    `mainnet mutation disabled for ${input.chain}/${input.network}/${input.operation}; ` +
      `set ${operationEnv}=true only for the Marlin runtime`,
  );
}

export function assertBridgeExecutionAllowed(
  authorization: LiveActionAuthorization | undefined,
  expectation: BridgeExecutionExpectation,
): void {
  if (!envFlagEnabled(BRIDGE_EXECUTE_ENV)) {
    throw new Error(`bridge execution disabled; set ${BRIDGE_EXECUTE_ENV}=true only for the Marlin runtime`);
  }
  assertProviderAllowlisted(expectation.provider);
  const nonce = authorization?.bridge_authorization_nonce;
  if (typeof nonce !== 'string' || nonce.trim() === '') {
    throw new Error('bridge authorization nonce missing');
  }
  if (usedBridgeAuthorizationNonces.has(nonce)) {
    throw new Error('bridge authorization nonce replay');
  }
  usedBridgeAuthorizationNonces.add(nonce);
}

export function isMainnetNetwork(network: string): boolean {
  const normalized = network.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return !SAFE_NETWORK_MARKERS.some((marker) => normalized.includes(marker));
}

function assertProviderAllowlisted(provider: unknown): void {
  const providerText = String(provider).trim();
  const allowed = (process.env[BRIDGE_PROVIDER_ALLOWLIST_ENV] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  if (providerText === '' || !allowed.includes(providerText)) {
    throw new Error('bridge provider not allowlisted');
  }
}

function envFlagEnabled(name: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes((process.env[name] ?? '').trim().toLowerCase());
}

function isMarlinRuntimeProfile(): boolean {
  return (process.env.MARLIN_RUNTIME_PROFILE ?? '').trim().toLowerCase() === 'marlin';
}

function isMarlinProviderIntentSwapAuthorization(input: MainnetMutationGuardInput): boolean {
  const authorization = input.liveActionAuthorization;
  const marlinProviderIntent =
    authorization?.source === 'marlin' &&
    authorization?.scope === 'provider_intent' &&
    authorization?.action === 'gateway_swap';
  if (!marlinProviderIntent) {
    return false;
  }
  return (
    (input.chain === 'solana' &&
      input.operation === 'solana_raw_transaction' &&
      input.internalProviderIntentSource === 'jupiter_execute_swap') ||
    (input.chain === 'ethereum' &&
      input.network === 'base' &&
      input.operation === 'ethereum_transaction' &&
      input.internalProviderIntentSource === 'aerodrome_execute_swap')
  );
}

function liveOperationEnv(operation: string): string {
  const normalized = operation
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `GATEWAY_LIVE_${normalized}_ENABLED`;
}
