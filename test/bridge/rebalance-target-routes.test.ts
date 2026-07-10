import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

import { BigNumber, utils } from 'ethers';
import Fastify from 'fastify';

jest.mock('../../src/chains/ethereum/ethereum', () => ({
  Ethereum: {
    getInstance: jest.fn(),
  },
}));
jest.mock('../../src/chains/solana/solana', () => ({
  Solana: {
    getInstance: jest.fn(),
  },
}));
jest.mock('../../src/wallet/routes/setMarlinDefault', () => ({
  deriveMarlinDefaultWalletMaterial: jest.fn((_mnemonic: string, policy: { walletRef: string }) => ({
    address: CANONICAL_WALLETS[policy.walletRef],
    privateKey: 'not-used',
    storageChain: policy.walletRef.startsWith('solana:') ? 'solana' : 'ethereum',
  })),
  marlinWalletPolicyFor: jest.fn((chain: string, network: string) => ({
    derivationPath: 'not-used',
    family: chain === 'solana' ? 'solana' : 'evm',
    storageChain: chain === 'solana' ? 'solana' : 'ethereum',
    walletRef:
      chain === 'solana'
        ? 'solana:mainnet-beta:solana_gateway'
        : `${network === 'mainnet' ? 'mainnet' : network}:mainnet:evm_gateway`,
  })),
}));

import { rebalanceRoutes } from '../../src/bridge/rebalance.routes';
import { Ethereum } from '../../src/chains/ethereum/ethereum';

const ARBITRUM_WALLET = '0x00000000000000000000000000000000000000A1';
const BASE_WALLET = '0x00000000000000000000000000000000000000B1';
const MAINNET_WALLET = '0x00000000000000000000000000000000000000C1';
const OPTIMISM_WALLET = '0x00000000000000000000000000000000000000D1';
const POLYGON_WALLET = '0x00000000000000000000000000000000000000E1';
const AVALANCHE_WALLET = '0x00000000000000000000000000000000000000F1';
const SOLANA_WALLET = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const ARBITRUM_USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const SOLANA_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BRIDGE2 = '0x2df1c51e09aecf9cacb7bc98cb1742757f163df7';

const CANONICAL_WALLETS: Record<string, string> = {
  'arbitrum:mainnet:evm_gateway': ARBITRUM_WALLET,
  'avalanche:mainnet:evm_gateway': AVALANCHE_WALLET,
  'base:mainnet:evm_gateway': BASE_WALLET,
  'mainnet:mainnet:evm_gateway': MAINNET_WALLET,
  'optimism:mainnet:evm_gateway': OPTIMISM_WALLET,
  'polygon:mainnet:evm_gateway': POLYGON_WALLET,
  'solana:mainnet-beta:solana_gateway': SOLANA_WALLET,
};

