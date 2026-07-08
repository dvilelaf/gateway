import { createHmac } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';

import {
  BridgeExecutionExpectation,
  assertBridgeExecutionAllowed,
  assertMainnetMutationAllowed,
} from '../../src/services/runtime-guard';

const ROOT = path.resolve(__dirname, '../..');

describe('runtime guard', () => {
  const originalEnv = process.env.GATEWAY_LIVE_MUTATIONS_ENABLED;
  const originalSwapEnv = process.env.GATEWAY_LIVE_SWAP_ENABLED;
  const originalBridgeEnv = process.env.GATEWAY_LIVE_BRIDGE_EXECUTE_ENABLED;
  const originalEthereumTransactionEnv = process.env.GATEWAY_LIVE_ETHEREUM_TRANSACTION_ENABLED;
  const originalBridgeAllowlist = process.env.GATEWAY_BRIDGE_PROVIDER_ALLOWLIST;
  const originalAuthSecret = process.env.MARLIN_LIVE_ACTION_AUTH_SECRET;
  const originalMarlinRuntimeProfile = process.env.MARLIN_RUNTIME_PROFILE;
  const originalGatewayProviderIntentToken = process.env.MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.GATEWAY_LIVE_MUTATIONS_ENABLED;
    } else {
      process.env.GATEWAY_LIVE_MUTATIONS_ENABLED = originalEnv;
    }
    if (originalSwapEnv === undefined) {
      delete process.env.GATEWAY_LIVE_SWAP_ENABLED;
    } else {
      process.env.GATEWAY_LIVE_SWAP_ENABLED = originalSwapEnv;
    }
    if (originalBridgeEnv === undefined) {
      delete process.env.GATEWAY_LIVE_BRIDGE_EXECUTE_ENABLED;
    } else {
      process.env.GATEWAY_LIVE_BRIDGE_EXECUTE_ENABLED = originalBridgeEnv;
    }
    if (originalEthereumTransactionEnv === undefined) {
      delete process.env.GATEWAY_LIVE_ETHEREUM_TRANSACTION_ENABLED;
    } else {
      process.env.GATEWAY_LIVE_ETHEREUM_TRANSACTION_ENABLED = originalEthereumTransactionEnv;
    }
    if (originalBridgeAllowlist === undefined) {
      delete process.env.GATEWAY_BRIDGE_PROVIDER_ALLOWLIST;
    } else {
      process.env.GATEWAY_BRIDGE_PROVIDER_ALLOWLIST = originalBridgeAllowlist;
    }
    if (originalAuthSecret === undefined) {
      delete process.env.MARLIN_LIVE_ACTION_AUTH_SECRET;
    } else {
      process.env.MARLIN_LIVE_ACTION_AUTH_SECRET = originalAuthSecret;
    }
    if (originalMarlinRuntimeProfile === undefined) {
      delete process.env.MARLIN_RUNTIME_PROFILE;
    } else {
      process.env.MARLIN_RUNTIME_PROFILE = originalMarlinRuntimeProfile;
    }
    if (originalGatewayProviderIntentToken === undefined) {
      delete process.env.MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN;
    } else {
      process.env.MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN = originalGatewayProviderIntentToken;
    }
  });

  it('allows testnet and devnet mutations by default', () => {
    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'ethereum',
        network: 'sepolia',
        operation: 'wallet_send',
      }),
    ).not.toThrow();
    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'solana',
        network: 'devnet',
        operation: 'swap',
      }),
    ).not.toThrow();
  });

  it('blocks mainnet mutations by default', () => {
    delete process.env.GATEWAY_LIVE_MUTATIONS_ENABLED;
    delete process.env.MARLIN_RUNTIME_PROFILE;

    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'ethereum',
        network: 'base',
        operation: 'swap',
      }),
    ).toThrow(/mainnet mutation disabled/);
    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'solana',
        network: 'mainnet-beta',
        operation: 'wallet_send',
      }),
    ).toThrow(/GATEWAY_LIVE_WALLET_SEND_ENABLED=true/);
  });

  it('keeps direct mainnet mutations blocked in Marlin runtime profile', () => {
    process.env.GATEWAY_LIVE_SOLANA_RAW_TRANSACTION_ENABLED = 'true';
    process.env.MARLIN_RUNTIME_PROFILE = 'marlin';

    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'solana',
        network: 'mainnet-beta',
        operation: 'solana_raw_transaction',
      }),
    ).toThrow(/direct mainnet mutation disabled/);
  });

  it('allows Marlin provider-intent swap raw transaction authorization', () => {
    delete process.env.GATEWAY_LIVE_SOLANA_RAW_TRANSACTION_ENABLED;
    process.env.MARLIN_RUNTIME_PROFILE = 'marlin';

    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'solana',
        internalProviderIntentSource: 'jupiter_execute_swap',
        liveActionAuthorization: {
          action: 'gateway_swap',
          connector_id: 'jupiter',
          network: 'mainnet-beta',
          notional: '0.0001',
          scope: 'provider_intent',
          slippage_bps: '100',
          source: 'marlin',
          wallet_address: 'solana-wallet',
        },
        network: 'mainnet-beta',
        operation: 'solana_raw_transaction',
        expectedConnectorId: 'jupiter',
        expectedNotional: '0.0001',
        expectedSlippageBps: '100',
        expectedWalletAddress: 'solana-wallet',
      }),
    ).not.toThrow();
  });

  it('allows Marlin provider-intent Orca swap Solana transaction authorization', () => {
    delete process.env.GATEWAY_LIVE_SOLANA_TRANSACTION_ENABLED;
    process.env.MARLIN_RUNTIME_PROFILE = 'marlin';

    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'solana',
        internalProviderIntentSource: 'orca_execute_swap',
        liveActionAuthorization: {
          action: 'gateway_swap',
          connector_id: 'orca',
          network: 'mainnet-beta',
          notional: '0.0001',
          scope: 'provider_intent',
          slippage_bps: '100',
          source: 'marlin',
          wallet_address: 'solana-wallet',
        },
        network: 'mainnet-beta',
        operation: 'solana_transaction',
        expectedConnectorId: 'orca',
        expectedNotional: '0.0001',
        expectedSlippageBps: '100',
        expectedWalletAddress: 'solana-wallet',
      }),
    ).not.toThrow();
  });

  it('allows Marlin provider-intent Aerodrome swap Ethereum transaction authorization', () => {
    delete process.env.GATEWAY_LIVE_ETHEREUM_TRANSACTION_ENABLED;
    process.env.MARLIN_RUNTIME_PROFILE = 'marlin';

    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'ethereum',
        internalProviderIntentSource: 'aerodrome_execute_swap',
        liveActionAuthorization: {
          action: 'gateway_swap',
          connector_id: 'aerodrome',
          network: 'base',
          notional: '100',
          scope: 'provider_intent',
          slippage_bps: '100',
          source: 'marlin',
          wallet_address: '0x00000000000000000000000000000000000000aa',
        },
        network: 'base',
        operation: 'ethereum_transaction',
        expectedConnectorId: 'aerodrome',
        expectedNotional: '100',
        expectedSlippageBps: '100',
        expectedWalletAddress: '0x00000000000000000000000000000000000000aa',
      }),
    ).not.toThrow();
  });

  it('does not let Marlin provider-intent swap authorization bypass other operations', () => {
    delete process.env.GATEWAY_LIVE_ETHEREUM_TRANSACTION_ENABLED;
    delete process.env.GATEWAY_LIVE_WALLET_SEND_ENABLED;
    process.env.MARLIN_RUNTIME_PROFILE = 'marlin';
    const authorization = {
      action: 'gateway_swap',
      scope: 'provider_intent',
      source: 'marlin',
    };

    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'ethereum',
        liveActionAuthorization: authorization,
        network: 'mainnet',
        operation: 'ethereum_transaction',
      }),
    ).toThrow(/direct mainnet mutation disabled/);
    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'solana',
        liveActionAuthorization: authorization,
        network: 'mainnet-beta',
        operation: 'wallet_send',
      }),
    ).toThrow(/direct mainnet mutation disabled/);

    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'ethereum',
        internalProviderIntentSource: 'aerodrome_execute_swap',
        liveActionAuthorization: {
          action: 'gateway_swap',
          scope: 'provider_intent',
          source: 'marlin',
        },
        network: 'mainnet',
        operation: 'ethereum_transaction',
      }),
    ).toThrow(/direct mainnet mutation disabled/);
  });

  it('does not let public provider-intent markers bypass Solana raw transaction guard', () => {
    delete process.env.GATEWAY_LIVE_SOLANA_RAW_TRANSACTION_ENABLED;
    process.env.MARLIN_RUNTIME_PROFILE = 'marlin';

    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'solana',
        liveActionAuthorization: {
          action: 'gateway_swap',
          scope: 'provider_intent',
          source: 'marlin',
        },
        network: 'mainnet-beta',
        operation: 'solana_raw_transaction',
      }),
    ).toThrow(/direct mainnet mutation disabled/);
  });

  it('does not let public provider-intent source markers bypass Solana raw transaction guard', () => {
    delete process.env.GATEWAY_LIVE_SOLANA_RAW_TRANSACTION_ENABLED;
    process.env.MARLIN_RUNTIME_PROFILE = 'marlin';

    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'solana',
        liveActionAuthorization: {
          action: 'gateway_swap',
          providerIntentSource: 'jupiter_execute_swap',
          scope: 'provider_intent',
          source: 'marlin',
        } as any,
        network: 'mainnet-beta',
        operation: 'solana_raw_transaction',
      }),
    ).toThrow(/direct mainnet mutation disabled/);
  });

  it('does not allow mainnet mutations with only the broad flag enabled', () => {
    process.env.GATEWAY_LIVE_MUTATIONS_ENABLED = 'true';
    delete process.env.GATEWAY_LIVE_SWAP_ENABLED;

    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'ethereum',
        network: 'mainnet',
        operation: 'swap',
      }),
    ).toThrow(/GATEWAY_LIVE_SWAP_ENABLED=true/);
  });

  it('allows mainnet mutations when operation is enabled without authorization', () => {
    delete process.env.GATEWAY_LIVE_MUTATIONS_ENABLED;
    process.env.GATEWAY_LIVE_SWAP_ENABLED = 'true';

    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'ethereum',
        network: 'mainnet',
        operation: 'swap',
      }),
    ).not.toThrow();
  });

  it('ignores unsigned live action authorization artifacts', () => {
    process.env.GATEWAY_LIVE_SWAP_ENABLED = 'true';
    const authorization = approvedAuthorization({
      gatewayLiveFlags: ['GATEWAY_LIVE_SWAP_ENABLED'],
      network: 'mainnet',
    });
    delete authorization.signature;

    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'ethereum',
        network: 'mainnet',
        operation: 'swap',
      }),
    ).not.toThrow();
  });

  it('ignores tampered live action authorization artifacts', () => {
    process.env.GATEWAY_LIVE_SWAP_ENABLED = 'true';
    const authorization = approvedAuthorization({
      gatewayLiveFlags: ['GATEWAY_LIVE_SWAP_ENABLED'],
      network: 'mainnet',
    });
    authorization.notional = '1000';

    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'ethereum',
        network: 'mainnet',
        operation: 'swap',
      }),
    ).not.toThrow();
  });

  it('allows mainnet mutations when operation is explicitly enabled', () => {
    delete process.env.GATEWAY_LIVE_MUTATIONS_ENABLED;
    process.env.GATEWAY_LIVE_SWAP_ENABLED = 'true';

    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'ethereum',
        network: 'mainnet',
        operation: 'swap',
      }),
    ).not.toThrow();
  });

  it('ignores expired live action authorization artifacts', () => {
    process.env.GATEWAY_LIVE_WALLET_SEND_ENABLED = 'true';

    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'ethereum',
        network: 'base',
        operation: 'wallet_send',
      }),
    ).not.toThrow();
  });

  it('ignores authorization artifacts missing the required operation flag', () => {
    process.env.GATEWAY_LIVE_WALLET_SEND_ENABLED = 'true';

    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'ethereum',
        network: 'base',
        operation: 'wallet_send',
      }),
    ).not.toThrow();
  });

  it('ignores authorization artifacts for the wrong network', () => {
    process.env.GATEWAY_LIVE_WALLET_SEND_ENABLED = 'true';

    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'ethereum',
        network: 'base',
        operation: 'wallet_send',
      }),
    ).not.toThrow();
  });

  it.each([
    ['connector id', { expectedConnectorId: 'uniswap' }],
    ['wallet address', { expectedWalletAddress: '0xdef' }],
    ['notional', { expectedNotional: '2' }],
    ['gas', { expectedGas: '0.002' }],
    ['slippage bps', { expectedSlippageBps: '50' }],
  ])('ignores authorization artifacts for the wrong signed %s cap', (_name, expectedFields) => {
    process.env.GATEWAY_LIVE_SWAP_ENABLED = 'true';

    const input = {
      chain: 'ethereum',
      network: 'mainnet',
      operation: 'swap',
      ...expectedFields,
    };

    expect(() => assertMainnetMutationAllowed(input)).not.toThrow();
  });

  it('accepts numerically equivalent signed cap values', () => {
    process.env.GATEWAY_LIVE_SWAP_ENABLED = 'true';
    process.env.MARLIN_LIVE_ACTION_AUTH_SECRET = 'test-secret';

    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'ethereum',
        expectedGas: 0.001,
        expectedNotional: 1,
        expectedSlippageBps: 25,
        network: 'mainnet',
        operation: 'swap',
      }),
    ).not.toThrow();
  });

  it('rejects bridge authorization route data mismatches', () => {
    expect(() =>
      assertBridgeExecutionAllowed(
        approvedBridgeAuthorization({ nonce: 'bridge-route-mismatch' }),
        approvedBridgeExpectation({ providerRouteId: 'route-999' }),
      ),
    ).toThrow(/bridge authorization does not match execution payload/);
  });

  it('rejects bridge execution when the same authorization nonce is reused', () => {
    process.env.MARLIN_LIVE_ACTION_AUTH_SECRET = 'test-secret';
    const authorization = approvedBridgeAuthorization({ nonce: 'bridge-nonce-replay' });

    expect(() => assertBridgeExecutionAllowed(authorization, approvedBridgeExpectation())).not.toThrow();
    expect(() => assertBridgeExecutionAllowed(authorization, approvedBridgeExpectation())).toThrow(
      /bridge authorization nonce replay/,
    );
  });

  it('allows bridge authorizations to pass the lower-level Gateway transaction guard', () => {
    process.env.GATEWAY_LIVE_ETHEREUM_TRANSACTION_ENABLED = 'true';
    process.env.MARLIN_LIVE_ACTION_AUTH_SECRET = 'test-secret';

    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'ethereum',
        network: 'base',
        operation: 'ethereum_transaction',
      }),
    ).not.toThrow();
  });

  it('allows Marlin CCTP treasury authorization on source and destination EVM networks', () => {
    delete process.env.GATEWAY_LIVE_ETHEREUM_TRANSACTION_ENABLED;
    process.env.MARLIN_RUNTIME_PROFILE = 'marlin';
    const authorization = {
      action: 'gateway_rebalance',
      connector_id: 'treasury',
      destination_address: '0x00000000000000000000000000000000000000bb',
      destination_network: 'base',
      network: 'mainnet',
      notional: '1.5',
      scope: 'provider_treasury',
      source: 'marlin',
      wallet_address: '0x00000000000000000000000000000000000000aa',
    };

    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'ethereum',
        expectedConnectorId: 'treasury',
        expectedNotional: '1.5',
        expectedWalletAddress: '0x00000000000000000000000000000000000000aa',
        internalProviderIntentSource: 'cctp_usdc_rebalance',
        liveActionAuthorization: authorization,
        network: 'mainnet',
        operation: 'ethereum_transaction',
      }),
    ).not.toThrow();
    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'ethereum',
        expectedConnectorId: 'treasury',
        expectedNotional: '1.5',
        expectedWalletAddress: '0x00000000000000000000000000000000000000bb',
        internalProviderIntentSource: 'cctp_usdc_rebalance',
        liveActionAuthorization: authorization,
        network: 'base',
        operation: 'ethereum_transaction',
      }),
    ).not.toThrow();
  });

  it('allows Marlin CCTP treasury authorization on Solana destination receiveMessage', () => {
    delete process.env.GATEWAY_LIVE_SOLANA_RAW_TRANSACTION_ENABLED;
    process.env.MARLIN_RUNTIME_PROFILE = 'marlin';
    const authorization = {
      action: 'gateway_rebalance',
      connector_id: 'treasury',
      destination_address: '9AtFd6KcR9tx5Etxc9SVkYrkZb7yC5BDibao7yPT5Ce1',
      destination_network: 'mainnet-beta',
      network: 'base',
      notional: '1',
      scope: 'provider_treasury',
      source: 'marlin',
      wallet_address: '0x043F9e880763576c15eBCB7d4f0D7453F2Db1708',
    };

    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'solana',
        expectedConnectorId: 'treasury',
        expectedNotional: '1',
        expectedWalletAddress: '9AtFd6KcR9tx5Etxc9SVkYrkZb7yC5BDibao7yPT5Ce1',
        internalProviderIntentSource: 'cctp_usdc_rebalance',
        liveActionAuthorization: authorization,
        network: 'mainnet-beta',
        operation: 'solana_raw_transaction',
      }),
    ).not.toThrow();
  });

  it('allows Marlin Squid Router treasury authorization for quote-bound Ethereum transaction', () => {
    delete process.env.GATEWAY_LIVE_ETHEREUM_TRANSACTION_ENABLED;
    process.env.MARLIN_RUNTIME_PROFILE = 'marlin';

    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'ethereum',
        expectedConnectorId: 'treasury',
        expectedNotional: '2.5',
        expectedWalletAddress: '0x00000000000000000000000000000000000000aa',
        internalProviderIntentSource: 'squid_router_rebalance',
        liveActionAuthorization: {
          action: 'gateway_rebalance',
          connector_id: 'treasury',
          network: 'base',
          notional: '2.5',
          scope: 'provider_treasury',
          source: 'marlin',
          wallet_address: '0x00000000000000000000000000000000000000aa',
        },
        network: 'base',
        operation: 'ethereum_transaction',
      }),
    ).not.toThrow();
  });

  it('blocks Squid Router treasury authorization with mismatched wallet or connector context', () => {
    delete process.env.GATEWAY_LIVE_ETHEREUM_TRANSACTION_ENABLED;
    process.env.MARLIN_RUNTIME_PROFILE = 'marlin';
    const authorization = {
      action: 'gateway_rebalance',
      connector_id: 'treasury',
      network: 'base',
      notional: '2.5',
      scope: 'provider_treasury',
      source: 'marlin',
      wallet_address: '0x00000000000000000000000000000000000000aa',
    };

    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'ethereum',
        expectedConnectorId: 'treasury',
        expectedNotional: '2.5',
        expectedWalletAddress: '0x00000000000000000000000000000000000000bb',
        internalProviderIntentSource: 'squid_router_rebalance',
        liveActionAuthorization: authorization,
        network: 'base',
        operation: 'ethereum_transaction',
      }),
    ).toThrow(/direct mainnet mutation disabled/);
    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'ethereum',
        expectedConnectorId: 'squid',
        expectedNotional: '2.5',
        expectedWalletAddress: '0x00000000000000000000000000000000000000aa',
        internalProviderIntentSource: 'squid_router_rebalance',
        liveActionAuthorization: authorization,
        network: 'base',
        operation: 'ethereum_transaction',
      }),
    ).toThrow(/direct mainnet mutation disabled/);
  });

  it('blocks Solana CCTP treasury authorization without destination-scoped fields', () => {
    delete process.env.GATEWAY_LIVE_SOLANA_RAW_TRANSACTION_ENABLED;
    process.env.MARLIN_RUNTIME_PROFILE = 'marlin';

    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'solana',
        expectedConnectorId: 'treasury',
        expectedNotional: '1',
        expectedWalletAddress: '9AtFd6KcR9tx5Etxc9SVkYrkZb7yC5BDibao7yPT5Ce1',
        internalProviderIntentSource: 'cctp_usdc_rebalance',
        liveActionAuthorization: {
          action: 'gateway_rebalance',
          connector_id: 'treasury',
          network: 'mainnet-beta',
          notional: '1',
          scope: 'provider_treasury',
          source: 'marlin',
          wallet_address: '9AtFd6KcR9tx5Etxc9SVkYrkZb7yC5BDibao7yPT5Ce1',
        },
        network: 'mainnet-beta',
        operation: 'solana_raw_transaction',
      }),
    ).toThrow(/direct mainnet mutation disabled/);
  });

  it('blocks Solana CCTP treasury authorization without explicit raw transaction guard context', () => {
    delete process.env.GATEWAY_LIVE_SOLANA_RAW_TRANSACTION_ENABLED;
    process.env.MARLIN_RUNTIME_PROFILE = 'marlin';

    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'solana',
        internalProviderIntentSource: 'cctp_usdc_rebalance',
        liveActionAuthorization: {
          action: 'gateway_rebalance',
          connector_id: 'treasury',
          destination_address: '9AtFd6KcR9tx5Etxc9SVkYrkZb7yC5BDibao7yPT5Ce1',
          destination_network: 'mainnet-beta',
          network: 'base',
          notional: '1',
          scope: 'provider_treasury',
          source: 'marlin',
          wallet_address: '0x043F9e880763576c15eBCB7d4f0D7453F2Db1708',
        },
        network: 'mainnet-beta',
        operation: 'solana_raw_transaction',
      }),
    ).toThrow(/direct mainnet mutation disabled/);
  });

  it('allows wallet send authorizations to pass the lower-level Ethereum transaction guard', () => {
    process.env.GATEWAY_LIVE_ETHEREUM_TRANSACTION_ENABLED = 'true';
    process.env.MARLIN_LIVE_ACTION_AUTH_SECRET = 'test-secret';

    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'ethereum',
        network: 'base',
        operation: 'ethereum_transaction',
      }),
    ).not.toThrow();
  });
});

