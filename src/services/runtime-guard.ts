import { createHmac, timingSafeEqual } from 'crypto';

export const LIVE_MUTATIONS_ENV = 'GATEWAY_LIVE_MUTATIONS_ENABLED';
export const LIVE_ACTION_AUTH_SECRET_ENV = 'MARLIN_LIVE_ACTION_AUTH_SECRET';
export const BRIDGE_EXECUTE_ENV = 'GATEWAY_LIVE_BRIDGE_EXECUTE_ENABLED';
export const BRIDGE_PROVIDER_ALLOWLIST_ENV = 'GATEWAY_BRIDGE_PROVIDER_ALLOWLIST';

const SAFE_NETWORK_MARKERS = ['testnet', 'devnet', 'sepolia', 'goerli', 'amoy', 'fuji', 'local'];
const BRIDGE_GATEWAY_FLAGS = [
  BRIDGE_EXECUTE_ENV,
  'GATEWAY_LIVE_ETHEREUM_TRANSACTION_ENABLED',
  'GATEWAY_LIVE_SOLANA_RAW_TRANSACTION_ENABLED',
  'GATEWAY_LIVE_SOLANA_TRANSACTION_ENABLED',
];
const usedBridgeAuthorizationNonces = new Set<string>();

export interface MainnetMutationGuardInput {
  chain: string;
  expectedAccountAddress?: unknown;
  expectedConnectorId?: unknown;
  expectedGas?: unknown;
  expectedNotional?: unknown;
  expectedSlippageBps?: unknown;
  expectedWalletAddress?: unknown;
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
  const operationEnv = liveOperationEnv(input.operation);
  if (envFlagEnabled(operationEnv)) {
    assertLiveActionAuthorization(input.liveActionAuthorization, {
      expectedAccountAddress: input.expectedAccountAddress,
      expectedActions: liveOperationActions(input.operation),
      expectedConnectorId: input.expectedConnectorId,
      expectedGas: input.expectedGas,
      expectedGatewayFlag: operationEnv,
      expectedNetwork: input.network,
      expectedNotional: input.expectedNotional,
      expectedSlippageBps: input.expectedSlippageBps,
      expectedWalletAddress: input.expectedWalletAddress,
    });
    return;
  }
  throw new Error(
    `mainnet mutation disabled for ${input.chain}/${input.network}/${input.operation}; ` +
      `set ${operationEnv}=true only behind Marlin live gates`,
  );
}

export function assertBridgeExecutionAllowed(
  authorization: LiveActionAuthorization | undefined,
  expectation: BridgeExecutionExpectation,
): void {
  if (!envFlagEnabled(BRIDGE_EXECUTE_ENV)) {
    throw new Error(`bridge execution disabled; set ${BRIDGE_EXECUTE_ENV}=true only behind Marlin live gates`);
  }
  assertProviderAllowlisted(expectation.provider);
  assertLiveActionAuthorization(authorization, {
    expectedActions: ['bridge'],
    expectedGatewayFlag: BRIDGE_EXECUTE_ENV,
    expectedNetwork: String(expectation.sourceChainId) === '101' ? 'mainnet-beta' : authorizationNetwork(authorization),
  });
  assertExactGatewayFlags(authorization?.gateway_live_flags);
  assertExpectedAuthorizationField(authorization?.bridge_provider, expectation.provider, 'bridge provider');
  assertExpectedAuthorizationField(
    authorization?.bridge_provider_route_id,
    expectation.providerRouteId,
    'bridge provider route id',
  );
  assertExpectedAuthorizationField(authorization?.bridge_quote_id, expectation.quoteId, 'bridge quote id');
  assertExpectedAuthorizationField(
    authorization?.bridge_route_payload_hash,
    expectation.routePayloadHash,
    'bridge route payload hash',
  );
  assertExpectedAuthorizationField(
    authorization?.bridge_source_chain_id,
    expectation.sourceChainId,
    'bridge source chain id',
  );
  assertExpectedAuthorizationField(
    authorization?.bridge_tx_calldata_hash,
    expectation.calldataHash,
    'bridge tx calldata hash',
  );
  assertExpectedAuthorizationField(authorization?.bridge_tx_target, expectation.target, 'bridge tx target');
  assertExpectedAuthorizationDecimalField(authorization?.bridge_tx_value, expectation.value, 'bridge tx value');
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

function authorizationNetwork(authorization: LiveActionAuthorization | undefined): string {
  return typeof authorization?.network === 'string' ? authorization.network : '';
}

function assertExactGatewayFlags(flags: unknown): void {
  if (!Array.isArray(flags)) {
    throw new Error('live action authorization Gateway flag mismatch');
  }
  const actual = flags.map(String).sort();
  const expected = [...BRIDGE_GATEWAY_FLAGS].sort();
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) {
    throw new Error('live action authorization Gateway flag mismatch');
  }
}

function envFlagEnabled(name: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes((process.env[name] ?? '').trim().toLowerCase());
}

function liveOperationEnv(operation: string): string {
  const normalized = operation
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `GATEWAY_LIVE_${normalized}_ENABLED`;
}

