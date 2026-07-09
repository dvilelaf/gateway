import { readFileSync } from 'fs';

import { Decimal } from 'decimal.js';

export const LIVE_MUTATIONS_ENV = 'GATEWAY_LIVE_MUTATIONS_ENABLED';
export const MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN_ENV = 'MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN';
export const MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN_FILE_ENV = 'MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN_FILE';

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
  destination_address?: unknown;
  destination_network?: unknown;
  expires_at_utc?: unknown;
  gas?: unknown;
  gateway_live_flags?: unknown;
  network?: unknown;
  notional?: unknown;
  signature?: unknown;
  signing_type?: unknown;
  slippage_bps?: unknown;
  source?: unknown;
  scope?: unknown;
  status?: unknown;
  payload_hash?: unknown;
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
  if (isMarlinProviderTreasuryAuthorization(input)) {
    return;
  }
  if (isMarlinRuntimeProfile()) {
    const swapRejection = marlinProviderIntentSwapRejectionReason(input);
    if (swapRejection) {
      throw new Error(`Marlin provider intent swap rejected at mainnet guard: ${swapRejection}`);
    }
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

export function marlinGatewayProviderIntentTokenMatches(value: unknown): boolean {
  const expected = marlinGatewayProviderIntentToken();
  if (!expected) {
    return false;
  }
  const provided = Array.isArray(value) ? value[0] : value;
  return typeof provided === 'string' && provided === expected;
}

export function marlinProviderIntentAuthorizationMatches(
  authorization: LiveActionAuthorization | undefined,
  expectations: Record<string, unknown>,
): boolean {
  return Object.entries(expectations).every(([key, expected]) =>
    authorizationMatches(expected, authorization?.[key as keyof LiveActionAuthorization]),
  );
}

export function assertBridgeExecutionAllowed(
  authorization: LiveActionAuthorization | undefined,
  expectation: BridgeExecutionExpectation,
): void {
  if (
    !marlinProviderIntentAuthorizationMatches(authorization, {
      bridge_provider: expectation.provider,
      bridge_provider_route_id: expectation.providerRouteId,
      bridge_quote_id: expectation.quoteId,
      bridge_route_payload_hash: expectation.routePayloadHash,
      bridge_source_chain_id: expectation.sourceChainId,
      bridge_tx_calldata_hash: expectation.calldataHash,
      bridge_tx_target: expectation.target,
      bridge_tx_value: expectation.value,
    })
  ) {
    throw new Error('bridge authorization does not match execution payload');
  }
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

function envFlagEnabled(name: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes((process.env[name] ?? '').trim().toLowerCase());
}

function isMarlinRuntimeProfile(): boolean {
  return (process.env.MARLIN_RUNTIME_PROFILE ?? '').trim().toLowerCase() === 'marlin';
}

function isMarlinProviderIntentSwapAuthorization(input: MainnetMutationGuardInput): boolean {
  return marlinProviderIntentSwapRejectionReason(input) === '';
}

function marlinProviderIntentSwapRejectionReason(input: MainnetMutationGuardInput): string | null {
  const authorization = input.liveActionAuthorization;
  const marlinProviderIntent =
    authorization?.source === 'marlin' &&
    authorization?.scope === 'provider_intent' &&
    authorization?.action === 'gateway_swap';
  if (!marlinProviderIntent) {
    return null;
  }
  const requiredGuardContextPresent =
    input.expectedConnectorId !== undefined &&
    input.expectedConnectorId !== null &&
    String(input.expectedConnectorId).trim() !== '' &&
    input.expectedNotional !== undefined &&
    input.expectedNotional !== null &&
    String(input.expectedNotional).trim() !== '' &&
    input.expectedWalletAddress !== undefined &&
    input.expectedWalletAddress !== null &&
    String(input.expectedWalletAddress).trim() !== '';
  if (!requiredGuardContextPresent) {
    return null;
  }
  const networkMatches = authorizationMatches(input.network, authorization?.network);
  const connectorMatches = authorizationMatches(input.expectedConnectorId, authorization?.connector_id);
  const walletMatches = authorizationMatches(input.expectedWalletAddress, authorization?.wallet_address);
  const notionalMatches = authorizationMatches(input.expectedNotional, authorization?.notional);
  const slippageMatches = authorizationMatches(input.expectedSlippageBps, authorization?.slippage_bps);
  const operationMatches =
    (input.chain === 'solana' &&
      ['solana_raw_transaction', 'solana_transaction'].includes(input.operation) &&
      ['jupiter_execute_swap', 'orca_execute_swap'].includes(input.internalProviderIntentSource ?? '')) ||
    (input.chain === 'ethereum' &&
      input.network === 'base' &&
      input.operation === 'ethereum_transaction' &&
      input.internalProviderIntentSource === 'aerodrome_execute_swap');
  if (
    !networkMatches ||
    !connectorMatches ||
    !walletMatches ||
    !notionalMatches ||
    !slippageMatches ||
    !operationMatches
  ) {
    return (
      `network_matches=${networkMatches}; connector_matches=${connectorMatches}; wallet_matches=${walletMatches}; ` +
      `notional_matches=${notionalMatches}; slippage_matches=${slippageMatches}; operation_matches=${operationMatches}`
    );
  }
  return '';
}

function isMarlinProviderTreasuryAuthorization(input: MainnetMutationGuardInput): boolean {
  const authorization = input.liveActionAuthorization;
  const marlinProviderTreasury =
    authorization?.source === 'marlin' &&
    authorization?.scope === 'provider_treasury' &&
    authorization?.action === 'gateway_rebalance';
  if (!marlinProviderTreasury) {
    return false;
  }
  if (
    !authorizationMatches(input.expectedConnectorId, authorization?.connector_id) ||
    !authorizationMatches(input.expectedNotional, authorization?.notional)
  ) {
    return false;
  }
  const sourceMatches =
    authorizationMatches(input.network, authorization?.network) &&
    authorizationMatches(input.expectedWalletAddress, authorization?.wallet_address);
  const isCctpTreasury = input.internalProviderIntentSource === 'cctp_usdc_rebalance';
  const destinationMatches =
    isCctpTreasury &&
    authorizationMatches(input.network, authorization?.destination_network) &&
    authorizationMatches(input.expectedWalletAddress, authorization?.destination_address);
  if (!sourceMatches && !destinationMatches) {
    return false;
  }
  const requiredGuardContextPresent =
    input.expectedConnectorId !== undefined &&
    input.expectedConnectorId !== null &&
    String(input.expectedConnectorId).trim() !== '' &&
    input.expectedNotional !== undefined &&
    input.expectedNotional !== null &&
    String(input.expectedNotional).trim() !== '' &&
    input.expectedWalletAddress !== undefined &&
    input.expectedWalletAddress !== null &&
    String(input.expectedWalletAddress).trim() !== '';
  return (
    (input.chain === 'ethereum' &&
      input.network === 'arbitrum' &&
      input.operation === 'ethereum_transaction' &&
      input.internalProviderIntentSource === 'hyperliquid_bridge2_rebalance') ||
    (input.chain === 'ethereum' && input.operation === 'ethereum_transaction' && isCctpTreasury) ||
    (input.chain === 'ethereum' &&
      input.operation === 'ethereum_transaction' &&
      input.internalProviderIntentSource === 'squid_router_rebalance' &&
      sourceMatches &&
      requiredGuardContextPresent) ||
    (input.chain === 'ethereum' &&
      input.network === 'arbitrum' &&
      input.operation === 'ethereum_transaction' &&
      input.internalProviderIntentSource === 'provider_treasury_same_chain_swap' &&
      sourceMatches &&
      requiredGuardContextPresent) ||
    (input.chain === 'solana' &&
      input.operation === 'solana_raw_transaction' &&
      isCctpTreasury &&
      destinationMatches &&
      requiredGuardContextPresent)
  );
}

function authorizationMatches(expected: unknown, provided: unknown): boolean {
  if (expected === undefined || expected === null || String(expected).trim() === '') {
    return true;
  }
  if (provided === undefined || provided === null || String(provided).trim() === '') {
    return false;
  }
  const expectedText = String(expected).trim();
  const providedText = String(provided).trim();
  if (expectedText.startsWith('0x') && providedText.startsWith('0x') && expectedText.length === providedText.length) {
    return expectedText.toLowerCase() === providedText.toLowerCase();
  }
  const expectedDecimal = decimalOrNull(expectedText);
  const providedDecimal = decimalOrNull(providedText);
  if (expectedDecimal !== null && providedDecimal !== null) {
    const tolerance = Decimal.max(expectedDecimal.abs().mul('1e-15'), new Decimal('1e-18'));
    return expectedDecimal.minus(providedDecimal).abs().lte(tolerance);
  }
  return providedText === expectedText;
}

function decimalOrNull(value: string): Decimal | null {
  try {
    const decimal = new Decimal(value);
    return decimal.isFinite() ? decimal : null;
  } catch {
    return null;
  }
}

function marlinGatewayProviderIntentToken(): string {
  const value = (process.env[MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN_ENV] ?? '').trim();
  if (value) {
    return value;
  }
  const filePath = (process.env[MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN_FILE_ENV] ?? '').trim();
  if (!filePath) {
    return '';
  }
  try {
    return readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
}

function liveOperationEnv(operation: string): string {
  const normalized = operation
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `GATEWAY_LIVE_${normalized}_ENABLED`;
}