function approvedAuthorization({
  action = 'gateway_swap',
  expiresAtUtc = '2099-01-01T00:00:00Z',
  gatewayLiveFlags,
  network,
}: {
  action?: string;
  expiresAtUtc?: string;
  gatewayLiveFlags: string[];
  network: string;
}): Record<string, unknown> {
  const authorization: Record<string, unknown> = {
    action,
    api_live_flag: 'TRADING_SAFETY_LIVE_GATEWAY_SWAP_EXECUTE_ENABLED',
    blockers: [],
    connector_id: 'gateway',
    edge_sha256: 'e'.repeat(64),
    expires_at_utc: expiresAtUtc,
    gas: '0.001',
    gateway_live_flags: gatewayLiveFlags,
    generated_at_utc: '2026-06-14T10:00:00Z',
    live_gate_sha256: 'g'.repeat(64),
    network,
    notional: '1',
    slippage_bps: '25',
    status: 'approved',
    version: 'live-action-authorization-v1',
    wallet_address: '0xabc',
  };
  authorization.signature = signature(authorization);
  return authorization;
}

function approvedBridgeExpectation(overrides: Partial<BridgeExecutionExpectation> = {}): BridgeExecutionExpectation {
  return {
    calldataHash: 'c'.repeat(64),
    provider: 'lifi',
    providerRouteId: 'route-123',
    quoteId: 'quote-456',
    routePayloadHash: 'p'.repeat(64),
    sourceChainId: '8453',
    target: '0x1111111111111111111111111111111111111111',
    value: '0',
    ...overrides,
  };
}

