import { utils } from 'ethers';
import Fastify from 'fastify';

jest.mock('../../src/chains/ethereum/ethereum', () => ({
  Ethereum: {
    getInstance: jest.fn(),
  },
}));

import {
  rebalanceRoutes,
  buildCctpBaseArbitrumUsdcTransfer,
  buildHyperliquidBridge2Transfer,
} from '../../src/bridge/rebalance.routes';
import { Ethereum } from '../../src/chains/ethereum/ethereum';
import { assertMainnetMutationAllowed } from '../../src/services/runtime-guard';

const WALLET = '0x00000000000000000000000000000000000000aa';
const TOKEN = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const BRIDGE2 = '0x2df1c51e09aecf9cacb7bc98cb1742757f163df7';

describe('Hyperliquid Bridge2 treasury rebalance route', () => {
  const originalProfile = process.env.MARLIN_RUNTIME_PROFILE;
  const originalToken = process.env.MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN;

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalProfile === undefined) {
      delete process.env.MARLIN_RUNTIME_PROFILE;
    } else {
      process.env.MARLIN_RUNTIME_PROFILE = originalProfile;
    }
    if (originalToken === undefined) {
      delete process.env.MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN;
    } else {
      process.env.MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN = originalToken;
    }
  });

  it('builds the Bridge2 USDC transfer internally', async () => {
    mockEthereum();

    const result = await buildHyperliquidBridge2Transfer(baseRequest());
    const decoded = new utils.Interface([
      'function transfer(address to, uint256 amount) returns (bool)',
    ]).decodeFunctionData('transfer', result.txCalldata);

    expect(result.txTarget).toBe(TOKEN);
    expect(decoded[0]).toBe(utils.getAddress(BRIDGE2));
    expect(decoded[1].toString()).toBe('6000000');
  });

  it('rejects caller attempts to route credit to a different Hyperliquid address', async () => {
    mockEthereum();

    await expect(
      buildHyperliquidBridge2Transfer({
        ...baseRequest(),
        destinationAddress: '0x00000000000000000000000000000000000000bB',
      }),
    ).rejects.toThrow(/credits sender/);
  });

  it('rejects amounts below the Bridge2 minimum', async () => {
    mockEthereum();

    await expect(buildHyperliquidBridge2Transfer({ ...baseRequest(), amount: '4.999999' })).rejects.toThrow(
      /minimum deposit is 5 USDC/,
    );
  });

  it('allows scoped provider-treasury authorization without an env mutation gate', () => {
    process.env.MARLIN_RUNTIME_PROFILE = 'marlin';
    delete process.env.GATEWAY_LIVE_ETHEREUM_TRANSACTION_ENABLED;

    expect(() =>
      assertMainnetMutationAllowed({
        chain: 'ethereum',
        internalProviderIntentSource: 'hyperliquid_bridge2_rebalance',
        liveActionAuthorization: treasuryAuthorization('6'),
        network: 'arbitrum',
        operation: 'ethereum_transaction',
        expectedConnectorId: 'hyperliquid',
        expectedNotional: '6',
        expectedWalletAddress: WALLET,
      }),
    ).not.toThrow();
  });

  it('does not rebroadcast the same idempotency key', async () => {
    process.env.MARLIN_RUNTIME_PROFILE = 'marlin';
    process.env.MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN = 'gateway-token';
    const sendTransaction = jest.fn(async () => ({ hash: '0xabc' }));
    mockEthereum({
      getWallet: jest.fn(async () => ({ sendTransaction })),
      handleTransactionExecution: jest.fn(async () => ({ status: 1 })),
      prepareGasOptions: jest.fn(async () => ({ gasLimit: 120000 })),
    });
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    await app.ready();

    const body = { ...baseRequest(), liveActionAuthorization: treasuryAuthorization('6') };
    const first = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      payload: body,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      payload: body,
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('executes after build with the same idempotency key', async () => {
    process.env.MARLIN_RUNTIME_PROFILE = 'marlin';
    process.env.MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN = 'gateway-token';
    const sendTransaction = jest.fn(async () => ({ hash: '0xbuildexecute' }));
    mockEthereum({
      getWallet: jest.fn(async () => ({ sendTransaction })),
      handleTransactionExecution: jest.fn(async () => ({ status: 1 })),
      prepareGasOptions: jest.fn(async () => ({ gasLimit: 120000 })),
    });
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    await app.ready();

    const body = { ...baseRequest(), idempotencyKey: 'build-then-execute' };
    const build = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/build',
      payload: body,
    });
    const execute = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      payload: { ...body, liveActionAuthorization: treasuryAuthorization('6') },
    });

    expect(build.statusCode).toBe(200);
    expect(execute.statusCode).toBe(200);
    expect(execute.json().signature).toBe('0xbuildexecute');
    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('exposes build and status routes backed by the rebalance store', async () => {
    mockEthereum();
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    await app.ready();

    const build = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/build',
      payload: baseRequest(),
    });
    const status = await app.inject({
      method: 'GET',
      url: '/bridge/rebalance/rebalance-1',
    });

    expect(build.statusCode).toBe(200);
    expect(build.json().txTarget).toBe(TOKEN);
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ idempotencyKey: 'rebalance-1', status: 'built' });
  });

  it('rejects scoped provider-treasury authorization without the Gateway provider token', async () => {
    process.env.MARLIN_RUNTIME_PROFILE = 'marlin';
    delete process.env.MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN;
    const sendTransaction = jest.fn(async () => ({ hash: '0xdef' }));
    mockEthereum({
      getWallet: jest.fn(async () => ({ sendTransaction })),
      handleTransactionExecution: jest.fn(async () => ({ status: 1 })),
      prepareGasOptions: jest.fn(async () => ({ gasLimit: 120000 })),
    });
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/execute',
      payload: {
        ...baseRequest(),
        idempotencyKey: 'rebalance-no-token',
        liveActionAuthorization: treasuryAuthorization('6'),
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toContain('provider treasury authorization required');
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('rejects caller-supplied raw transaction payload fields', async () => {
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/execute',
      payload: {
        ...baseRequest(),
        liveActionAuthorization: treasuryAuthorization('6'),
        txCalldata: '0x1234',
        txTarget: BRIDGE2,
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects caller-supplied gas limit', async () => {
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/build',
      payload: {
        ...baseRequest(),
        gasLimit: 1,
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('builds the CCTP Base to Arbitrum USDC transfer internally', async () => {
    const result = await buildCctpBaseArbitrumUsdcTransfer(cctpRequest());

    expect(result.provider).toBe('cctp_base_arbitrum_usdc');
    expect(result.sourceNetwork).toBe('base');
    expect(result.destinationNetwork).toBe('arbitrum');
    expect(result.approvalTxTarget).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(result.txTarget).toBe('0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d');
    expect(result.approvalTxCalldata).toMatch(/^0x/);
    expect(result.txCalldata).toMatch(/^0x/);
  });

  it('rejects CCTP Base to Arbitrum transfer to a different EVM address', async () => {
    await expect(
      buildCctpBaseArbitrumUsdcTransfer({
        ...cctpRequest(),
        destinationAddress: '0x00000000000000000000000000000000000000bb',
      }),
    ).rejects.toThrow(/same mnemonic-derived EVM address/);
  });

  it('executes CCTP Base to Arbitrum with provider-owned approve and burn transactions', async () => {
    process.env.MARLIN_RUNTIME_PROFILE = 'marlin';
    process.env.MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN = 'gateway-token';
    const sendTransaction = jest
      .fn()
      .mockResolvedValueOnce({ hash: '0xapprove' })
      .mockResolvedValueOnce({ hash: '0xburn' });
    mockEthereum({
      getWallet: jest.fn(async () => ({ sendTransaction })),
      handleTransactionExecution: jest.fn(async () => ({ status: 1 })),
      prepareGasOptions: jest.fn(async () => ({ gasLimit: 120000 })),
    });
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      payload: { ...cctpRequest(), liveActionAuthorization: cctpAuthorization('1.5') },
    });
    const status = await app.inject({
      method: 'GET',
      url: '/bridge/rebalance/cctp-rebalance-1',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().signature).toBe('0xburn');
    expect(sendTransaction).toHaveBeenCalledTimes(2);
    expect(status.json()).toMatchObject({
      approvalTransactionHash: '0xapprove',
      idempotencyKey: 'cctp-rebalance-1',
      status: 'burn_confirmed',
      transactionHash: '0xburn',
    });
  });
});

function baseRequest() {
  return {
    amount: '6',
    destinationAddress: WALLET,
    destinationAsset: 'USDC' as const,
    destinationVenue: 'hyperliquid' as const,
    idempotencyKey: 'rebalance-1',
    mode: 'mainnet' as const,
    provider: 'hyperliquid_bridge2' as const,
    sourceAsset: 'USDC' as const,
    sourceChain: 'ethereum' as const,
    sourceNetwork: 'arbitrum' as const,
    walletAddress: WALLET,
  };
}

function treasuryAuthorization(notional: string) {
  return {
    action: 'gateway_rebalance',
    connector_id: 'hyperliquid',
    network: 'arbitrum',
    notional,
    scope: 'provider_treasury',
    source: 'marlin',
    wallet_address: WALLET,
  };
}

function cctpRequest() {
  return {
    amount: '1.5',
    destinationAddress: WALLET,
    destinationAsset: 'USDC' as const,
    destinationNetwork: 'arbitrum' as const,
    idempotencyKey: 'cctp-rebalance-1',
    mode: 'mainnet' as const,
    provider: 'cctp_base_arbitrum_usdc' as const,
    sourceAsset: 'USDC' as const,
    sourceChain: 'ethereum' as const,
    sourceNetwork: 'base' as const,
    walletAddress: WALLET,
  };
}

function cctpAuthorization(notional: string) {
  return {
    action: 'gateway_rebalance',
    connector_id: 'treasury',
    network: 'base',
    notional,
    scope: 'provider_treasury',
    source: 'marlin',
    wallet_address: WALLET,
  };
}

function mockEthereum(overrides: Record<string, unknown> = {}) {
  const ethereum = {
    getToken: jest.fn(async () => ({
      address: TOKEN,
      chainId: 42161,
      decimals: 6,
      name: 'USD Coin',
      symbol: 'USDC',
    })),
    getWallet: jest.fn(),
    handleTransactionExecution: jest.fn(),
    prepareGasOptions: jest.fn(),
    ...overrides,
  };
  (Ethereum.getInstance as jest.Mock).mockResolvedValue(ethereum as unknown as Ethereum);
  return ethereum;
}