describe('provider-owned target funding routes', () => {
  let stateRoot: string;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    stateRoot = mkdtempSync(path.join(os.tmpdir(), 'gateway-target-rebalance-'));
    process.env.MARLIN_REBALANCE_STATE_ROOT = stateRoot;
    process.env.MARLIN_MNEMONIC = 'test mnemonic used only through the mocked derivation helper';
    process.env.MARLIN_RUNTIME_PROFILE = 'marlin';
    process.env.MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN = 'gateway-token';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.MARLIN_REBALANCE_STATE_ROOT;
    delete process.env.MARLIN_MNEMONIC;
    delete process.env.MARLIN_RUNTIME_PROFILE;
    delete process.env.MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN;
    rmSync(stateRoot, { force: true, recursive: true });
  });

  it('builds Hyperliquid funding from fresh canonical Arbitrum USDC and persists the immutable selection', async () => {
    const ethereum = mockEthereumContexts({ arbitrum: { gas: '1000000000000000', usdc: '6000000' } });
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });

    const response = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets',
      payload: targetRequest({
        destinationAddress: ARBITRUM_WALLET,
        destinationChain: 'hyperliquid',
        destinationNetwork: 'mainnet',
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      destinationAddress: utils.getAddress(ARBITRUM_WALLET),
      destinationAsset: 'USDC',
      destinationVenue: 'hyperliquid',
      idempotencyKey: 'target-funding-1',
      provider: 'hyperliquid_bridge2',
      sourceAsset: 'USDC',
      sourceNetwork: 'arbitrum',
      txTarget: ARBITRUM_USDC,
      walletAddress: utils.getAddress(ARBITRUM_WALLET),
    });
    expect(ethereum.arbitrum.getNativeBalanceByAddress).toHaveBeenCalledWith(utils.getAddress(ARBITRUM_WALLET));
    expect(ethereum.arbitrum.getERC20BalanceByAddress).toHaveBeenCalled();
    const persisted = JSON.parse(readFileSync(path.join(stateRoot, 'target-funding-1.json'), 'utf8'));
    expect(persisted).toMatchObject({
      provider: 'hyperliquid_bridge2',
      sourceNetwork: 'arbitrum',
      status: 'built',
      walletAddress: utils.getAddress(ARBITRUM_WALLET),
      builtRebalance: {
        provider: 'hyperliquid_bridge2',
        sourceNetwork: 'arbitrum',
        walletAddress: utils.getAddress(ARBITRUM_WALLET),
      },
    });
    const transfer = new utils.Interface(['function transfer(address to, uint256 amount) returns (bool)']);
    const decodedTransfer = transfer.decodeFunctionData('transfer', persisted.builtRebalance.txCalldata);
    expect(decodedTransfer[0]).toBe(utils.getAddress(BRIDGE2));
  });

  it.each([
    {
      destinationAddress: BASE_WALLET,
      destinationAsset: BASE_USDC,
      destinationChain: 'ethereum',
      destinationNetwork: 'base',
      squidDestinationChain: '8453',
    },
    {
      destinationAddress: SOLANA_WALLET,
      destinationAsset: SOLANA_USDC,
      destinationChain: 'solana',
      destinationNetwork: 'mainnet-beta',
      squidDestinationChain: 'solana',
    },
  ])(
    'uses Squid for canonical $destinationChain/$destinationNetwork funding',
    async ({ destinationAddress, destinationAsset, destinationChain, destinationNetwork, squidDestinationChain }) => {
      mockEthereumContexts({ arbitrum: { gas: '1000000000000000', usdc: '9000000' } });
      const fetchMock = mockSquidRoute();
      const app = Fastify();
      await app.register(rebalanceRoutes, { prefix: '/bridge' });

      const response = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets',
        payload: targetRequest({ destinationAddress, destinationChain, destinationNetwork }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        destinationAddress,
        destinationAsset: 'USDC',
        destinationChain,
        destinationNetwork,
        provider: 'squid_router',
        sourceNetwork: 'arbitrum',
        walletAddress: utils.getAddress(ARBITRUM_WALLET),
      });
      const squidPayload = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(squidPayload).toMatchObject({
        fromAddress: utils.getAddress(ARBITRUM_WALLET),
        fromAmount: '6060000',
        fromChain: '42161',
        fromToken: ARBITRUM_USDC,
        toAddress: destinationAddress,
        toChain: squidDestinationChain,
        toToken: destinationAsset,
      });
    },
  );

  it('falls through to a later funded canonical EVM treasury context', async () => {
    mockEthereumContexts({
      arbitrum: { gas: '1000000000000000', usdc: '0' },
      base: { gas: '1000000000000000', usdc: '9000000' },
    });
    const fetchMock = mockSquidRoute();
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });

    const response = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets',
      payload: targetRequest({
        destinationAddress: SOLANA_WALLET,
        destinationChain: 'solana',
        destinationNetwork: 'mainnet-beta',
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      provider: 'squid_router',
      sourceNetwork: 'base',
      walletAddress: utils.getAddress(BASE_WALLET),
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      fromAddress: utils.getAddress(BASE_WALLET),
      fromChain: '8453',
      fromToken: BASE_USDC,
    });
  });

  it('returns the exact neutral blocker before quote or send when no canonical source has asset and gas', async () => {
    const ethereum = mockEthereumContexts({ arbitrum: { gas: '0', usdc: '6000000' } });
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });

    const response = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets',
      payload: targetRequest({
        destinationAddress: ARBITRUM_WALLET,
        destinationChain: 'hyperliquid',
        destinationNetwork: 'mainnet',
      }),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().message).toBe('insufficient_source_or_gas');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ethereum.arbitrum.getWallet).not.toHaveBeenCalled();
  });

  it('does not report verified insufficiency when fresh balance evidence is unavailable', async () => {
    const ethereum = mockEthereumContexts({ arbitrum: { gas: '1000000000000000', usdc: '6000000' } });
    ethereum.arbitrum.getERC20BalanceByAddress.mockRejectedValue(new Error('RPC unavailable'));
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });

    const response = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets',
      payload: targetRequest({
        destinationAddress: ARBITRUM_WALLET,
        destinationChain: 'hyperliquid',
        destinationNetwork: 'mainnet',
      }),
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toContain('target funding source balance unavailable');
    expect(response.body).not.toContain('insufficient_source_or_gas');
    expect(ethereum.arbitrum.getWallet).not.toHaveBeenCalled();
  });

  it('rechecks the persisted source and blocks execute before any side effect when gas disappears', async () => {
    const sendTransaction = jest.fn();
    const ethereum = mockEthereumContexts(
      { arbitrum: { gas: '1000000000000000', usdc: '6000000' } },
      { getWallet: jest.fn(async () => ({ sendTransaction })) },
    );
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets',
      payload: targetRequest({
        destinationAddress: ARBITRUM_WALLET,
        destinationChain: 'hyperliquid',
        destinationNetwork: 'mainnet',
      }),
    });
    ethereum.arbitrum.getNativeBalanceByAddress.mockResolvedValue({ decimals: 18, value: BigNumber.from(0) });

    const response = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets/target-funding-1/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().message).toBe('insufficient_source_or_gas');
    expect(ethereum.arbitrum.getWallet).not.toHaveBeenCalled();
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('rejects a modified persisted provider selection before any side effect', async () => {
    const sendTransaction = jest.fn();
    const ethereum = mockEthereumContexts(
      { arbitrum: { gas: '1000000000000000', usdc: '6000000' } },
      { getWallet: jest.fn(async () => ({ sendTransaction })) },
    );
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets',
      payload: targetRequest({
        destinationAddress: ARBITRUM_WALLET,
        destinationChain: 'hyperliquid',
        destinationNetwork: 'mainnet',
      }),
    });
    const statePath = path.join(stateRoot, 'target-funding-1.json');
    const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
    persisted.builtRebalance.txTarget = '0x00000000000000000000000000000000000000FF';
    writeFileSync(statePath, JSON.stringify(persisted));

    const response = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets/target-funding-1/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toContain('persisted target funding selection fingerprint mismatch');
    expect(ethereum.arbitrum.getWallet).not.toHaveBeenCalled();
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('executes the persisted selection by id across app restart and does not rebuild or rebroadcast', async () => {
    const sendTransaction = jest
      .fn()
      .mockResolvedValueOnce({ hash: '0xapproval' })
      .mockResolvedValueOnce({ hash: '0xbridge' });
    mockEthereumContexts(
      { arbitrum: { gas: '1000000000000000', usdc: '9000000' } },
      {
        getWallet: jest.fn(async () => ({ sendTransaction })),
        handleTransactionExecution: jest.fn(async () => ({ status: 1 })),
        prepareGasOptions: jest.fn(async () => ({ gasLimit: 90000, maxFeePerGas: BigNumber.from(10) })),
      },
    );
    const fetchMock = mockSquidRoute();
    const firstApp = Fastify();
    await firstApp.register(rebalanceRoutes, { prefix: '/bridge' });
    const build = await firstApp.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets',
      payload: targetRequest({
        destinationAddress: SOLANA_WALLET,
        destinationChain: 'solana',
        destinationNetwork: 'mainnet-beta',
      }),
    });
    await firstApp.close();

    const secondApp = Fastify();
    await secondApp.register(rebalanceRoutes, { prefix: '/bridge' });
    const firstExecute = await secondApp.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets/target-funding-1/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
    });
    const retry = await secondApp.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets/target-funding-1/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
    });
    const status = await secondApp.inject({ method: 'GET', url: '/bridge/rebalance/target-funding-1' });

    expect(build.statusCode).toBe(200);
    expect(firstExecute.json()).toMatchObject({ signature: '0xbridge', status: 1 });
    expect(retry.json()).toMatchObject({ signature: '0xbridge', status: 1 });
    expect(status.json()).toMatchObject({
      idempotencyKey: 'target-funding-1',
      provider: 'squid_router',
      sourceNetwork: 'arbitrum',
      status: 'confirmed',
      transactionHash: '0xbridge',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sendTransaction).toHaveBeenCalledTimes(2);
  });

  it('rejects caller-supplied provider, source, and wallet authority fields', async () => {
    mockEthereumContexts({ arbitrum: { gas: '1000000000000000', usdc: '6000000' } });
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });

    const response = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets',
      payload: { ...targetRequest(), provider: 'squid_router', sourceNetwork: 'base', walletAddress: BASE_WALLET },
    });

    expect(response.statusCode).toBe(400);
  });
});