function approvedBridgeAuthorization({ nonce }: { nonce: string }): Record<string, unknown> {
  const expectation = approvedBridgeExpectation();
  const authorization = approvedAuthorization({
    action: 'bridge',
    gatewayLiveFlags: [
      'GATEWAY_LIVE_BRIDGE_EXECUTE_ENABLED',
      'GATEWAY_LIVE_ETHEREUM_TRANSACTION_ENABLED',
      'GATEWAY_LIVE_SOLANA_RAW_TRANSACTION_ENABLED',
      'GATEWAY_LIVE_SOLANA_TRANSACTION_ENABLED',
    ],
    network: 'base',
  });
  authorization.bridge_authorization_nonce = nonce;
  authorization.bridge_provider = expectation.provider;
  authorization.bridge_provider_route_id = expectation.providerRouteId;
  authorization.bridge_quote_id = expectation.quoteId;
  authorization.bridge_route_payload_hash = expectation.routePayloadHash;
  authorization.bridge_source_chain_id = expectation.sourceChainId;
  authorization.bridge_tx_calldata_hash = expectation.calldataHash;
  authorization.bridge_tx_target = expectation.target;
  authorization.bridge_tx_value = expectation.value;
  authorization.signature = signature(authorization);
  return authorization;
}

function signature(authorization: Record<string, unknown>): string {
  const payload = { ...authorization };
  delete payload.signature;
  return createHmac('sha256', 'test-secret')
    .update(JSON.stringify(payload, Object.keys(payload).sort()))
    .digest('hex');
}

