import { createHmac, timingSafeEqual } from 'crypto';

export const LIVE_MUTATIONS_ENV = 'GATEWAY_LIVE_MUTATIONS_ENABLED';
export const LIVE_ACTION_AUTH_SECRET_ENV = 'MARLIN_LIVE_ACTION_AUTH_SECRET';

const SAFE_NETWORK_MARKERS = ['testnet', 'devnet', 'sepolia', 'goerli', 'amoy', 'fuji', 'local'];

export interface MainnetMutationGuardInput {
  chain: string;
  liveActionAuthorization?: LiveActionAuthorization;
  network: string;
  operation: string;
}

export interface LiveActionAuthorization {
  action?: unknown;
  blockers?: unknown;
  expires_at_utc?: unknown;
  gateway_live_flags?: unknown;
  network?: unknown;
  signature?: unknown;
  status?: unknown;
  version?: unknown;
}

export function assertMainnetMutationAllowed(input: MainnetMutationGuardInput): void {
  if (!isMainnetNetwork(input.network)) {
    return;
  }
  const operationEnv = liveOperationEnv(input.operation);
  if (envFlagEnabled(operationEnv)) {
    assertLiveActionAuthorization(input.liveActionAuthorization, {
      expectedActions: liveOperationActions(input.operation),
      expectedGatewayFlag: operationEnv,
      expectedNetwork: input.network,
    });
    return;
  }
  throw new Error(
    `mainnet mutation disabled for ${input.chain}/${input.network}/${input.operation}; ` +
      `set ${operationEnv}=true only behind Marlin live gates`,
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
    expectedActions,
    expectedGatewayFlag,
    expectedNetwork,
  }: {
    expectedActions: string[];
    expectedGatewayFlag: string;
    expectedNetwork: string;
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
    !authorization.gateway_live_flags.includes(expectedGatewayFlag)
  ) {
    throw new Error('live action authorization Gateway flag mismatch');
  }
  const expiresAt = parseUtcDate(authorization.expires_at_utc);
  if (expiresAt.getTime() <= Date.now()) {
    throw new Error('live action authorization expired');
  }
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
      return ['gateway_swap', 'lp_add', 'lp_remove'];
    case 'sign_typed_data':
      return ['order', 'gateway_swap'];
    default:
      return ['gateway_swap', 'lp_add', 'lp_remove', 'wallet_send', 'order'];
  }
}