function targetRequest(overrides: Record<string, unknown> = {}) {
  return {
    amount: '6',
    destinationAddress: BASE_WALLET,
    destinationAsset: 'USDC',
    destinationChain: 'ethereum',
    destinationNetwork: 'base',
    idempotencyKey: 'target-funding-1',
    maxCostBps: 100,
    mode: 'mainnet',
    ...overrides,
  };
}

function mockEthereumContexts(
  balances: Record<string, { gas: string; usdc: string }>,
  overrides: Record<string, unknown> = {},
) {
  const contexts: Record<string, any> = {};
  for (const network of ['arbitrum', 'base', 'mainnet', 'optimism', 'polygon', 'avalanche']) {
    const balance = balances[network] ?? { gas: '0', usdc: '0' };
    contexts[network] = {
      getContract: jest.fn((address: string) => ({ address })),
      getERC20BalanceByAddress: jest.fn(async () => ({ decimals: 6, value: BigNumber.from(balance.usdc) })),
      getNativeBalanceByAddress: jest.fn(async () => ({ decimals: 18, value: BigNumber.from(balance.gas) })),
      getWallet: jest.fn(),
      handleTransactionExecution: jest.fn(),
      prepareGasOptions: jest.fn(),
      provider: { getGasPrice: jest.fn(async () => BigNumber.from('1000000000')) },
      ...overrides,
    };
  }
  (Ethereum.getInstance as jest.Mock).mockImplementation(async (network: string) => contexts[network]);
  return contexts;
}

function mockSquidRoute() {
  const fetchMock = jest.fn(async (_url: unknown, _options: Record<string, any>) => ({
    headers: { get: () => 'squid-request-1' },
    json: async () => ({
      route: {
        estimate: { toAmount: '6000000' },
        id: 'squid-route-1',
        quoteId: 'squid-quote-1',
        requestId: 'squid-request-1',
        transactionRequest: {
          data: '0x1234',
          target: '0x00000000000000000000000000000000000000F0',
          value: '0',
        },
      },
    }),
    ok: true,
    status: 200,
  }));
  global.fetch = fetchMock as any;
  return fetchMock;
}