describe('runtime guard wiring', () => {
  it('registers bridge routes on the Gateway app', () => {
    const source = readFileSync(path.join(ROOT, 'src/app.ts'), 'utf8');

    expect(source).toContain("import { bridgeRoutes } from './bridge/bridge.routes'");
    expect(source).toContain("app.register(bridgeRoutes, { prefix: '/bridge' })");
  });

  it('checks bridge authorization before any bridge transaction broadcast', () => {
    const source = readFileSync(path.join(ROOT, 'src/bridge/bridge.routes.ts'), 'utf8');
    const execute = source.slice(source.indexOf("'/execute'"));

    expect(execute.indexOf('assertBridgeExecutionAllowed(')).toBeLessThan(execute.indexOf('sendTransaction('));
  });

  it('fails closed for legacy raw bridge execution in Marlin runtime before broadcast', () => {
    const source = readFileSync(path.join(ROOT, 'src/bridge/bridge.routes.ts'), 'utf8');
    const execute = source.slice(source.indexOf("'/execute'"));

    expect(execute).toContain('MARLIN_RUNTIME_PROFILE');
    expect(execute).toContain('raw bridge execution disabled in Marlin runtime');
    expect(execute.indexOf('MARLIN_RUNTIME_PROFILE')).toBeLessThan(execute.indexOf('sendTransaction('));
  });

  it('checks wallet sends before chain-specific send paths', () => {
    const source = readFileSync(path.join(ROOT, 'src/wallet/utils.ts'), 'utf8');
    const sendTransaction = source.slice(
      source.indexOf('export async function sendTransaction'),
      source.indexOf('/**\n * Send a Solana transaction'),
    );

    expect(sendTransaction.indexOf('assertMainnetMutationAllowed(')).toBeLessThan(
      sendTransaction.indexOf('sendSolanaTransaction('),
    );
    expect(sendTransaction.indexOf('assertMainnetMutationAllowed(')).toBeLessThan(
      sendTransaction.indexOf('sendEthereumTransaction('),
    );
    expect(sendTransaction).not.toContain('liveActionAuthorization: req.liveActionAuthorization');

    const sendSolanaTransaction = source.slice(
      source.indexOf('async function sendSolanaTransaction'),
      source.indexOf('/**\n * Send an Ethereum transaction'),
    );
    expect(sendSolanaTransaction).toMatch(/sendAndConfirmTransaction\([\s\S]*req\.liveActionAuthorization/);

    const sendEthereumTransaction = source.slice(source.indexOf('async function sendEthereumTransaction'));
    expect(sendEthereumTransaction).toMatch(/prepareGasOptions\([\s\S]*req\.liveActionAuthorization/);
  });

  it('exposes live action authorization on wallet mutation schemas', () => {
    const source = readFileSync(path.join(ROOT, 'src/wallet/schemas.ts'), 'utf8');
    const sendSchema = source.slice(
      source.indexOf('export const SendTransactionRequestSchema'),
      source.indexOf('export const SendTransactionResponseSchema'),
    );
    const signMessageSchema = source.slice(
      source.indexOf('export const SignMessageRequestSchema'),
      source.indexOf('export const SignMessageResponseSchema'),
    );
    const signSchema = source.slice(
      source.indexOf('export const SignTypedDataRequestSchema'),
      source.indexOf('export const SignTypedDataResponseSchema'),
    );

    expect(sendSchema).toContain('liveActionAuthorization');
    expect(signMessageSchema).toContain('liveActionAuthorization');
    expect(signSchema).toContain('liveActionAuthorization');
  });

  it('checks Ethereum gas preparation before transaction callers can broadcast', () => {
    const source = readFileSync(path.join(ROOT, 'src/chains/ethereum/ethereum.ts'), 'utf8');
    const prepareGasOptions = source.slice(
      source.indexOf('public async prepareGasOptions'),
      source.indexOf('/**\n   * Get a contract instance'),
    );

    expect(prepareGasOptions.indexOf('assertMainnetMutationAllowed(')).toBeLessThan(
      prepareGasOptions.indexOf('const gasOptions'),
    );
    expect(prepareGasOptions).toContain('liveActionAuthorization');
  });

  it('passes live action authorization through Ethereum approve wrap and unwrap routes', () => {
    const schemas = readFileSync(path.join(ROOT, 'src/chains/ethereum/schemas.ts'), 'utf8');
    const ethereum = readFileSync(path.join(ROOT, 'src/chains/ethereum/ethereum.ts'), 'utf8');
    for (const [start, end] of [
      ['export const ApproveRequestSchema', 'export const ApproveResponseSchema'],
      ['export const WrapRequestSchema', 'export const WrapResponseSchema'],
      ['export const UnwrapRequestSchema', 'export const UnwrapResponseSchema'],
    ]) {
      const schema = schemas.slice(schemas.indexOf(start), schemas.indexOf(end));
      expect(schema).toContain('liveActionAuthorization');
    }

    for (const file of ['approve.ts', 'wrap.ts', 'unwrap.ts']) {
      const source = readFileSync(path.join(ROOT, `src/chains/ethereum/routes/${file}`), 'utf8');
      expect(source).toContain('liveActionAuthorization');
      expect(source).toContain('prepareGasOptions');
    }

    const approveERC20 = ethereum.slice(
      ethereum.indexOf('public async approveERC20'),
      ethereum.indexOf('/**\n   * Get current block number'),
    );
    expect(approveERC20).toMatch(/prepareGasOptions\([\s\S]*liveActionAuthorization/);

    const wrapNativeToken = ethereum.slice(
      ethereum.indexOf('public async wrapNativeToken'),
      ethereum.indexOf('/**\n   * Get a wallet address example'),
    );
    expect(wrapNativeToken).toMatch(/prepareGasOptions\([\s\S]*liveActionAuthorization/);
  });

  it('checks Solana send helpers before raw transaction submission', () => {
    const source = readFileSync(path.join(ROOT, 'src/chains/solana/solana.ts'), 'utf8');
    const sendTransaction = source.slice(
      source.indexOf('public async sendAndConfirmTransaction'),
      source.indexOf('async sendAndConfirmRawTransaction'),
    );
    const sendRaw = source.slice(
      source.indexOf('async sendAndConfirmRawTransaction'),
      source.indexOf('private async _sendAndConfirmRawTransaction'),
    );

    expect(sendTransaction.indexOf('assertMainnetMutationAllowed(')).toBeLessThan(
      sendTransaction.indexOf('_sendAndConfirmRawTransaction'),
    );
    expect(sendRaw.indexOf('assertMainnetMutationAllowed(')).toBeLessThan(
      sendRaw.indexOf('_sendAndConfirmRawTransaction'),
    );
    expect(sendTransaction).toContain('liveActionAuthorization');
    expect(sendRaw).toContain('liveActionAuthorization');
  });

  it('checks direct Solana raw broadcasts before sendRawTransaction', () => {
    const source = readFileSync(path.join(ROOT, 'src/chains/solana/solana.ts'), 'utf8');
    const sendRaw = source.slice(
      source.indexOf('async sendRawTransaction'),
      source.indexOf('async extractBalanceChangesAndFee'),
    );

    const guardIndex = sendRaw.indexOf('assertMainnetMutationAllowed(');
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(guardIndex).toBeLessThan(sendRaw.indexOf('this.connection.sendRawTransaction('));
    expect(sendRaw).toContain('liveActionAuthorization');
  });

  it('passes live action authorization through Solana wrap and unwrap routes', () => {
    const schemas = readFileSync(path.join(ROOT, 'src/chains/solana/schemas.ts'), 'utf8');
    for (const [start, end] of [
      ['export const WrapRequestSchema', 'export const WrapResponseSchema'],
      ['export const UnwrapRequestSchema', 'export const UnwrapResponseSchema'],
    ]) {
      const schema = schemas.slice(schemas.indexOf(start), schemas.indexOf(end));
      expect(schema).toContain('liveActionAuthorization');
    }

    for (const file of ['wrap.ts', 'unwrap.ts']) {
      const source = readFileSync(path.join(ROOT, `src/chains/solana/routes/${file}`), 'utf8');
      expect(source).toContain('liveActionAuthorization');
      expect(source).toContain('sendAndConfirmRawTransaction(');
      expect(source).toContain('transaction,');
      expect(source).toContain('liveActionAuthorization,');
    }
  });

  it('checks typed-data signing before wallet signing', () => {
    const source = readFileSync(path.join(ROOT, 'src/wallet/routes/signTypedData.ts'), 'utf8');

    expect(source.indexOf('assertMainnetMutationAllowed(')).toBeLessThan(source.indexOf('ethereum.getWallet('));
    expect(source.indexOf('assertMainnetMutationAllowed(')).toBeLessThan(source.indexOf('wallet._signTypedData('));
    expect(source).toContain('liveActionAuthorization');
  });

  it('checks message signing before wallet signing', () => {
    const source = readFileSync(path.join(ROOT, 'src/wallet/utils.ts'), 'utf8');
    const signMessage = source.slice(
      source.indexOf('export async function signMessage'),
      source.indexOf('export async function getWallet'),
    );

    expect(signMessage.indexOf('assertMainnetMutationAllowed(')).toBeLessThan(
      signMessage.indexOf('getInitializedChain('),
    );
    expect(signMessage.indexOf('assertMainnetMutationAllowed(')).toBeLessThan(
      signMessage.indexOf('wallet.signMessage('),
    );
    expect(signMessage).toContain("operation: 'sign_message'");
    expect(signMessage).not.toContain('liveActionAuthorization: req.liveActionAuthorization');
  });

  it('routes AMM ETH add-liquidity branches through Ethereum gas preparation', () => {
    for (const connector of ['uniswap', 'pancakeswap']) {
      const source = readFileSync(path.join(ROOT, `src/connectors/${connector}/amm-routes/addLiquidity.ts`), 'utf8');
      const ethBranch = source.slice(
        source.indexOf("if (quote.baseTokenObj.symbol === 'WETH')"),
        source.indexOf("} else if (quote.quoteTokenObj.symbol === 'WETH')"),
      );

      expect(ethBranch).toContain('ethereum.prepareGasOptions(');
      expect(ethBranch).not.toContain('gasLimit: 300000');
    }
  });

  it('passes live action authorization through EVM AMM swap and liquidity routes', () => {
    for (const connector of ['uniswap', 'pancakeswap']) {
      const schemas = readFileSync(path.join(ROOT, `src/connectors/${connector}/schemas.ts`), 'utf8');
      for (const [start, end] of [
        [
          `export const ${connector === 'uniswap' ? 'Uniswap' : 'Pancakeswap'}AmmAddLiquidityRequest`,
          `export const ${connector === 'uniswap' ? 'Uniswap' : 'Pancakeswap'}AmmRemoveLiquidityRequest`,
        ],
        [
          `export const ${connector === 'uniswap' ? 'Uniswap' : 'Pancakeswap'}AmmRemoveLiquidityRequest`,
          `export const ${connector === 'uniswap' ? 'Uniswap' : 'Pancakeswap'}AmmExecuteSwapRequest`,
        ],
        [
          `export const ${connector === 'uniswap' ? 'Uniswap' : 'Pancakeswap'}AmmExecuteSwapRequest`,
          `export const ${connector === 'uniswap' ? 'Uniswap' : 'Pancakeswap'}ExecuteSwapRequest`,
        ],
      ]) {
        const schema = schemas.slice(schemas.indexOf(start), schemas.indexOf(end));
        expect(schema).toContain('liveActionAuthorization');
      }

      for (const file of ['addLiquidity.ts', 'removeLiquidity.ts', 'executeSwap.ts']) {
        const source = readFileSync(path.join(ROOT, `src/connectors/${connector}/amm-routes/${file}`), 'utf8');
        expect(source).toContain('liveActionAuthorization');
        expect(source).toContain('prepareGasOptions(');
      }
    }
  });

  it('passes live action authorization through Raydium AMM mutation routes only', () => {
    const schemas = readFileSync(path.join(ROOT, 'src/connectors/raydium/schemas.ts'), 'utf8');
    for (const schemaName of [
      'RaydiumAmmExecuteSwapRequest',
      'RaydiumAmmAddLiquidityRequest',
      'RaydiumAmmRemoveLiquidityRequest',
    ]) {
      const start = schemas.indexOf(`export const ${schemaName}`);
      const nextExport = schemas.indexOf('\nexport ', start + 1);
      const schema = schemas.slice(start, nextExport === -1 ? undefined : nextExport);
      expect(schema).toContain('liveActionAuthorization');
    }

    for (const schemaName of [
      'RaydiumAmmGetPoolInfoRequest',
      'RaydiumAmmGetPositionInfoRequest',
      'RaydiumAmmQuoteSwapRequest',
      'RaydiumAmmQuoteLiquidityRequest',
    ]) {
      const start = schemas.indexOf(`export const ${schemaName}`);
      const nextExport = schemas.indexOf('\nexport ', start + 1);
      const schema = schemas.slice(start, nextExport === -1 ? undefined : nextExport);
      expect(schema).not.toContain('liveActionAuthorization');
    }

    for (const file of ['executeSwap.ts', 'addLiquidity.ts', 'removeLiquidity.ts']) {
      const source = readFileSync(path.join(ROOT, `src/connectors/raydium/amm-routes/${file}`), 'utf8');
      expect(source).toContain('liveActionAuthorization');
      expect(source).toMatch(/sendAndConfirmRawTransaction\([\s\S]*liveActionAuthorization/);
    }
  });

  it('does not expose live action authorization through unified swap execution routes', () => {
    const source = readFileSync(path.join(ROOT, 'src/trading/swap/execute.ts'), 'utf8');

    const schema = source.slice(
      source.indexOf('const UnifiedExecuteSwapRequestSchema'),
      source.indexOf('type UnifiedExecuteSwapRequest'),
    );
    expect(schema).not.toContain('liveActionAuthorization');

    const route = source.slice(
      source.indexOf('async (request, reply) =>'),
      source.indexOf('logger.error(`[UnifiedSwap] Execute error'),
    );
    expect(route).toContain('connector,');
    expect(route).not.toContain('liveActionAuthorization');

    for (const connector of [
      'jupiterRouterExecuteSwap',
      'uniswapRouterExecuteSwap',
      'uniswapAmmExecuteSwap',
      'uniswapClmmExecuteSwap',
      'pancakeswapRouterExecuteSwap',
      'pancakeswapAmmExecuteSwap',
      'pancakeswapClmmExecuteSwap',
      'zeroXRouterExecuteSwap',
    ]) {
      const index = source.indexOf(`return await ${connector}(`);
      expect(index).toBeGreaterThanOrEqual(0);
      const end = source.indexOf(');', index);
      expect(end).toBeGreaterThan(index);
      const call = source.slice(index, end);
      expect(call).not.toContain('liveActionAuthorization');
    }
  });

  it('does not expose live action authorization through 0x and Aerodrome public swap schemas', () => {
    const zeroXSchemas = readFileSync(path.join(ROOT, 'src/connectors/0x/schemas.ts'), 'utf8');
    const zeroXQuoteStart = zeroXSchemas.indexOf('export const ZeroXExecuteQuoteRequest');
    const zeroXQuoteEnd = zeroXSchemas.indexOf('// 0x-specific execute-swap request');
    expect(zeroXQuoteStart).toBeGreaterThanOrEqual(0);
    expect(zeroXQuoteEnd).toBeGreaterThan(zeroXQuoteStart);
    const zeroXExecuteQuoteSchema = zeroXSchemas.slice(zeroXQuoteStart, zeroXQuoteEnd);

    const zeroXSwapStart = zeroXSchemas.indexOf('export const ZeroXExecuteSwapRequest');
    expect(zeroXSwapStart).toBeGreaterThanOrEqual(0);
    const zeroXExecuteSwapSchema = zeroXSchemas.slice(zeroXSwapStart);
    expect(zeroXExecuteQuoteSchema).not.toContain('liveActionAuthorization');
    expect(zeroXExecuteSwapSchema).not.toContain('liveActionAuthorization');

    for (const file of ['executeQuote.ts', 'executeSwap.ts']) {
      const source = readFileSync(path.join(ROOT, `src/connectors/0x/router-routes/${file}`), 'utf8');
      expect(source).not.toContain('liveActionAuthorization');
    }

    const aerodromeSchemas = readFileSync(path.join(ROOT, 'src/connectors/aerodrome/schemas.ts'), 'utf8');
    const aerodromeSwapStart = aerodromeSchemas.indexOf('export const AerodromeExecuteSwapRequest');
    const aerodromeSwapEnd = aerodromeSchemas.indexOf('export const AerodromeExecuteQuoteRequest');
    expect(aerodromeSwapStart).toBeGreaterThanOrEqual(0);
    expect(aerodromeSwapEnd).toBeGreaterThan(aerodromeSwapStart);
    const aerodromeSwapSchema = aerodromeSchemas.slice(aerodromeSwapStart, aerodromeSwapEnd);
    expect(aerodromeSwapSchema).not.toContain('liveActionAuthorization');

    const aerodromeExecuteSwap = readFileSync(
      path.join(ROOT, 'src/connectors/aerodrome/router-routes/executeSwap.ts'),
      'utf8',
    );
    expect(aerodromeExecuteSwap).toContain(
      "const MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN_HEADER = 'x-marlin-gateway-provider-intent-token'",
    );
    expect(aerodromeExecuteSwap).toContain('marlinGatewayProviderIntentTokenMatches');
    expect(aerodromeExecuteSwap).toContain(
      "const internalProviderIntentSource = liveActionAuthorization ? 'aerodrome_execute_swap' : undefined",
    );
  });

  it('does not expose live action authorization through direct EVM router swap routes', () => {
    for (const connector of ['uniswap', 'pancakeswap']) {
      for (const file of ['executeQuote.ts', 'executeSwap.ts']) {
        const source = readFileSync(path.join(ROOT, `src/connectors/${connector}/router-routes/${file}`), 'utf8');
        expect(source).not.toContain('liveActionAuthorization');
      }
    }
  });

  it('passes live action authorization through Orca CLMM swap execution', () => {
    const source = readFileSync(path.join(ROOT, 'src/connectors/orca/clmm-routes/executeSwap.ts'), 'utf8');

    const route = source.slice(
      source.indexOf('export const executeSwapRoute'),
      source.indexOf('} catch (e: any)', source.indexOf('export const executeSwapRoute')),
    );
    expect(route).toContain('liveActionAuthorization');
    expect(route).toContain('marlinGatewayProviderIntentTokenMatches');
    expect(source).toContain(
      "const MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN_HEADER = 'x-marlin-gateway-provider-intent-token'",
    );
    expect(source).toContain(
      "const internalProviderIntentSource = liveActionAuthorization ? 'orca_execute_swap' : undefined",
    );

    const callIndex = route.indexOf('return await executeSwap(');
    const executeSwapCall = route.slice(callIndex, route.indexOf(');', callIndex));
    expect(executeSwapCall).toContain('liveActionAuthorization');
    expect(executeSwapCall).toContain('internalProviderIntentSource');
  });

  it('does not require live authorization for universal-router gas estimates', () => {
    for (const connector of ['uniswap', 'pancakeswap']) {
      const source = readFileSync(path.join(ROOT, `src/connectors/${connector}/universal-router.ts`), 'utf8');
      const estimateGas = source.slice(
        source.indexOf('private async estimateGas'),
        source.indexOf('\n  }\n}', source.indexOf('private async estimateGas')),
      );

      expect(estimateGas).toContain('this.provider.estimateGas');
      expect(estimateGas).not.toContain('prepareGasOptions');
      expect(estimateGas).not.toContain('assertMainnetMutationAllowed');
    }
  });

  it('does not expose live action authorization through Jupiter router execution', () => {
    const schemas = readFileSync(path.join(ROOT, 'src/connectors/jupiter/schemas.ts'), 'utf8');
    const executeQuoteSchema = schemas.slice(
      schemas.indexOf('export const JupiterExecuteQuoteRequest'),
      schemas.indexOf('// Jupiter-specific execute-swap request'),
    );
    const executeSwapSchema = schemas.slice(schemas.indexOf('export const JupiterExecuteSwapRequest'));
    expect(executeQuoteSchema).not.toContain('liveActionAuthorization');
    expect(executeSwapSchema).not.toContain('liveActionAuthorization');

    const executeQuote = readFileSync(path.join(ROOT, 'src/connectors/jupiter/router-routes/executeQuote.ts'), 'utf8');
    const executeQuoteRoute = executeQuote.slice(
      executeQuote.indexOf('export const executeQuoteRoute'),
      executeQuote.indexOf('} catch (e)', executeQuote.indexOf('export const executeQuoteRoute')),
    );
    expect(executeQuoteRoute).not.toContain('liveActionAuthorization');
    expect(executeQuoteRoute).toContain(
      'return await executeQuote(walletAddress, network, quoteId, priorityLevel, maxLamports)',
    );

    const executeSwap = readFileSync(path.join(ROOT, 'src/connectors/jupiter/router-routes/executeSwap.ts'), 'utf8');
    const executeSwapRoute = executeSwap.slice(
      executeSwap.indexOf('export const executeSwapRoute'),
      executeSwap.indexOf('} catch (e)', executeSwap.indexOf('export const executeSwapRoute')),
    );
    expect(executeSwapRoute).toContain('liveActionAuthorization');
    expect(executeSwapRoute).toContain('marlinGatewayProviderIntentTokenMatches');
    expect(executeSwap).toContain(
      "const internalProviderIntentSource = liveActionAuthorization ? 'jupiter_execute_swap' : undefined",
    );
    expect(executeSwapRoute).toContain('request.body as typeof JupiterExecuteSwapRequest._type &');
    expect(executeSwap).toContain(
      "const MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN_HEADER = 'x-marlin-gateway-provider-intent-token'",
    );
    expect(executeSwap).not.toContain('process.env.GATEWAY_PASSPHRASE');
  });

  it('passes live action authorization through CLMM position mutations', () => {
    const sharedSchema = readFileSync(path.join(ROOT, 'src/schemas/clmm-schema.ts'), 'utf8');
    for (const [start, end] of [
      ['export const OpenPositionRequest', 'export type OpenPositionRequestType'],
      ['export const AddLiquidityRequest', 'export type AddLiquidityRequestType'],
      ['export const RemoveLiquidityRequest', 'export type RemoveLiquidityRequestType'],
      ['export const CollectFeesRequest', 'export type CollectFeesRequestType'],
      ['export const ClosePositionRequest', 'export type ClosePositionRequestType'],
    ]) {
      const schema = sharedSchema.slice(sharedSchema.indexOf(start), sharedSchema.indexOf(end));
      expect(schema).toContain('liveActionAuthorization');
    }
    const sharedQuotePositionSchema = sharedSchema.slice(
      sharedSchema.indexOf('export const QuotePositionRequest'),
      sharedSchema.indexOf('export type QuotePositionRequestType'),
    );
    expect(sharedQuotePositionSchema).toContain("'liveActionAuthorization'");
    expect(sharedQuotePositionSchema).not.toContain('Type.Any');

    for (const [connector, schemaNames] of [
      [
        'uniswap',
        [
          'UniswapClmmOpenPositionRequest',
          'UniswapClmmAddLiquidityRequest',
          'UniswapClmmRemoveLiquidityRequest',
          'UniswapClmmClosePositionRequest',
          'UniswapClmmCollectFeesRequest',
          'UniswapClmmExecuteSwapRequest',
        ],
      ],
      [
        'pancakeswap',
        [
          'PancakeswapClmmOpenPositionRequest',
          'PancakeswapClmmAddLiquidityRequest',
          'PancakeswapClmmRemoveLiquidityRequest',
          'PancakeswapClmmClosePositionRequest',
          'PancakeswapClmmCollectFeesRequest',
          'PancakeswapClmmExecuteSwapRequest',
        ],
      ],
      [
        'raydium',
        [
          'RaydiumClmmOpenPositionRequest',
          'RaydiumClmmAddLiquidityRequest',
          'RaydiumClmmRemoveLiquidityRequest',
          'RaydiumClmmClosePositionRequest',
          'RaydiumClmmExecuteSwapRequest',
        ],
      ],
      [
        'meteora',
        [
          'MeteoraClmmOpenPositionRequest',
          'MeteoraClmmAddLiquidityRequest',
          'MeteoraClmmRemoveLiquidityRequest',
          'MeteoraClmmClosePositionRequest',
          'MeteoraClmmCollectFeesRequest',
          'MeteoraClmmExecuteSwapRequest',
        ],
      ],
      [
        'orca',
        [
          'OrcaClmmOpenPositionRequest',
          'OrcaClmmAddLiquidityRequest',
          'OrcaClmmRemoveLiquidityRequest',
          'OrcaClmmClosePositionRequest',
          'OrcaClmmCollectFeesRequest',
          'OrcaClmmExecuteSwapRequest',
        ],
      ],
      [
        'pancakeswap-sol',
        [
          'PancakeswapSolClmmOpenPositionRequest',
          'PancakeswapSolClmmAddLiquidityRequest',
          'PancakeswapSolClmmRemoveLiquidityRequest',
          'PancakeswapSolClmmClosePositionRequest',
          'PancakeswapSolClmmCollectFeesRequest',
          'PancakeswapSolClmmExecuteSwapRequest',
        ],
      ],
    ] as const) {
      const source = readFileSync(path.join(ROOT, `src/connectors/${connector}/schemas.ts`), 'utf8');
      for (const schemaName of schemaNames) {
        const start = source.indexOf(`export const ${schemaName}`);
        const nextExport = source.indexOf('\nexport ', start + 1);
        const schema = source.slice(start, nextExport === -1 ? undefined : nextExport);
        expect(schema).toContain('liveActionAuthorization');
      }
    }

    for (const [connector, schemaNames] of [
      [
        'raydium',
        [
          'RaydiumAmmGetPositionInfoRequest',
          'RaydiumAmmQuoteSwapRequest',
          'RaydiumAmmQuoteLiquidityRequest',
          'RaydiumClmmGetPositionInfoRequest',
          'RaydiumClmmQuoteSwapRequest',
          'RaydiumClmmQuotePositionRequest',
        ],
      ],
      [
        'meteora',
        [
          'MeteoraQuoteSwapRequest',
          'MeteoraClmmQuoteSwapRequest',
          'MeteoraClmmGetPoolInfoRequest',
          'MeteoraClmmGetPositionInfoRequest',
          'MeteoraClmmGetPositionsOwnedRequest',
          'MeteoraClmmQuotePositionRequest',
        ],
      ],
      [
        'orca',
        [
          'OrcaQuoteSwapRequest',
          'OrcaClmmQuoteSwapRequest',
          'OrcaClmmGetPoolInfoRequest',
          'OrcaClmmGetPositionInfoRequest',
          'OrcaClmmGetPositionsOwnedRequest',
          'OrcaClmmQuotePositionRequest',
        ],
      ],
      [
        'pancakeswap-sol',
        [
          'PancakeswapSolClmmGetPoolInfoRequest',
          'PancakeswapSolClmmGetPositionInfoRequest',
          'PancakeswapSolClmmGetPositionsOwnedRequest',
          'PancakeswapSolClmmQuoteSwapRequest',
          'PancakeswapSolClmmQuotePositionRequest',
        ],
      ],
    ] as const) {
      const source = readFileSync(path.join(ROOT, `src/connectors/${connector}/schemas.ts`), 'utf8');
      for (const schemaName of schemaNames) {
        const start = source.indexOf(`export const ${schemaName}`);
        const nextExport = source.indexOf('\nexport ', start + 1);
        const schema = source.slice(start, nextExport === -1 ? undefined : nextExport);
        expect(schema).not.toContain('liveActionAuthorization');
      }
    }

    for (const file of ['open.ts', 'add.ts', 'remove.ts', 'collect-fees.ts', 'close.ts']) {
      const source = readFileSync(path.join(ROOT, `src/trading/trading-clmm-routes/${file}`), 'utf8');
      expect(source).toContain('liveActionAuthorization');
    }

    for (const connector of ['uniswap', 'pancakeswap']) {
      for (const file of [
        'openPosition.ts',
        'addLiquidity.ts',
        'removeLiquidity.ts',
        'collectFees.ts',
        'closePosition.ts',
      ]) {
        const source = readFileSync(path.join(ROOT, `src/connectors/${connector}/clmm-routes/${file}`), 'utf8');
        expect(source).toContain('liveActionAuthorization');
        expect(source).toMatch(/prepareGasOptions\([\s\S]*liveActionAuthorization/);
      }
    }

    for (const [connector, files] of [
      ['raydium', ['openPosition.ts', 'addLiquidity.ts', 'removeLiquidity.ts', 'collectFees.ts', 'closePosition.ts']],
      ['meteora', ['openPosition.ts', 'addLiquidity.ts', 'removeLiquidity.ts', 'collectFees.ts', 'closePosition.ts']],
      ['orca', ['openPosition.ts', 'addLiquidity.ts', 'removeLiquidity.ts', 'collectFees.ts', 'closePosition.ts']],
      [
        'pancakeswap-sol',
        ['openPosition.ts', 'addLiquidity.ts', 'removeLiquidity.ts', 'collectFees.ts', 'closePosition.ts'],
      ],
    ] as const) {
      for (const file of files) {
        const source = readFileSync(path.join(ROOT, `src/connectors/${connector}/clmm-routes/${file}`), 'utf8');
        expect(source).toContain('liveActionAuthorization');
        if (
          (connector === 'raydium' && file === 'collectFees.ts') ||
          (connector === 'pancakeswap-sol' && file === 'collectFees.ts')
        ) {
          expect(source).toMatch(/removeLiquidity\([\s\S]*liveActionAuthorization/);
        } else {
          expect(source).toMatch(/sendAndConfirm(?:Raw)?Transaction\([\s\S]*liveActionAuthorization/);
        }
      }
    }
  });
});