function assertLiveActionAuthorization(
  authorization: LiveActionAuthorization | undefined,
  {
    expectedAccountAddress,
    expectedActions,
    expectedConnectorId,
    expectedGas,
    expectedGatewayFlag,
    expectedNetwork,
    expectedNotional,
    expectedSlippageBps,
    expectedWalletAddress,
  }: {
    expectedAccountAddress?: unknown;
    expectedActions: string[];
    expectedConnectorId?: unknown;
    expectedGas?: unknown;
    expectedGatewayFlag: string;
    expectedNetwork: string;
    expectedNotional?: unknown;
    expectedSlippageBps?: unknown;
    expectedWalletAddress?: unknown;
  },
): void {
  if (authorization === undefined) {
    throw new Error('live action authorization missing');
  }
  if (authorization.version !== 'live-action-authorization-v1') {
    throw new Error('live action authorization version mismatch');
  }
  if (authorization.status !== 'approved') {
    throw new Error('live action authorization is not approved');
  }
  if (!Array.isArray(authorization.blockers) || authorization.blockers.length > 0) {
    throw new Error('live action authorization has blockers');
  }
  assertAuthorizationSignature(authorization);
  if (typeof authorization.action !== 'string' || !expectedActions.includes(authorization.action)) {
    throw new Error('live action authorization action mismatch');
  }
  if (authorization.network !== expectedNetwork) {
    throw new Error('live action authorization network mismatch');
  }
  if (
    !Array.isArray(authorization.gateway_live_flags) ||
    !_authorizationGatewayFlagAllowed(authorization, expectedGatewayFlag)
  ) {
    throw new Error('live action authorization Gateway flag mismatch');
  }
  assertExpectedAuthorizationField(authorization.connector_id, expectedConnectorId, 'connector id');
  assertExpectedAuthorizationField(authorization.wallet_address, expectedWalletAddress, 'wallet address');
  assertExpectedAuthorizationField(authorization.account_address, expectedAccountAddress, 'account address');
  assertExpectedAuthorizationDecimalField(authorization.notional, expectedNotional, 'notional');
  assertExpectedAuthorizationDecimalField(authorization.gas, expectedGas, 'gas');
  assertExpectedAuthorizationDecimalField(authorization.slippage_bps, expectedSlippageBps, 'slippage bps');
  const expiresAt = parseUtcDate(authorization.expires_at_utc);
  if (expiresAt.getTime() <= Date.now()) {
    throw new Error('live action authorization expired');
  }
}

function _authorizationGatewayFlagAllowed(
  authorization: LiveActionAuthorization,
  expectedGatewayFlag: string,
): boolean {
  if (!Array.isArray(authorization.gateway_live_flags)) {
    return false;
  }
  if (authorization.gateway_live_flags.includes(expectedGatewayFlag)) {
    return true;
  }
  return (
    expectedGatewayFlag === 'GATEWAY_LIVE_ETHEREUM_TRANSACTION_ENABLED' &&
    authorization.action === 'wallet_send' &&
    authorization.gateway_live_flags.includes('GATEWAY_LIVE_WALLET_SEND_ENABLED')
  );
}

function assertExpectedAuthorizationField(actual: unknown, expected: unknown, label: string): void {
  if (expected !== undefined && actual !== expected) {
    throw new Error(`live action authorization ${label} mismatch`);
  }
}

function assertExpectedAuthorizationDecimalField(actual: unknown, expected: unknown, label: string): void {
  if (expected === undefined) {
    return;
  }
  if (normalizeDecimal(actual) !== normalizeDecimal(expected)) {
    throw new Error(`live action authorization ${label} mismatch`);
  }
}

function normalizeDecimal(value: unknown): string {
  const text = String(value).trim();
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (match === null) {
    return text;
  }
  const sign = match[1] === '-' ? '-' : '';
  const integer = match[2].replace(/^0+(?=\d)/, '');
  const fraction = (match[3] ?? '').replace(/0+$/, '');
  return `${sign}${integer}${fraction === '' ? '' : `.${fraction}`}`;
}

function assertAuthorizationSignature(authorization: LiveActionAuthorization): void {
  const secret = (process.env[LIVE_ACTION_AUTH_SECRET_ENV] ?? '').trim();
  if (secret === '') {
    throw new Error('live action authorization secret missing');
  }
  if (typeof authorization.signature !== 'string' || authorization.signature.trim() === '') {
    throw new Error('live action authorization signature missing');
  }
  const { signature, ...payload } = authorization;
  const expected = createHmac('sha256', secret)
    .update(JSON.stringify(payload, Object.keys(payload).sort()))
    .digest('hex');
  const received = new Uint8Array(Buffer.from(signature, 'hex'));
  const expectedBuffer = new Uint8Array(Buffer.from(expected, 'hex'));
  if (received.length !== expectedBuffer.length || !timingSafeEqual(received, expectedBuffer)) {
    throw new Error('live action authorization signature mismatch');
  }
}

function parseUtcDate(value: unknown): Date {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('live action authorization expiry missing');
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('live action authorization expiry invalid');
  }
  return parsed;
}

function liveOperationActions(operation: string): string[] {
  switch (operation) {
    case 'wallet_send':
      return ['wallet_send'];
    case '0x_execute_quote':
    case 'swap':
      return ['gateway_swap'];
    case 'ethereum_transaction':
    case 'solana_transaction':
    case 'solana_raw_transaction':
      return ['gateway_swap', 'lp_add', 'lp_remove', 'bridge', 'wallet_send'];
    case 'sign_typed_data':
      return ['order', 'gateway_swap'];
    default:
      return ['gateway_swap', 'lp_add', 'lp_remove', 'wallet_send', 'order'];
  }
}
