import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

import { BigNumber, Wallet, utils } from 'ethers';
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
jest.mock('../../src/connectors/uniswap/uniswap', () => ({
  Uniswap: {
    getInstance: jest.fn(),
  },
}));
jest.mock('../../src/wallet/routes/setMarlinDefault', () => {
  return {
    deriveMarlinDefaultWalletMaterial: jest.fn((mnemonic: string, policy: { walletRef: string }) => {
      if (mnemonic.startsWith('"') || mnemonic.startsWith("'")) {
        throw new Error('invalid mnemonic');
      }
      return {
        address: CANONICAL_WALLETS[policy.walletRef],
        privateKey: 'not-used',
        storageChain: policy.walletRef.startsWith('solana:') ? 'solana' : 'ethereum',
      };
    }),
    normalizedMnemonicFromEnv: jest.fn(() => 'normalized test mnemonic'),
    ensureMarlinWalletExists: jest.fn(async ({ address }: { address: string }) => ({
      storageChain: 'ethereum',
      validatedAddress: address,
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
  };
});

jest.mock('../../src/bridge/providers/mayan', () => ({
  buildMayanSwap: jest.fn(async (params: { sourceAddress: string; destinationAddress: string; amount: string }) => {
    const { utils } = require('ethers');
    if (params.amount !== '0.0005') {
      throw new Error(`mayan amount must be 0.0005, got ${params.amount}`);
    }
    if (!params.sourceAddress.startsWith('0x')) {
      throw new Error('mayan source address must be EVM');
    }
    return {
      provider: 'mayan',
      quoteId: 'mayan-quote-1',
      sourceChain: 'ethereum',
      sourceNetwork: 'arbitrum',
      sourceAsset: 'ETH',
      destinationChain: 'solana',
      destinationNetwork: 'mainnet-beta',
      destinationAsset: 'SOL',
      sourceAddress: params.sourceAddress,
      destinationAddress: params.destinationAddress,
      sourceAmount: '0.0005',
      destinationAmount: '50000000',
      minAmountOut: '49000000',
      deadline: 9999999999999,
      type: 'FAST_MCTP',
      txTarget: '0x337685fdaB40D39bd02028545a4FfA7D287cC3E2',
      txCalldata: '0xabcdef',
      txValue: '500000000000000',
      gasLimit: 500000,
      routePayload: '{"quoteId":"mayan-quote-1"}',
      routePayloadHash: '0x' + 'ab'.repeat(32),
    };
  }),
  getMayanStatus: jest.fn(async (_sourceTxHash: string) => {
    return { status: 'confirmed', providerStatus: 'settled' };
  }),
}));

import { rebalanceRoutes } from '../../src/bridge/rebalance.routes';
import { Ethereum } from '../../src/chains/ethereum/ethereum';
import { Uniswap } from '../../src/connectors/uniswap/uniswap';
import { deriveMarlinDefaultWalletMaterial, ensureMarlinWalletExists } from '../../src/wallet/routes/setMarlinDefault';

const ARBITRUM_WALLET = '0x00000000000000000000000000000000000000A1';
const BASE_WALLET = '0x00000000000000000000000000000000000000B1';
const MAINNET_WALLET = '0x00000000000000000000000000000000000000C1';
const OPTIMISM_WALLET = '0x00000000000000000000000000000000000000D1';
const POLYGON_WALLET = '0x00000000000000000000000000000000000000E1';
const AVALANCHE_WALLET = '0x00000000000000000000000000000000000000F1';
const SOLANA_WALLET = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const ARBITRUM_USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_WETH = '0x4200000000000000000000000000000000000006';
const SOLANA_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BRIDGE2 = '0x2df1c51e09aecf9cacb7bc98cb1742757f163df7';
const ARBITRUM_WETH = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
const UNISWAP_SWAP_ROUTER_02 = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';

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
    (deriveMarlinDefaultWalletMaterial as jest.Mock).mockImplementation(
      (_mnemonic: string, policy: { walletRef: string }) => ({
        address: CANONICAL_WALLETS[policy.walletRef],
        privateKey: 'not-used',
        storageChain: policy.walletRef.startsWith('solana:') ? 'solana' : 'ethereum',
      }),
    );
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
    const ethereum = mockEthereumContexts({ arbitrum: { gas: '3000000000000000', usdc: '6000000' } });
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
      destinationAmount: '6.0',
      destinationAsset: 'USDC',
      destinationVenue: 'hyperliquid',
      idempotencyKey: 'target-funding-1',
      provider: 'hyperliquid_bridge2',
      sourceAmount: '6.0',
      sourceAsset: 'USDC',
      sourceNetwork: 'arbitrum',
      txTarget: ARBITRUM_USDC,
      walletAddress: utils.getAddress(ARBITRUM_WALLET),
    });
    const body = response.json();
    expect(body.quotedNativeGasAmount).toMatch(/^\d+\.?\d*$/);
    expect(body.quotedNativeGasAsset).toBe('ETH');
    expect(body.quotedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    const expectedGasWei = BigNumber.from('1000000000').mul(120000).mul(12).div(10);
    expect(utils.parseEther(body.quotedNativeGasAmount).eq(expectedGasWei)).toBe(true);
    expect(ethereum.arbitrum.getNativeBalanceByAddress).toHaveBeenCalledWith(utils.getAddress(ARBITRUM_WALLET));
    expect(ethereum.arbitrum.getERC20BalanceByAddress).toHaveBeenCalled();
    const persisted = JSON.parse(readFileSync(path.join(stateRoot, 'target-funding-1.json'), 'utf8'));
    expect(persisted).toMatchObject({
      destinationAmount: '6.0',
      provider: 'hyperliquid_bridge2',
      sourceAmount: '6.0',
      sourceNetwork: 'arbitrum',
      status: 'built',
      walletAddress: utils.getAddress(ARBITRUM_WALLET),
      builtRebalance: {
        destinationAmount: '6.0',
        provider: 'hyperliquid_bridge2',
        sourceAmount: '6.0',
        sourceNetwork: 'arbitrum',
        walletAddress: utils.getAddress(ARBITRUM_WALLET),
      },
    });
    expect(persisted.quotedNativeGasAmount).toMatch(/^\d+\.?\d*$/);
    expect(persisted.quotedNativeGasAsset).toBe('ETH');
    expect(persisted.quotedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(persisted.builtRebalance.quotedNativeGasAmount).toMatch(/^\d+\.?\d*$/);
    expect(persisted.builtRebalance.quotedNativeGasAsset).toBe('ETH');
    expect(persisted.builtRebalance.quotedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    const transfer = new utils.Interface(['function transfer(address to, uint256 amount) returns (bool)']);
    const decodedTransfer = transfer.decodeFunctionData('transfer', persisted.builtRebalance.txCalldata);
    expect(decodedTransfer[0]).toBe(utils.getAddress(BRIDGE2));
  });

  it('builds target funding when MARLIN_MNEMONIC is wrapped in matching quotes', async () => {
    process.env.MARLIN_MNEMONIC =
      '"abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"';
    mockEthereumContexts({ arbitrum: { gas: '3000000000000000', usdc: '6000000' } });
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
    await app.close();
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
      mockEthereumContexts({
        arbitrum: { gas: '3000000000000000', usdc: '9000000' },
        base: { gas: '3000000000000000', usdc: '9000000' },
      });
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
      const body = response.json();
      expect(body.sourceAmount).toBe('6.0');
      expect(body.destinationAmount).toBe('6.0');
      expect(body.quotedProviderCostUsd).toBe('3.5');
      expect(body.quotedGasCostUsd).toBe('2.1');
      expect(body.quotedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      const squidPayload = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(squidPayload).toMatchObject({
        fromAddress: utils.getAddress(ARBITRUM_WALLET),
        fromAmount: '6000000',
        fromChain: '42161',
        fromToken: ARBITRUM_USDC,
        toAddress: destinationAddress,
        toChain: squidDestinationChain,
        toToken: destinationAsset,
      });
    },
  );

  it('persists and executes the provider gasLimit returned by Squid', async () => {
    const signer = new Wallet(`0x${'33'.repeat(32)}`);
    const prepareGasOptions = jest.fn(async (_gasPrice: unknown, gasLimit: number) => ({
      gasLimit,
      gasPrice: BigNumber.from(10),
    }));
    const sendTransaction = jest.fn(async (serialized: string) => ({ hash: utils.keccak256(serialized) }));
    mockEthereumContexts(
      { arbitrum: { gas: '3000000000000000', usdc: '9000000' } },
      {
        chainId: 42161,
        getWallet: jest.fn(async () => signer),
        handleTransactionExecution: jest.fn(async () => ({ status: 1 })),
        prepareGasOptions,
        provider: {
          getGasPrice: jest.fn(async () => BigNumber.from('1000000000')),
          getTransactionCount: jest.fn(async () => 1),
          getTransactionReceipt: jest.fn(async () => ({ status: 1 })),
          sendTransaction,
        },
      },
    );
    mockSquidRoute('6000000', '994800');
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });

    const build = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets',
      payload: targetRequest(),
    });
    const persisted = JSON.parse(readFileSync(path.join(stateRoot, 'target-funding-1.json'), 'utf8'));

    expect(build.statusCode).toBe(200);
    expect(persisted.builtRebalance.gasLimit).toBe(994800);

    const execute = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets/target-funding-1/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
    });

    expect(execute.statusCode).toBe(200);
    expect(prepareGasOptions.mock.calls.map((call) => call[1])).toEqual([90000, 994800]);
    await app.close();
  });

  it('uses the conservative Squid maximum for source gas reserve before quote', async () => {
    mockEthereumContexts({ arbitrum: { gas: '2507999999999999', usdc: '9000000' } });
    const fetchMock = mockSquidRoute('6000000', '994800');
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });

    const response = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets',
      payload: targetRequest(),
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).toContain('insufficient_source_or_gas');
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ['missing', undefined],
    ['zero', '0'],
    ['fractional', '994800.5'],
    ['above the maximum', '2000001'],
    ['unsafe', '9007199254740992'],
    ['boolean', true],
    ['hexadecimal string', '0xf2df0'],
    ['exponent string', '9.948e5'],
  ])('fails closed when a newly built Squid route has %s gasLimit', async (_label, gasLimit) => {
    mockEthereumContexts({ arbitrum: { gas: '3000000000000000', usdc: '9000000' } });
    mockSquidRoute('6000000', gasLimit);
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });

    const response = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets',
      payload: targetRequest(),
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toContain('Squid transaction gasLimit invalid');
    expect(() => readFileSync(path.join(stateRoot, 'target-funding-1.json'))).toThrow();
    await app.close();
  });

  it('falls back to Arbitrum USDC for Base native ETH when same-network USDC is insufficient', async () => {
    mockEthereumContexts({
      arbitrum: { gas: '3000000000000000', usdc: '9000000' },
      base: { gas: '0', usdc: '0' },
    });
    const fetchMock = mockSquidRoute('56000000000000000');
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });

    const response = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets',
      payload: targetRequest({ destinationAsset: 'ETH' }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      destinationAsset: 'ETH',
      destinationChain: 'ethereum',
      destinationNetwork: 'base',
      provider: 'squid_router',
      sourceNetwork: 'arbitrum',
      walletAddress: utils.getAddress(ARBITRUM_WALLET),
    });
    const body = response.json();
    expect(body.sourceAmount).toBe('6.0');
    expect(body.destinationAmount).toBe('0.056');
    expect(body.quotedProviderCostUsd).toBe('3.5');
    expect(body.quotedGasCostUsd).toBe('2.1');
    expect(body.quotedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    const squidPayload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(squidPayload).toMatchObject({
      fromAddress: utils.getAddress(ARBITRUM_WALLET),
      fromAmount: '6000000',
      fromChain: '42161',
      fromToken: ARBITRUM_USDC,
      toAddress: BASE_WALLET,
      toChain: '8453',
      toToken: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
    });
  });

  it('falls back cross-chain without converting Arbitrum ETH when preferred USDC is insufficient', async () => {
    mockEthereumContexts({
      arbitrum: { gas: '20000000000000000', usdc: '0' },
      base: { gas: '3000000000000000', usdc: '9000000' },
    });
    (Uniswap.getInstance as jest.Mock).mockResolvedValue({
      quoteExactInputSingle: jest.fn(async () => utils.parseUnits('6', 6)),
      quoteExactOutputSingle: jest.fn(async () => utils.parseEther('0.005')),
    });
    const fetchMock = mockSquidRoute('56000000000000000');
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });

    const response = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets',
      payload: targetRequest({
        destinationAddress: ARBITRUM_WALLET,
        destinationAsset: 'ETH',
        destinationNetwork: 'arbitrum',
      }),
    });

    expect(response.json()).toMatchObject({ provider: 'squid_router', sourceNetwork: 'base' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ fromChain: '8453', toChain: '42161' });
    expect(Uniswap.getInstance).not.toHaveBeenCalled();
    await app.close();
  });

  it.each(['arbitrum', 'arbitrum-mainnet'])(
    'funds canonical Arbitrum native ETH from a same-network USDC source via Squid (%s)',
    async (destinationNetwork) => {
      mockEthereumContexts({
        arbitrum: { gas: '3000000000000000', usdc: '9000000' },
        base: { gas: '3000000000000000', usdc: '9000000' },
      });
      const fetchMock = mockSquidRoute('56000000000000000');
      const app = Fastify();
      await app.register(rebalanceRoutes, { prefix: '/bridge' });

      const response = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets',
        payload: targetRequest({
          destinationAddress: ARBITRUM_WALLET,
          destinationAsset: 'ETH',
          destinationChain: 'ethereum',
          destinationNetwork,
        }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        destinationAddress: utils.getAddress(ARBITRUM_WALLET),
        destinationAmount: '0.056',
        destinationAsset: 'ETH',
        destinationChain: 'ethereum',
        destinationNetwork: 'arbitrum',
        provider: 'squid_router',
        sourceAsset: ARBITRUM_USDC,
        sourceNetwork: 'arbitrum',
        walletAddress: utils.getAddress(ARBITRUM_WALLET),
      });
      const squidPayload = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(squidPayload).toMatchObject({
        fromAddress: utils.getAddress(ARBITRUM_WALLET),
        fromAmount: '6000000',
        fromChain: '42161',
        fromToken: ARBITRUM_USDC,
        toAddress: utils.getAddress(ARBITRUM_WALLET),
        toChain: '42161',
        toToken: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
      });
      expect(ensureMarlinWalletExists).toHaveBeenCalledWith({
        address: utils.getAddress(ARBITRUM_WALLET),
        chain: 'ethereum',
        network: 'arbitrum',
        walletRef: 'arbitrum:mainnet:evm_gateway',
      });
      expect(ensureMarlinWalletExists).not.toHaveBeenCalledWith(expect.objectContaining({ network: 'base' }));
      await app.close();
    },
  );

  it('confirms same-chain Squid from a successful receipt without destination status polling', async () => {
    const getTransactionReceipt = jest.fn().mockResolvedValue({ status: 1 });
    mockEthereumContexts(
      { arbitrum: { gas: '3000000000000000', usdc: '9000000' } },
      {
        chainId: 42161,
        provider: {
          getGasPrice: jest.fn(async () => BigNumber.from('1000000000')),
          getTransactionReceipt,
        },
      },
    );
    const fetchMock = mockSquidRouteAndStatus('ONGOING');
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });

    const build = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets',
      payload: targetRequest({
        destinationAddress: ARBITRUM_WALLET,
        destinationAsset: 'ETH',
        destinationChain: 'ethereum',
        destinationNetwork: 'arbitrum',
      }),
    });
    expect(build.statusCode).toBe(200);
    const statePath = path.join(stateRoot, 'target-funding-1.json');
    const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(persisted.squidSourceChainId).toBe(persisted.squidDestinationChainId);
    writeFileSync(
      statePath,
      JSON.stringify({ ...persisted, status: 'submitted', transactionHash: `0x${'11'.repeat(32)}` }),
    );

    const refreshed = await app.inject({ method: 'GET', url: '/bridge/rebalance/target-funding-1' });

    expect(refreshed.json().status).toBe('confirmed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getTransactionReceipt).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('does not confirm same-chain Squid from provider status without a successful main receipt', async () => {
    const getTransactionReceipt = jest.fn().mockResolvedValue(null);
    mockEthereumContexts(
      { base: { gas: '3000000000000000', usdc: '9000000' } },
      { provider: { getGasPrice: jest.fn(async () => BigNumber.from('1000000000')), getTransactionReceipt } },
    );
    const fetchMock = mockSquidRouteAndStatus('SUCCESS');
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets',
      payload: targetRequest({ destinationAsset: 'ETH' }),
    });
    const statePath = path.join(stateRoot, 'target-funding-1.json');
    const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
    writeFileSync(
      statePath,
      JSON.stringify({ ...persisted, status: 'submitted', transactionHash: `0x${'11'.repeat(32)}` }),
    );

    const refreshed = await app.inject({ method: 'GET', url: '/bridge/rebalance/target-funding-1' });

    expect(refreshed.json().status).toBe('submitted');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getTransactionReceipt).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('rejects an Arbitrum native ETH target that is not the canonical mnemonic-derived wallet', async () => {
    const ethereum = mockEthereumContexts({
      arbitrum: { gas: '3000000000000000', usdc: '9000000' },
      base: { gas: '3000000000000000', usdc: '9000000' },
    });
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });

    const response = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets',
      payload: targetRequest({
        destinationAddress: BASE_WALLET,
        destinationAsset: 'ETH',
        destinationChain: 'ethereum',
        destinationNetwork: 'arbitrum',
      }),
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toContain('destinationAddress does not match the canonical MARLIN_MNEMONIC wallet');
    expect(ensureMarlinWalletExists).not.toHaveBeenCalled();
    expect(Ethereum.getInstance).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ethereum.arbitrum.getWallet).not.toHaveBeenCalled();
    expect(() => readFileSync(path.join(stateRoot, 'target-funding-1.json'))).toThrow();
    await app.close();
  });

  it('rejects destination asset ETH for a non-Base network', async () => {
    const ethereum = mockEthereumContexts({ arbitrum: { gas: '3000000000000000', usdc: '9000000' } });
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });

    const response = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets',
      payload: targetRequest({
        destinationAsset: 'ETH',
        destinationChain: 'solana',
        destinationNetwork: 'mainnet-beta',
      }),
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toContain('unsupported target funding destination asset');
    expect(ensureMarlinWalletExists).not.toHaveBeenCalled();
    expect(Ethereum.getInstance).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ethereum.arbitrum.getWallet).not.toHaveBeenCalled();
    expect(() => readFileSync(path.join(stateRoot, 'target-funding-1.json'))).toThrow();
  });

  it('inverse-quotes realistic USDC input for a 0.01 Base WETH target', async () => {
    mockEthereumContexts({
      arbitrum: { gas: '3000000000000000', usdc: '100000000' },
      base: { gas: '3000000000000000', usdc: '100000000' },
    });
    const fetchMock = mockSquidWethRoute();
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });

    const response = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets',
      payload: targetRequest({ targetNotionalEur: '31', destinationAmount: '0.01', destinationAsset: 'WETH' }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      destinationAsset: 'WETH',
      destinationChain: 'ethereum',
      destinationNetwork: 'base',
      provider: 'squid_router',
      sourceNetwork: 'arbitrum',
    });
    const body = response.json();
    expect(body.quotedProviderCostUsd).toBe('3.5');
    expect(body.quotedGasCostUsd).toBe('2.1');
    expect(body.quotedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(body.destinationAmount).toMatch(/^\d+\.?\d*$/);
    expect(utils.parseUnits(body.destinationAmount, 18).gte(utils.parseUnits('0.01', 18))).toBe(true);
    const wethDecimals = body.destinationAmount.includes('.') ? body.destinationAmount.split('.')[1].length : 0;
    expect(wethDecimals).toBeLessThanOrEqual(18);
    const quotedInputs = fetchMock.mock.calls.map(([, options]) => BigNumber.from(JSON.parse(options.body).fromAmount));
    const selectedInput = quotedInputs[quotedInputs.length - 1];
    expect(selectedInput.gte('30000000')).toBe(true);
    expect(selectedInput.lte('30300000')).toBe(true);
    expect(selectedInput.eq('10000')).toBe(false);
    expect(JSON.parse(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1].body)).toMatchObject({
      fromToken: ARBITRUM_USDC,
      toChain: '8453',
      toToken: BASE_WETH,
    });
  });

  it('provisions the selected mnemonic source wallet before provider quote and persistence', async () => {
    mockEthereumContexts({ arbitrum: { gas: '3000000000000000', usdc: '9000000' } });
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;
    (ensureMarlinWalletExists as jest.Mock).mockRejectedValueOnce(new Error('wallet provisioning failed'));
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });

    const response = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets',
      payload: targetRequest(),
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toContain('wallet provisioning failed');
    expect(ensureMarlinWalletExists).toHaveBeenCalledWith({
      address: utils.getAddress(ARBITRUM_WALLET),
      chain: 'ethereum',
      network: 'arbitrum',
      walletRef: 'arbitrum:mainnet:evm_gateway',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(() => readFileSync(path.join(stateRoot, 'target-funding-1.json'))).toThrow();
  });

  it('rejects an unsupported spend asset before wallet, balance, quote, or persistence side effects', async () => {
    const ethereum = mockEthereumContexts({ arbitrum: { gas: '3000000000000000', usdc: '9000000' } });
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });

    const response = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets',
      payload: targetRequest({
        destinationAsset: 'WETH',
        destinationChain: 'solana',
        destinationNetwork: 'mainnet-beta',
      }),
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toContain('unsupported target funding destination asset');
    expect(ensureMarlinWalletExists).not.toHaveBeenCalled();
    expect(Ethereum.getInstance).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ethereum.arbitrum.getWallet).not.toHaveBeenCalled();
    expect(() => readFileSync(path.join(stateRoot, 'target-funding-1.json'))).toThrow();
  });

  it('falls through to a later funded canonical EVM treasury context', async () => {
    mockEthereumContexts({
      arbitrum: { gas: '3000000000000000', usdc: '0' },
      base: { gas: '3000000000000000', usdc: '9000000' },
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
    const body = response.json();
    expect(body.quotedProviderCostUsd).toBe('3.5');
    expect(body.quotedGasCostUsd).toBe('2.1');
    expect(body.quotedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    const persisted = JSON.parse(readFileSync(path.join(stateRoot, 'target-funding-1.json'), 'utf8'));
    expect(persisted.quotedProviderCostUsd).toBe('3.5');
    expect(persisted.quotedGasCostUsd).toBe('2.1');
    expect(persisted.quotedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
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
    const ethereum = mockEthereumContexts({ arbitrum: { gas: '3000000000000000', usdc: '6000000' } });
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

  it('reports verified insufficiency when another source balance is unavailable', async () => {
    const ethereum = mockEthereumContexts({ arbitrum: { gas: '0', usdc: '1000000' } });
    ethereum.mainnet.getERC20BalanceByAddress.mockRejectedValue(new Error('RPC unavailable'));
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });

    const response = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets',
      payload: targetRequest(),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().message).toBe('insufficient_source_or_gas');
  });

  it('rechecks the persisted source and blocks execute before any side effect when gas disappears', async () => {
    const sendTransaction = jest.fn();
    const ethereum = mockEthereumContexts(
      { arbitrum: { gas: '3000000000000000', usdc: '6000000' } },
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

  it('rejects persisted Bridge2 selection with tampered native gas bound via fingerprint mismatch', async () => {
    const ethereum = mockEthereumContexts(
      { arbitrum: { gas: '3000000000000000', usdc: '6000000' } },
      { getWallet: jest.fn() },
    );
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    const buildResponse = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets',
      payload: targetRequest({
        destinationAddress: ARBITRUM_WALLET,
        destinationChain: 'hyperliquid',
        destinationNetwork: 'mainnet',
      }),
    });
    expect(buildResponse.statusCode).toBe(200);
    const statePath = path.join(stateRoot, 'target-funding-1.json');
    const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
    // Remove native gas bound from builtRebalance; this changes the fingerprint
    delete persisted.builtRebalance.quotedNativeGasAmount;
    delete persisted.builtRebalance.quotedNativeGasAsset;
    writeFileSync(statePath, JSON.stringify(persisted));

    const response = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets/target-funding-1/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toContain('persisted target funding selection fingerprint mismatch');
    expect(ethereum.arbitrum.getWallet).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects persisted Bridge2 selection with tampered destination amount', async () => {
    const ethereum = mockEthereumContexts(
      { arbitrum: { gas: '3000000000000000', usdc: '6000000' } },
      { getWallet: jest.fn() },
    );
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    const buildResponse = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets',
      payload: targetRequest({
        destinationAddress: ARBITRUM_WALLET,
        destinationChain: 'hyperliquid',
        destinationNetwork: 'mainnet',
      }),
    });
    expect(buildResponse.statusCode).toBe(200);
    const statePath = path.join(stateRoot, 'target-funding-1.json');
    const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
    persisted.builtRebalance.destinationAmount = '5.9';
    writeFileSync(statePath, JSON.stringify(persisted));

    const response = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets/target-funding-1/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toContain('persisted target funding selection fingerprint mismatch');
    expect(ethereum.arbitrum.getWallet).not.toHaveBeenCalled();
    await app.close();
  });

  it('blocks Bridge2 execute when fresh gas exceeds the persisted bound', async () => {
    const ethereum = mockEthereumContexts(
      { arbitrum: { gas: '1000000000000000000', usdc: '6000000' } },
      { getWallet: jest.fn() },
    );
    ethereum.arbitrum.provider.getGasPrice.mockResolvedValue(BigNumber.from('1000000000'));
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    const buildResponse = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets',
      payload: targetRequest({
        destinationAddress: ARBITRUM_WALLET,
        destinationChain: 'hyperliquid',
        destinationNetwork: 'mainnet',
      }),
    });
    expect(buildResponse.statusCode).toBe(200);
    // The wallet can afford the fresh estimate, but it exceeds the immutable quote bound.
    ethereum.arbitrum.provider.getGasPrice.mockResolvedValue(BigNumber.from('10000000000'));

    const response = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets/target-funding-1/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().message).toBe('insufficient_source_or_gas');
    expect(ethereum.arbitrum.getWallet).not.toHaveBeenCalled();
    await app.close();
  });

  it('allows Bridge2 execute when fresh gas is within the persisted bound', async () => {
    const signer = new Wallet(`0x${'77'.repeat(32)}`);
    const sendTransaction = jest.fn(async (serialized: string) => ({ hash: utils.keccak256(serialized) }));
    const ethereum = mockEthereumContexts(
      { arbitrum: { gas: '3000000000000000', usdc: '6000000' } },
      {
        chainId: 42161,
        getWallet: jest.fn(async () => signer),
        handleTransactionExecution: jest.fn(async () => undefined),
        prepareGasOptions: jest.fn(async () => ({ gasLimit: 120000, gasPrice: BigNumber.from(10) })),
        provider: {
          getGasPrice: jest.fn(async () => BigNumber.from('1000000000')),
          getTransactionCount: jest.fn(async () => 42),
          getTransactionReceipt: jest.fn(async () => null),
          sendTransaction,
        },
      },
    );
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    const buildResponse = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets',
      payload: targetRequest({
        destinationAddress: ARBITRUM_WALLET,
        destinationChain: 'hyperliquid',
        destinationNetwork: 'mainnet',
      }),
    });
    expect(buildResponse.statusCode).toBe(200);
    ethereum.arbitrum.provider.getGasPrice.mockResolvedValue(BigNumber.from('1010000000'));

    const response = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets/target-funding-1/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe(0);
    await app.close();
  });

  it('rejects a modified persisted provider selection before any side effect', async () => {
    const sendTransaction = jest.fn();
    const ethereum = mockEthereumContexts(
      { arbitrum: { gas: '3000000000000000', usdc: '6000000' } },
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
    const signer = new Wallet(`0x${'33'.repeat(32)}`);
    const sendTransaction = jest.fn(async (serialized: string) => ({ hash: utils.keccak256(serialized) }));
    mockEthereumContexts(
      { arbitrum: { gas: '3000000000000000', usdc: '9000000' } },
      {
        chainId: 42161,
        getWallet: jest.fn(async () => signer),
        handleTransactionExecution: jest.fn(async () => ({ status: 1 })),
        prepareGasOptions: jest.fn(async () => ({
          gasLimit: 90000,
          maxFeePerGas: BigNumber.from(10),
          maxPriorityFeePerGas: BigNumber.from(1),
          type: 2,
        })),
        provider: {
          getGasPrice: jest.fn(async () => BigNumber.from('1000000000')),
          getTransactionCount: jest.fn().mockResolvedValueOnce(1),
          getTransactionReceipt: jest.fn(async () => ({ status: 1 })),
          sendTransaction,
        },
      },
    );
    const fetchMock = mockSquidRouteAndStatus('SUCCESS');
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
    const buildBody = build.json();
    const persisted = JSON.parse(readFileSync(path.join(stateRoot, 'target-funding-1.json'), 'utf8'));

    expect(buildBody).toMatchObject({
      sourceAmount: '6.0',
      destinationAmount: '6.0',
      quotedProviderCostUsd: '3.5',
      quotedGasCostUsd: '2.1',
    });
    expect(buildBody.quotedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(persisted.builtRebalance).toMatchObject({
      sourceAmount: buildBody.sourceAmount,
      destinationAmount: buildBody.destinationAmount,
      quotedProviderCostUsd: buildBody.quotedProviderCostUsd,
      quotedGasCostUsd: buildBody.quotedGasCostUsd,
      quotedAt: buildBody.quotedAt,
    });

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
    expect(firstExecute.json()).toMatchObject({ status: 0 });
    expect(retry.json()).toMatchObject({ signature: firstExecute.json().signature, status: 0 });
    expect(status.json()).toMatchObject({
      idempotencyKey: 'target-funding-1',
      provider: 'squid_router',
      sourceNetwork: 'arbitrum',
      status: 'confirmed',
      transactionHash: firstExecute.json().signature,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sendTransaction).toHaveBeenCalledTimes(2);
    expect(ensureMarlinWalletExists).toHaveBeenCalledTimes(3);
  });

  it('resumes a persisted Squid approval and submits the provider transaction without re-signing', async () => {
    const signer = new Wallet(`0x${'11'.repeat(32)}`);
    const signTransaction = jest.spyOn(signer, 'signTransaction');
    const sendTransaction = jest
      .fn()
      .mockRejectedValueOnce(new Error('interrupted before broadcast result'))
      .mockImplementation(async (serialized: string) => ({ hash: utils.keccak256(serialized) }));
    const getTransactionReceipt = jest.fn().mockResolvedValue(null);
    const ethereum = mockEthereumContexts(
      { arbitrum: { gas: '3000000000000000', usdc: '9000000' } },
      {
        chainId: 42161,
        getWallet: jest.fn(async () => signer),
        handleTransactionExecution: jest.fn(async () => ({ status: 1 })),
        prepareGasOptions: jest.fn(async () => ({ gasLimit: 90000, gasPrice: BigNumber.from(10) })),
        provider: {
          getGasPrice: jest.fn(async () => BigNumber.from('1000000000')),
          getTransactionCount: jest.fn(async () => 17),
          getTransactionReceipt,
          sendTransaction,
        },
      },
    );
    mockSquidRoute();
    const firstApp = Fastify();
    await firstApp.register(rebalanceRoutes, { prefix: '/bridge' });
    await firstApp.inject({ method: 'POST', url: '/bridge/rebalance/targets', payload: targetRequest() });
    const interrupted = await firstApp.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets/target-funding-1/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
    });
    await firstApp.close();

    const pending = JSON.parse(readFileSync(path.join(stateRoot, 'target-funding-1.json'), 'utf8'));
    expect(interrupted.statusCode).toBe(500);
    expect(pending.status).toBe('approval_submission_ambiguous');
    expect(pending.approvalSignedTransaction).toMatch(/^0x/);
    expect(pending.approvalTransactionHash).toBe(utils.keccak256(pending.approvalSignedTransaction));
    expect(pending.transactionHash).toBeUndefined();

    const secondApp = Fastify();
    await secondApp.register(rebalanceRoutes, { prefix: '/bridge' });
    const resumed = await secondApp.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets/target-funding-1/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
    });

    expect(resumed.statusCode).toBe(200);
    expect(signTransaction).toHaveBeenCalledTimes(2);
    expect(sendTransaction.mock.calls[1][0]).toBe(pending.approvalSignedTransaction);
    expect(ethereum.arbitrum.provider.getTransactionCount).toHaveBeenCalledTimes(2);
    const finalState = JSON.parse(readFileSync(path.join(stateRoot, 'target-funding-1.json'), 'utf8'));
    expect(finalState.approvalTransactionHash).toBe(pending.approvalTransactionHash);
    expect(finalState.transactionHash).toBe(utils.keccak256(finalState.signedTransaction));
    expect(finalState.transactionHash).not.toBe(finalState.approvalTransactionHash);
  });

  it('never persists or polls an approval hash as the same-chain Squid main transaction', async () => {
    const signer = new Wallet(`0x${'13'.repeat(32)}`);
    (deriveMarlinDefaultWalletMaterial as jest.Mock).mockReturnValue({
      address: signer.address,
      privateKey: 'not-used',
      storageChain: 'ethereum',
    });
    const getTransactionReceipt = jest.fn().mockResolvedValue(null);
    const sendTransaction = jest.fn();
    mockEthereumContexts(
      { base: { gas: '3000000000000000', usdc: '9000000' } },
      {
        chainId: 8453,
        getWallet: jest.fn(async () => signer),
        provider: {
          getGasPrice: jest.fn(async () => BigNumber.from('1000000000')),
          getTransactionReceipt,
          sendTransaction,
        },
      },
    );
    const fetchMock = mockSquidRouteAndStatus('SUCCESS');
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets',
      payload: targetRequest({ destinationAddress: signer.address, destinationAsset: 'ETH' }),
    });
    const statePath = path.join(stateRoot, 'target-funding-1.json');
    const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
    const approvalTransactionHash = `0x${'aa'.repeat(32)}`;
    writeFileSync(statePath, JSON.stringify({ ...persisted, approvalTransactionHash, status: 'approval_submitted' }));

    const executed = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets/target-funding-1/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
    });
    const afterExecute = JSON.parse(readFileSync(statePath, 'utf8'));
    const refreshed = await app.inject({ method: 'GET', url: '/bridge/rebalance/target-funding-1' });

    expect(executed.json()).toMatchObject({ signature: '', status: 0 });
    expect(afterExecute.approvalTransactionHash).toBe(approvalTransactionHash);
    expect(afterExecute.transactionHash).toBeUndefined();
    expect(refreshed.json().status).toBe('approval_submitted');
    expect(getTransactionReceipt).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sendTransaction).not.toHaveBeenCalled();
    await app.close();
  });

  it('persists Squid main INSUFFICIENT_FUNDS distinctly and preserves it on status refresh', async () => {
    const signer = new Wallet(`0x${'77'.repeat(32)}`);
    const sendTransaction = jest
      .fn()
      .mockResolvedValueOnce({ hash: '0xapproval' })
      .mockRejectedValueOnce(
        Object.assign(new Error('insufficient funds privateKey=ultra-secret'), { code: 'INSUFFICIENT_FUNDS' }),
      );
    const fetchMock = jest.fn(async (_url: unknown, options: Record<string, any>) =>
      options.method === 'GET'
        ? { json: async () => ({ error: 'not found' }), ok: false, status: 404 }
        : squidRouteResponse('6000000'),
    );
    global.fetch = fetchMock as any;
    mockEthereumContexts(
      { arbitrum: { gas: '3000000000000000', usdc: '9000000' } },
      {
        chainId: 42161,
        getWallet: jest.fn(async () => signer),
        handleTransactionExecution: jest.fn(async () => ({ status: 1 })),
        prepareGasOptions: jest.fn(async () => ({ gasLimit: 90000, gasPrice: BigNumber.from(10) })),
        provider: {
          getGasPrice: jest.fn(async () => BigNumber.from('1000000000')),
          getTransactionCount: jest.fn(async () => 7),
          getTransactionReceipt: jest.fn(async () => null),
          sendTransaction,
        },
      },
    );
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    await app.inject({ method: 'POST', url: '/bridge/rebalance/targets', payload: targetRequest() });

    const executed = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets/target-funding-1/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
    });
    const persisted = JSON.parse(readFileSync(path.join(stateRoot, 'target-funding-1.json'), 'utf8'));
    const refreshed = await app.inject({ method: 'GET', url: '/bridge/rebalance/target-funding-1' });

    expect(executed.statusCode).toBe(500);
    expect(persisted.status).toBe('submission_insufficient_funds');
    expect(persisted.providerError).toContain('privateKey [redacted]');
    expect(persisted.providerError).not.toContain('ultra-secret');
    expect(refreshed.json().status).toBe('submission_insufficient_funds');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: 'insufficient funds', proofNonce: 7, providerStatus: undefined, status: 'submission_insufficient_funds' },
    {
      label: 'legacy status-unavailable ambiguity',
      proofNonce: 8,
      providerStatus: 'status_unavailable',
      status: 'submission_ambiguous',
    },
  ])(
    're-signs a proven-absent Squid main transaction with a fresh nonce while retaining approval for $label',
    async ({ proofNonce, providerStatus, status }) => {
      const signer = new Wallet(`0x${'88'.repeat(32)}`);
      (deriveMarlinDefaultWalletMaterial as jest.Mock).mockReturnValue({
        address: signer.address,
        privateKey: 'not-used',
        storageChain: 'ethereum',
      });
      const persistedNonce = 7;
      const signedTransaction = await signer.signTransaction({
        chainId: 42161,
        data: '0x1234',
        gasLimit: 90000,
        gasPrice: 10,
        nonce: persistedNonce,
        to: '0x00000000000000000000000000000000000000F0',
        value: 0,
      });
      const signTransaction = jest.spyOn(signer, 'signTransaction');
      const sendTransaction = jest.fn(async (serialized: string) => ({ hash: utils.keccak256(serialized) }));
      const getTransaction = jest.fn(async () => null);
      const getTransactionReceipt = jest.fn(async (hash: string) => (hash === '0xapproval' ? { status: 1 } : null));
      const getTransactionCount = jest
        .fn()
        .mockResolvedValueOnce(proofNonce)
        .mockResolvedValueOnce(proofNonce)
        .mockResolvedValueOnce(proofNonce + 1);
      mockEthereumContexts(
        { arbitrum: { gas: '3000000000000000', usdc: '9000000' } },
        {
          chainId: 42161,
          getWallet: jest.fn(async () => signer),
          handleTransactionExecution: jest.fn(async () => ({ status: 1 })),
          prepareGasOptions: jest.fn(async () => ({ gasLimit: 90000, gasPrice: BigNumber.from(10) })),
          provider: {
            getGasPrice: jest.fn(async () => BigNumber.from('1000000000')),
            getTransaction,
            getTransactionCount,
            getTransactionReceipt,
            sendTransaction,
          },
        },
      );
      mockSquidRoute();
      const app = Fastify();
      await app.register(rebalanceRoutes, { prefix: '/bridge' });
      await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets',
        payload: targetRequest({ destinationAddress: signer.address }),
      });
      const statePath = path.join(stateRoot, 'target-funding-1.json');
      const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
      persisted.approvalSignedTransaction = '0xapproval-signed';
      persisted.approvalTransactionHash = '0xapproval';
      persisted.providerError = 'insufficient funds';
      persisted.signedTransaction = signedTransaction;
      persisted.providerStatus = providerStatus;
      persisted.status = status;
      persisted.transactionHash = utils.keccak256(signedTransaction);
      writeFileSync(statePath, JSON.stringify(persisted));

      const retried = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets/target-funding-1/execute',
        headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      });
      const finalState = JSON.parse(readFileSync(statePath, 'utf8'));

      expect(retried.statusCode).toBe(200);
      expect(signTransaction).toHaveBeenCalledTimes(1);
      expect(sendTransaction).toHaveBeenCalledTimes(1);
      expect(sendTransaction).not.toHaveBeenCalledWith(signedTransaction);
      expect(utils.parseTransaction(sendTransaction.mock.calls[0][0]).nonce).toBe(proofNonce + 1);
      expect(finalState.approvalSignedTransaction).toBe('0xapproval-signed');
      expect(finalState.approvalTransactionHash).toBe('0xapproval');
      expect(finalState.transactionHash).toBe(utils.keccak256(sendTransaction.mock.calls[0][0]));
      expect(finalState.transactionHash).not.toBe(persisted.transactionHash);
    },
  );

  it.each([
    {
      label: 'malformed signed bytes',
      signedTransaction: '0xnot-a-signed-transaction',
      transaction: null,
      receipt: null,
      counts: [],
    },
    {
      label: 'provider transaction presence',
      signedTransaction: undefined,
      transaction: { hash: '0xpresent' },
      receipt: null,
      counts: [7, 7],
    },
    {
      label: 'provider receipt presence',
      signedTransaction: undefined,
      transaction: null,
      receipt: { status: 1 },
      counts: [7, 7],
    },
    {
      label: 'nonce difference',
      signedTransaction: undefined,
      transaction: null,
      receipt: null,
      counts: [7, 8],
    },
    {
      label: 'lower nonce',
      signedTransaction: undefined,
      transaction: null,
      receipt: null,
      counts: [6, 6],
    },
    {
      approvalConfirmed: true,
      label: 'advanced nonce for insufficient funds',
      signedTransaction: undefined,
      transaction: null,
      receipt: null,
      counts: [8, 8],
    },
    {
      label: 'RPC error',
      signedTransaction: undefined,
      transaction: null,
      receipt: null,
      counts: [],
      rpcError: 'provider unavailable',
    },
  ])(
    'refuses retry when Squid insufficient-funds proof has $label',
    async ({
      approvalConfirmed,
      signedTransaction: signedTransactionOverride,
      transaction,
      receipt,
      counts,
      rpcError,
    }) => {
      const signer = new Wallet(`0x${'99'.repeat(32)}`);
      (deriveMarlinDefaultWalletMaterial as jest.Mock).mockReturnValue({
        address: signer.address,
        privateKey: 'not-used',
        storageChain: 'ethereum',
      });
      const signedTransaction =
        signedTransactionOverride ??
        (await signer.signTransaction({
          chainId: 42161,
          data: '0x1234',
          gasLimit: 90000,
          gasPrice: 10,
          nonce: 7,
          to: '0x00000000000000000000000000000000000000F0',
          value: 0,
        }));
      const signTransaction = jest.spyOn(signer, 'signTransaction');
      const sendTransaction = jest.fn(async (serialized: string) => ({ hash: utils.keccak256(serialized) }));
      const getTransaction = jest.fn(async () => {
        if (rpcError) {
          throw new Error(rpcError);
        }
        return transaction;
      });
      const getTransactionReceipt = jest.fn(async (hash: string) =>
        hash === '0xapproval' && approvalConfirmed ? { status: 1 } : receipt,
      );
      const getTransactionCount = jest.fn();
      counts.forEach((count) => getTransactionCount.mockResolvedValueOnce(count));
      mockEthereumContexts(
        { arbitrum: { gas: '3000000000000000', usdc: '9000000' } },
        {
          chainId: 42161,
          getWallet: jest.fn(async () => signer),
          handleTransactionExecution: jest.fn(async () => ({ status: 1 })),
          prepareGasOptions: jest.fn(async () => ({ gasLimit: 90000, gasPrice: BigNumber.from(10) })),
          provider: {
            getGasPrice: jest.fn(async () => BigNumber.from('1000000000')),
            getTransaction,
            getTransactionCount,
            getTransactionReceipt,
            sendTransaction,
          },
        },
      );
      mockSquidRoute();
      const app = Fastify();
      await app.register(rebalanceRoutes, { prefix: '/bridge' });
      await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets',
        payload: targetRequest({ destinationAddress: signer.address }),
      });
      const statePath = path.join(stateRoot, 'target-funding-1.json');
      const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
      persisted.approvalTransactionHash = '0xapproval';
      persisted.signedTransaction = signedTransaction;
      persisted.status = 'submission_insufficient_funds';
      persisted.transactionHash = utils.isHexString(signedTransaction)
        ? utils.keccak256(signedTransaction)
        : utils.keccak256('0x1234');
      persisted.providerError = 'insufficient funds';
      writeFileSync(statePath, JSON.stringify(persisted));

      const retried = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets/target-funding-1/execute',
        headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      });
      const finalState = JSON.parse(readFileSync(statePath, 'utf8'));

      expect(retried.statusCode).toBe(200);
      expect(signTransaction).not.toHaveBeenCalled();
      expect(sendTransaction).not.toHaveBeenCalled();
      expect(finalState).toMatchObject({
        providerError: persisted.providerError,
        signedTransaction: persisted.signedTransaction,
        status: persisted.status,
        transactionHash: persisted.transactionHash,
      });
    },
  );

  it.each([
    ['ONGOING', 'submitted'],
    ['FAILURE', 'failed'],
    ['SUCCESS', 'confirmed'],
  ])(
    'keeps a successful Squid source receipt nonterminal until destination status %s',
    async (squidStatus, expected) => {
      const signer = new Wallet(`0x${'44'.repeat(32)}`);
      const sendTransaction = jest.fn(async (serialized: string) => ({ hash: utils.keccak256(serialized) }));
      mockEthereumContexts(
        { arbitrum: { gas: '3000000000000000', usdc: '9000000' } },
        {
          chainId: 42161,
          getWallet: jest.fn(async () => signer),
          handleTransactionExecution: jest.fn(async () => ({ status: 1 })),
          prepareGasOptions: jest.fn(async () => ({ gasLimit: 90000, gasPrice: BigNumber.from(10) })),
          provider: {
            getGasPrice: jest.fn(async () => BigNumber.from('1000000000')),
            getTransactionCount: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2),
            getTransactionReceipt: jest.fn(async () => ({ status: 1 })),
            sendTransaction,
          },
        },
      );
      mockSquidRouteAndStatus(squidStatus);
      const app = Fastify();
      await app.register(rebalanceRoutes, { prefix: '/bridge' });
      await app.inject({ method: 'POST', url: '/bridge/rebalance/targets', payload: targetRequest() });

      const executed = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets/target-funding-1/execute',
        headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      });
      const refreshed = await app.inject({ method: 'GET', url: '/bridge/rebalance/target-funding-1' });

      expect(executed.json().status).toBe(0);
      expect(refreshed.json().status).toBe(expected);
    },
  );

  it('marks a reverted Squid source receipt failed without polling destination status', async () => {
    const signer = new Wallet(`0x${'55'.repeat(32)}`);
    const fetchMock = mockSquidRouteAndStatus('SUCCESS');
    mockEthereumContexts(
      { arbitrum: { gas: '3000000000000000', usdc: '9000000' } },
      {
        chainId: 42161,
        getWallet: jest.fn(async () => signer),
        handleTransactionExecution: jest.fn().mockResolvedValueOnce({ status: 1 }).mockResolvedValueOnce({ status: 0 }),
        prepareGasOptions: jest.fn(async () => ({ gasLimit: 90000, gasPrice: BigNumber.from(10) })),
        provider: {
          getGasPrice: jest.fn(async () => BigNumber.from('1000000000')),
          getTransactionCount: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2),
          getTransactionReceipt: jest.fn(async () => ({ status: 0 })),
          sendTransaction: jest.fn(async (serialized: string) => ({ hash: utils.keccak256(serialized) })),
        },
      },
    );
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    await app.inject({ method: 'POST', url: '/bridge/rebalance/targets', payload: targetRequest() });
    const executed = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets/target-funding-1/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
    });
    const refreshed = await app.inject({ method: 'GET', url: '/bridge/rebalance/target-funding-1' });

    expect(executed.json().status).toBe(-1);
    expect(refreshed.json().status).toBe('failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('recovers persisted Squid source bytes after the source balance was debited', async () => {
    const signer = new Wallet(`0x${'66'.repeat(32)}`);
    const sendTransaction = jest.fn(async (serialized: string) => ({ hash: utils.keccak256(serialized) }));
    const ethereum = mockEthereumContexts(
      { arbitrum: { gas: '3000000000000000', usdc: '9000000' } },
      {
        chainId: 42161,
        getWallet: jest.fn(async () => signer),
        handleTransactionExecution: jest.fn(async () => ({ status: 1 })),
        prepareGasOptions: jest.fn(async () => ({ gasLimit: 90000, gasPrice: BigNumber.from(10) })),
        provider: {
          getGasPrice: jest.fn(async () => BigNumber.from('1000000000')),
          getTransactionCount: jest.fn(async () => 9),
          getTransactionReceipt: jest.fn(async () => null),
          sendTransaction,
        },
      },
    );
    mockSquidRoute();
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    await app.inject({ method: 'POST', url: '/bridge/rebalance/targets', payload: targetRequest() });
    const statePath = path.join(stateRoot, 'target-funding-1.json');
    const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
    const signedTransaction = await signer.signTransaction({
      chainId: 42161,
      data: persisted.builtRebalance.txCalldata,
      gasLimit: 90000,
      gasPrice: 10,
      nonce: 9,
      to: persisted.builtRebalance.txTarget,
      value: 0,
    });
    persisted.signedTransaction = signedTransaction;
    persisted.transactionHash = utils.keccak256(signedTransaction);
    persisted.status = 'submission_ambiguous';
    writeFileSync(statePath, JSON.stringify(persisted));
    ethereum.arbitrum.getERC20BalanceByAddress.mockResolvedValue({ decimals: 6, value: BigNumber.from(0) });

    const recovered = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets/target-funding-1/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
    });

    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({ signature: persisted.transactionHash, status: 0 });
    expect(sendTransaction).toHaveBeenCalledWith(signedTransaction);
  });

  it.each([
    { receiptStatus: 1, expectedStatus: 'confirmed' },
    { receiptStatus: 0, expectedStatus: 'failed' },
  ])(
    'refreshes a known Bridge2 transaction receipt to $expectedStatus after restart without signing again',
    async ({ receiptStatus, expectedStatus }) => {
      const signer = new Wallet(`0x${'22'.repeat(32)}`);
      const signTransaction = jest.spyOn(signer, 'signTransaction');
      const sendTransaction = jest.fn(async (serialized: string) => ({ hash: utils.keccak256(serialized) }));
      const getTransactionReceipt = jest.fn().mockResolvedValue({ status: receiptStatus });
      mockEthereumContexts(
        { arbitrum: { gas: '3000000000000000', usdc: '6000000' } },
        {
          chainId: 42161,
          getWallet: jest.fn(async () => signer),
          handleTransactionExecution: jest.fn(async () => undefined),
          prepareGasOptions: jest.fn(async () => ({ gasLimit: 120000, gasPrice: BigNumber.from(10) })),
          provider: {
            getGasPrice: jest.fn(async () => BigNumber.from('1000000000')),
            getTransactionCount: jest.fn(async () => 23),
            getTransactionReceipt,
            sendTransaction,
          },
        },
      );
      const firstApp = Fastify();
      await firstApp.register(rebalanceRoutes, { prefix: '/bridge' });
      await firstApp.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets',
        payload: targetRequest({
          destinationAddress: ARBITRUM_WALLET,
          destinationChain: 'hyperliquid',
          destinationNetwork: 'mainnet',
        }),
      });
      const submitted = await firstApp.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets/target-funding-1/execute',
        headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      });
      await firstApp.close();

      const secondApp = Fastify();
      await secondApp.register(rebalanceRoutes, { prefix: '/bridge' });
      const refreshed = await secondApp.inject({ method: 'GET', url: '/bridge/rebalance/target-funding-1' });

      expect(submitted.json().status).toBe(0);
      expect(refreshed.json()).toMatchObject({ status: expectedStatus, transactionHash: submitted.json().signature });
      expect(signTransaction).toHaveBeenCalledTimes(1);
      expect(sendTransaction).toHaveBeenCalledTimes(1);
    },
  );

  it('rejects caller-supplied provider, source, and wallet authority fields', async () => {
    mockEthereumContexts({ arbitrum: { gas: '3000000000000000', usdc: '6000000' } });
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });

    const response = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets',
      payload: { ...targetRequest(), provider: 'squid_router', sourceNetwork: 'base', walletAddress: BASE_WALLET },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects the old `amount` field as unknown', async () => {
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    const response = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets',
      payload: { ...targetRequest(), amount: '100', targetNotionalEur: undefined },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects second selection with same idempotency key but different targetNotionalEur', async () => {
    mockEthereumContexts({ arbitrum: { gas: '3000000000000000', usdc: '9000000' } });
    const fetchMock = mockSquidRoute('9000000');
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    const first = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets',
      payload: targetRequest({ targetNotionalEur: '6' }),
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets',
      payload: targetRequest({ targetNotionalEur: '9' }),
    });
    expect(second.statusCode).toBe(500);
    expect(second.body).toContain('idempotency key already used for a different rebalance request');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects second selection with same idempotency key but different destinationAmount', async () => {
    mockEthereumContexts({ arbitrum: { gas: '3000000000000000', usdc: '100000000' } });
    let fetchCount = 0;
    const fetchMock = jest.fn(async (_url: unknown, options: Record<string, any>) => {
      fetchCount += 1;
      const fromAmount = BigNumber.from(JSON.parse(options.body).fromAmount);
      return squidRouteResponse(fromAmount.mul(BigNumber.from(10).pow(12)).div(3000).toString());
    });
    global.fetch = fetchMock as any;
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    const first = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets',
      payload: targetRequest({ targetNotionalEur: '31', destinationAmount: '0.01', destinationAsset: 'WETH' }),
    });
    expect(first.statusCode).toBe(200);
    const callsAfterFirst = fetchCount;
    const second = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets',
      payload: targetRequest({ targetNotionalEur: '31', destinationAmount: '0.02', destinationAsset: 'WETH' }),
    });
    expect(second.statusCode).toBe(500);
    expect(second.body).toContain('idempotency key already used for a different rebalance request');
    expect(fetchCount).toBe(callsAfterFirst);
  });

  it.each([
    {
      name: 'missing feeCosts array',
      feeCosts: undefined as unknown,
      gasCosts: [{ amountUsd: '2.10' }],
      expectedStatus: 500,
      expectedBody: 'Squid route missing feeCosts',
    },
    {
      name: 'missing gasCosts array',
      feeCosts: [{ amountUsd: '3.50' }],
      gasCosts: undefined as unknown,
      expectedStatus: 500,
      expectedBody: 'Squid route missing gasCosts',
    },
    {
      name: 'cost entry with missing amountUsd',
      feeCosts: [{ amountUsd: '3.50' }],
      gasCosts: [{}],
      expectedStatus: 500,
      expectedBody: 'Squid cost entry missing amountUsd',
    },
    {
      name: 'cost amountUsd with negative value',
      feeCosts: [{ amountUsd: '3.50' }],
      gasCosts: [{ amountUsd: '-2.10' }],
      expectedStatus: 500,
      expectedBody: 'Squid cost amountUsd is negative',
    },
    {
      name: 'cost amountUsd with exponent notation',
      feeCosts: [{ amountUsd: '3.50' }],
      gasCosts: [{ amountUsd: '2.1e0' }],
      expectedStatus: 500,
      expectedBody: 'Squid cost amountUsd uses exponent notation',
    },
    {
      name: 'cost amountUsd with Infinity input',
      feeCosts: [{ amountUsd: 'Infinity' }],
      gasCosts: [{ amountUsd: '2.10' }],
      expectedStatus: 500,
      expectedBody: 'Squid cost amountUsd is not a valid decimal string',
    },
    {
      name: 'cost amountUsd with excessive precision (>12 decimals)',
      feeCosts: [{ amountUsd: '3.5012345678912' }],
      gasCosts: [{ amountUsd: '2.10' }],
      expectedStatus: 500,
      expectedBody: 'exceeds maximum precision of 12 decimals',
    },
    {
      name: 'cost amountUsd with exactly 12 decimal places',
      feeCosts: [{ amountUsd: '3.501234567891' }],
      gasCosts: [{ amountUsd: '2.100000000000' }],
      expectedStatus: 200,
    },
    {
      name: 'authoritative empty cost arrays',
      feeCosts: [],
      gasCosts: [],
      expectedStatus: 200,
      expectedProviderCost: '0',
      expectedGasCost: '0',
    },
    {
      name: 'sums multi-entry feeCosts exactly',
      feeCosts: [{ amountUsd: '1.25' }, { amountUsd: '2.75' }],
      gasCosts: [{ amountUsd: '0.50' }],
      expectedStatus: 200,
      expectedProviderCost: '4',
      expectedGasCost: '0.5',
    },
  ])(
    'validates Squid cost inputs: $name',
    async ({ feeCosts, gasCosts, expectedStatus, expectedBody, expectedProviderCost, expectedGasCost }) => {
      mockEthereumContexts({ arbitrum: { gas: '3000000000000000', usdc: '9000000' } });
      const fetchMock = jest.fn(async () => ({
        headers: { get: () => 'squid-request-1' },
        json: async () => ({
          route: {
            estimate: {
              toAmount: '6000000',
              ...(feeCosts !== undefined ? { feeCosts } : {}),
              ...(gasCosts !== undefined ? { gasCosts } : {}),
            },
            id: 'squid-route-1',
            quoteId: 'squid-quote-1',
            requestId: 'squid-request-1',
            transactionRequest: {
              data: '0x1234',
              gasLimit: '994800',
              target: '0x00000000000000000000000000000000000000F0',
              value: '0',
            },
          },
        }),
        ok: true,
        status: 200,
      }));
      global.fetch = fetchMock as any;
      const app = Fastify();
      await app.register(rebalanceRoutes, { prefix: '/bridge' });
      const response = await app.inject({ method: 'POST', url: '/bridge/rebalance/targets', payload: targetRequest() });
      expect(response.statusCode).toBe(expectedStatus);
      if (expectedBody) {
        expect(response.body).toContain(expectedBody);
      }
      if (expectedProviderCost !== undefined) {
        const body = response.json();
        expect(body.quotedProviderCostUsd).toBe(expectedProviderCost);
        expect(body.quotedGasCostUsd).toBe(expectedGasCost);
      }
      await app.close();
    },
  );

  it('forward-quotes a 100 EUR WETH target without destinationAmount using at most 100 USDC source budget', async () => {
    mockEthereumContexts({ arbitrum: { gas: '3000000000000000', usdc: '100000000' } });
    const fetchMock = jest.fn(async (_url: unknown, options: Record<string, any>) => {
      const body = JSON.parse(options.body);
      const fromAmount = BigNumber.from(body.fromAmount);
      return {
        headers: { get: () => 'squid-request-1' },
        json: async () => ({
          route: {
            estimate: {
              toAmount: fromAmount.mul(10).toString(),
              feeCosts: [{ amountUsd: '3.50' }],
              gasCosts: [{ amountUsd: '2.10' }],
            },
            id: 'squid-route-1',
            quoteId: 'squid-quote-1',
            requestId: 'squid-request-1',
            transactionRequest: {
              data: '0x1234',
              gasLimit: '994800',
              target: '0x00000000000000000000000000000000000000F0',
              value: '0',
            },
          },
        }),
        ok: true,
        status: 200,
      };
    });
    global.fetch = fetchMock as any;
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    const response = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/targets',
      payload: targetRequest({
        targetNotionalEur: '100',
        destinationAsset: 'WETH',
        destinationAmount: undefined,
        maxCostBps: undefined,
      }),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      destinationAsset: 'WETH',
      provider: 'squid_router',
      sourceNetwork: 'arbitrum',
    });
    const body = response.json();
    expect(body.quotedProviderCostUsd).toBe('3.5');
    expect(body.quotedGasCostUsd).toBe('2.1');
    expect(body.quotedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    const squidPayload = JSON.parse(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1].body);
    expect(squidPayload.fromAmount).toBe('100000000');
    expect(squidPayload.fromToken).toBe(ARBITRUM_USDC);
    expect(squidPayload.toToken).toBe(BASE_WETH);
  });

  describe('ETH conversion for Hyperliquid target funding', () => {
    it('builds exact-output ETH->USDC conversion as stage 0 when direct USDC is insufficient but native ETH covers quote plus gas reserve', async () => {
      const ethereum = mockEthereumContexts({ arbitrum: { gas: '20000000000000000', usdc: '0' } });
      const uniswapMock = {
        quoteExactOutputSingle: jest.fn(async () => utils.parseEther('0.005')),
        quoteExactInputSingle: jest.fn(async () => utils.parseUnits('6', 6)),
      };
      (Uniswap.getInstance as jest.Mock).mockResolvedValue(uniswapMock);
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
      const body = response.json();
      expect(body.provider).toBe('provider_treasury_same_chain_swap');
      expect(body.sourceNetwork).toBe('arbitrum');
      expect(body.sourceAmount).toBe('6.0');
      expect(body.sourceAsset).toBe('USDC');
      expect(body.destinationAsset).toBe('USDC');
      expect(body.quotedNativeGasAsset).toBe('ETH');
      const expectedGasWei = BigNumber.from('1000000000').mul(750000).mul(12).div(10);
      expect(utils.parseEther(body.quotedNativeGasAmount).eq(expectedGasWei)).toBe(true);
      expect(body.destinationVenue).toBeUndefined();
      expect(body.stageIndex).toBe(0);
      expect(body.stageCount).toBe(2);
      expect(body.stageStatus).toBe('built');
      expect(body.walletAddress).toBe(utils.getAddress(ARBITRUM_WALLET));
      const ethAmount = utils.parseEther(body.amount);
      expect(ethAmount.eq(utils.parseEther('0.005'))).toBe(true);
      const persisted = JSON.parse(readFileSync(path.join(stateRoot, 'target-funding-1.json'), 'utf8'));
      expect(persisted.planVersion).toBe(1);
      expect(persisted.stages).toHaveLength(2);
      expect(persisted.stages[0]).toMatchObject({ index: 0, kind: 'conversion', status: 'built' });
      expect(persisted.stages[1]).toMatchObject({ index: 1, kind: 'funding', status: 'blocked_on_prior_stage' });
      expect(persisted.builtRebalance).toBeDefined();
      expect(persisted.planTarget).toEqual({
        destinationAddress: utils.getAddress(ARBITRUM_WALLET),
        destinationAsset: 'USDC',
        destinationAssetAddress: ARBITRUM_USDC,
        destinationChain: 'hyperliquid',
        destinationNetwork: 'mainnet',
        targetNotionalEur: '6',
      });
      expect(persisted.preConversionUsdcBalanceUnits).toBe('0');
      expect(persisted.planTargetFingerprint).toMatch(/^0x[0-9a-f]{64}$/);
      expect(body.planTarget).toBeUndefined();
      expect(body.preConversionUsdcBalanceUnits).toBeUndefined();
      expect(uniswapMock.quoteExactOutputSingle).toHaveBeenCalledWith(
        ARBITRUM_WETH,
        ARBITRUM_USDC,
        500,
        utils.parseUnits('6', 6),
      );
      expect(ethereum.arbitrum.getWallet).not.toHaveBeenCalled();
      await app.close();
    });

    it('rejects tampered two-stage target metadata before execution', async () => {
      mockEthereumContexts({ arbitrum: { gas: '20000000000000000', usdc: '0' } });
      (Uniswap.getInstance as jest.Mock).mockResolvedValue({
        quoteExactOutputSingle: jest.fn(async () => utils.parseEther('0.005')),
        quoteExactInputSingle: jest.fn(async () => utils.parseUnits('6', 6)),
      });
      const app = Fastify();
      await app.register(rebalanceRoutes, { prefix: '/bridge' });
      const payload = targetRequest({
        destinationAddress: ARBITRUM_WALLET,
        destinationChain: 'hyperliquid',
        destinationNetwork: 'mainnet',
      });
      expect((await app.inject({ method: 'POST', url: '/bridge/rebalance/targets', payload })).statusCode).toBe(200);
      const statePath = path.join(stateRoot, 'target-funding-1.json');
      const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
      persisted.preConversionUsdcBalanceUnits = '1';
      writeFileSync(statePath, JSON.stringify(persisted));

      const reload = await app.inject({ method: 'POST', url: '/bridge/rebalance/targets', payload });
      expect(reload.statusCode).toBe(500);
      expect(reload.body).toContain('target plan metadata fingerprint mismatch');
      await app.close();
    });

    it('does not persist a conversion plan when the baseline USDC read fails', async () => {
      const ethereum = mockEthereumContexts({ arbitrum: { gas: '20000000000000000', usdc: '0' } });
      ethereum.arbitrum.getERC20BalanceByAddress
        .mockResolvedValueOnce({ decimals: 6, value: BigNumber.from(0) })
        .mockRejectedValueOnce(new Error('balance unavailable'));
      (Uniswap.getInstance as jest.Mock).mockResolvedValue({
        quoteExactOutputSingle: jest.fn(async () => utils.parseEther('0.005')),
        quoteExactInputSingle: jest.fn(async () => utils.parseUnits('6', 6)),
      });
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
      expect(response.body).toContain('target funding pre-conversion USDC balance unavailable');
      expect(() => readFileSync(path.join(stateRoot, 'target-funding-1.json'))).toThrow();
      await app.close();
    });

    it('falls back to exact-input conversion when native ETH insufficient for exact-output plus gas reserve', async () => {
      const ethereum = mockEthereumContexts({ arbitrum: { gas: '5500000000000000', usdc: '0' } });
      const uniswapMock = {
        quoteExactOutputSingle: jest.fn(async () => utils.parseEther('0.005')),
        quoteExactInputSingle: jest.fn(async () => utils.parseUnits('5.2', 6)),
      };
      (Uniswap.getInstance as jest.Mock).mockResolvedValue(uniswapMock);
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
      const body = response.json();
      expect(body.provider).toBe('provider_treasury_same_chain_swap');
      expect(body.sourceAmount).toBe('5.2');
      expect(body.sourceAsset).toBe('USDC');
      expect(body.quotedNativeGasAsset).toBe('ETH');
      const expectedGasWei = BigNumber.from('1000000000').mul(750000).mul(12).div(10);
      expect(utils.parseEther(body.quotedNativeGasAmount).eq(expectedGasWei)).toBe(true);
      expect(body.stageIndex).toBe(0);
      expect(body.stageCount).toBe(2);
      expect(body.stageStatus).toBe('built');
      const ethAmount = utils.parseEther(body.amount);
      expect(ethAmount.eq(utils.parseEther('0.0046'))).toBe(true);
      expect(uniswapMock.quoteExactOutputSingle).toHaveBeenCalled();
      expect(uniswapMock.quoteExactInputSingle).toHaveBeenCalled();
      expect(ethereum.arbitrum.getWallet).not.toHaveBeenCalled();
      await app.close();
    });

    it('blocks conversion when quoted output from exact-input fallback is below 5 USDC minimum', async () => {
      const ethereum = mockEthereumContexts({ arbitrum: { gas: '1500000000000000', usdc: '0' } });
      const uniswapMock = {
        quoteExactOutputSingle: jest.fn().mockRejectedValue(new Error('price unavailable')),
        quoteExactInputSingle: jest.fn(async () => utils.parseUnits('4.999999', 6)),
      };
      (Uniswap.getInstance as jest.Mock).mockResolvedValue(uniswapMock);
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
      expect(ethereum.arbitrum.getWallet).not.toHaveBeenCalled();
      expect(() => readFileSync(path.join(stateRoot, 'target-funding-1.json'))).toThrow();
      await app.close();
    });

    it('preserves direct USDC funding when USDC balance is sufficient (existing path unchanged)', async () => {
      const ethereum = mockEthereumContexts({ arbitrum: { gas: '3000000000000000', usdc: '6000000' } });
      const uniswapMock = {
        quoteExactOutputSingle: jest.fn(),
        quoteExactInputSingle: jest.fn(),
      };
      (Uniswap.getInstance as jest.Mock).mockResolvedValue(uniswapMock);
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
      const body = response.json();
      expect(body.provider).toBe('hyperliquid_bridge2');
      expect(body.sourceNetwork).toBe('arbitrum');
      expect(body.sourceAsset).toBe('USDC');
      expect(body.stageIndex).toBeUndefined();
      expect(body.stageCount).toBeUndefined();
      expect(body.stageStatus).toBeUndefined();
      expect(uniswapMock.quoteExactOutputSingle).not.toHaveBeenCalled();
      expect(uniswapMock.quoteExactInputSingle).not.toHaveBeenCalled();
      await app.close();
    });
  });

  describe('ETH conversion for Squid target funding (Base/Solana)', () => {
    it.each([
      {
        destinationChain: 'ethereum',
        destinationNetwork: 'base',
        destinationAddress: BASE_WALLET,
        expectedAssetAddress: BASE_USDC,
      },
      {
        destinationChain: 'solana',
        destinationNetwork: 'mainnet-beta',
        destinationAddress: SOLANA_WALLET,
        expectedAssetAddress: SOLANA_USDC,
      },
    ])(
      'builds exact-output ETH->USDC conversion as stage 0 for $destinationNetwork when direct USDC is insufficient but native ETH covers quote plus gas reserve',
      async ({ destinationChain, destinationNetwork, destinationAddress, expectedAssetAddress }) => {
        const ethereum = mockEthereumContexts({ arbitrum: { gas: '20000000000000000', usdc: '0' } });
        const uniswapMock = {
          quoteExactOutputSingle: jest.fn(async () => utils.parseEther('0.005')),
          quoteExactInputSingle: jest.fn(async () => utils.parseUnits('6', 6)),
        };
        (Uniswap.getInstance as jest.Mock).mockResolvedValue(uniswapMock);
        const app = Fastify();
        await app.register(rebalanceRoutes, { prefix: '/bridge' });

        const response = await app.inject({
          method: 'POST',
          url: '/bridge/rebalance/targets',
          payload: targetRequest({ destinationAddress, destinationChain, destinationNetwork }),
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.provider).toBe('provider_treasury_same_chain_swap');
        expect(body.sourceNetwork).toBe('arbitrum');
        expect(body.sourceAmount).toBe('6.0');
        expect(body.sourceAsset).toBe('USDC');
        expect(body.destinationAsset).toBe('USDC');
        expect(body.quotedNativeGasAsset).toBe('ETH');
        const expectedGasWei = BigNumber.from('1000000000').mul(2720000).mul(12).div(10);
        expect(utils.parseEther(body.quotedNativeGasAmount).eq(expectedGasWei)).toBe(true);
        expect(body.stageIndex).toBe(0);
        expect(body.stageCount).toBe(2);
        expect(body.stageStatus).toBe('built');
        expect(body.walletAddress).toBe(utils.getAddress(ARBITRUM_WALLET));
        const ethAmount = utils.parseEther(body.amount);
        expect(ethAmount.eq(utils.parseEther('0.005'))).toBe(true);
        const persisted = JSON.parse(readFileSync(path.join(stateRoot, 'target-funding-1.json'), 'utf8'));
        expect(persisted.planVersion).toBe(1);
        expect(persisted.stages).toHaveLength(2);
        expect(persisted.stages[0]).toMatchObject({ index: 0, kind: 'conversion', status: 'built' });
        expect(persisted.stages[1]).toMatchObject({ index: 1, kind: 'funding', status: 'blocked_on_prior_stage' });
        expect(persisted.planTarget).toEqual({
          destinationAddress,
          destinationAsset: 'USDC',
          destinationAssetAddress: expectedAssetAddress,
          destinationChain,
          destinationNetwork,
          targetNotionalEur: '6',
        });
        expect(persisted.preConversionUsdcBalanceUnits).toBe('0');
        expect(persisted.planTargetFingerprint).toMatch(/^0x[0-9a-f]{64}$/);
        expect(uniswapMock.quoteExactOutputSingle).toHaveBeenCalledWith(
          ARBITRUM_WETH,
          ARBITRUM_USDC,
          500,
          utils.parseUnits('6', 6),
        );
        expect(ethereum.arbitrum.getWallet).not.toHaveBeenCalled();
        await app.close();
      },
    );

    it('blocks when native ETH insufficient for conversion plus squid stage-1 gas reserve', async () => {
      const ethereum = mockEthereumContexts({ arbitrum: { gas: '500000000000000', usdc: '0' } });
      const uniswapMock = {
        quoteExactOutputSingle: jest.fn(async () => utils.parseEther('0.005')),
        quoteExactInputSingle: jest.fn(async () => utils.parseUnits('6', 6)),
      };
      (Uniswap.getInstance as jest.Mock).mockResolvedValue(uniswapMock);
      const app = Fastify();
      await app.register(rebalanceRoutes, { prefix: '/bridge' });

      const response = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets',
        payload: targetRequest({
          destinationAddress: BASE_WALLET,
          destinationChain: 'ethereum',
          destinationNetwork: 'base',
        }),
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().message).toBe('insufficient_source_or_gas');
      expect(ethereum.arbitrum.getWallet).not.toHaveBeenCalled();
      await app.close();
    });

    it('preserves direct Squid USDC funding when USDC balance is sufficient (existing path unchanged)', async () => {
      const ethereum = mockEthereumContexts({ arbitrum: { gas: '3000000000000000', usdc: '9000000' } });
      const fetchMock = mockSquidRoute();
      const app = Fastify();
      await app.register(rebalanceRoutes, { prefix: '/bridge' });

      const response = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets',
        payload: targetRequest({
          destinationAddress: BASE_WALLET,
          destinationChain: 'ethereum',
          destinationNetwork: 'base',
        }),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.provider).toBe('squid_router');
      expect(body.sourceNetwork).toBe('arbitrum');
      expect(body.stageIndex).toBeUndefined();
      expect(body.stageCount).toBeUndefined();
      const squidPayload = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(squidPayload.fromToken).toBe(ARBITRUM_USDC);
      expect(squidPayload.toChain).toBe('8453');
      expect(squidPayload.toToken).toBe(BASE_USDC);
      await app.close();
    });
  });

  describe('two-stage target plan execution', () => {
    const BRIDGE2 = '0x2df1c51e09aecf9cacb7bc98cb1742757f163df7';

    it('blocks Squid stage-0 conversion at the reserve boundary before spending native ETH', async () => {
      const ethereum = mockEthereumContexts(
        { arbitrum: { gas: '20000000000000000', usdc: '0' } },
        {
          chainId: 42161,
          getWallet: jest.fn(),
          handleTransactionExecution: jest.fn(),
          prepareGasOptions: jest.fn(),
          provider: {
            getGasPrice: jest.fn(async () => BigNumber.from('1000000000')),
            getTransactionCount: jest.fn(),
            getTransactionReceipt: jest.fn(),
            sendTransaction: jest.fn(),
          },
        },
      );
      (Uniswap.getInstance as jest.Mock).mockResolvedValue({
        quoteExactOutputSingle: jest.fn(async () => utils.parseEther('0.005')),
        quoteExactInputSingle: jest.fn(async () => utils.parseUnits('6', 6)),
      });
      ethereum.arbitrum.getNativeBalanceByAddress
        .mockResolvedValueOnce({ decimals: 18, value: BigNumber.from('20000000000000000') })
        .mockResolvedValueOnce({ decimals: 18, value: BigNumber.from('20000000000000000') })
        .mockResolvedValue({ decimals: 18, value: BigNumber.from('6100000000000000') });
      const app = Fastify();
      await app.register(rebalanceRoutes, { prefix: '/bridge' });
      const build = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets',
        payload: targetRequest({
          destinationAddress: BASE_WALLET,
          destinationChain: 'ethereum',
          destinationNetwork: 'base',
        }),
      });
      expect(build.statusCode).toBe(200);

      const execute = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets/target-funding-1/execute',
        headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      });

      expect(execute.statusCode).toBe(409);
      expect(execute.json().message).toBe('insufficient_source_or_gas');
      expect(ethereum.arbitrum.getNativeBalanceByAddress).toHaveBeenCalled();
      expect(ethereum.arbitrum.getWallet).not.toHaveBeenCalled();
      await app.close();
    });

    it('rejects stage-0 conversion when native gas price is zero', async () => {
      const ethereum = mockEthereumContexts(
        { arbitrum: { gas: '20000000000000000', usdc: '0' } },
        {
          chainId: 42161,
          getWallet: jest.fn(),
          handleTransactionExecution: jest.fn(),
          prepareGasOptions: jest.fn(),
          provider: {
            getGasPrice: jest
              .fn()
              .mockResolvedValueOnce(BigNumber.from('1000000000'))
              .mockResolvedValueOnce(BigNumber.from('1000000000'))
              .mockResolvedValue(BigNumber.from(0)),
            getTransactionCount: jest.fn(),
            getTransactionReceipt: jest.fn(),
            sendTransaction: jest.fn(),
          },
        },
      );
      (Uniswap.getInstance as jest.Mock).mockResolvedValue({
        quoteExactOutputSingle: jest.fn(async () => utils.parseEther('0.005')),
        quoteExactInputSingle: jest.fn(async () => utils.parseUnits('6', 6)),
      });
      const app = Fastify();
      await app.register(rebalanceRoutes, { prefix: '/bridge' });
      const build = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets',
        payload: targetRequest({
          destinationAddress: ARBITRUM_WALLET,
          destinationChain: 'hyperliquid',
          destinationNetwork: 'mainnet',
        }),
      });
      expect(build.statusCode).toBe(200);

      const execute = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets/target-funding-1/execute',
        headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      });

      expect(execute.statusCode).toBe(409);
      expect(execute.json().message).toBe('insufficient_source_or_gas');
      await app.close();
    });

    it('completes stage-0 conversion swap and transitions to stage-1 Bridge2 build on confirmed receipt', async () => {
      const signer = new Wallet(`0x${'aa'.repeat(32)}`);
      const sendTransaction = jest.fn(async (serialized: string) => ({ hash: utils.keccak256(serialized) }));
      const getTransactionReceipt = jest.fn().mockResolvedValue(null);
      const ethereum = mockEthereumContexts(
        { arbitrum: { gas: '20000000000000000', usdc: '0' } },
        {
          chainId: 42161,
          getWallet: jest.fn(async () => signer),
          handleTransactionExecution: jest.fn(async () => ({ status: 1 })),
          prepareGasOptions: jest.fn(async () => ({ gasLimit: 90000, gasPrice: BigNumber.from(10) })),
          provider: {
            getGasPrice: jest.fn(async () => BigNumber.from('1000000000')),
            getTransactionCount: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2).mockResolvedValueOnce(3),
            getTransactionReceipt,
            sendTransaction,
          },
        },
      );
      const uniswapMock = {
        quoteExactOutputSingle: jest.fn(async () => utils.parseEther('0.005')),
        quoteExactInputSingle: jest.fn(async () => utils.parseUnits('6', 6)),
      };
      (Uniswap.getInstance as jest.Mock).mockResolvedValue(uniswapMock);

      // After build, the pre-conversion balance was read as 0.
      // For execution, mock post-conversion balance to 6000000 (6 USDC)
      ethereum.arbitrum.getERC20BalanceByAddress
        .mockResolvedValueOnce({ decimals: 6, value: BigNumber.from(0) })
        .mockResolvedValueOnce({ decimals: 6, value: BigNumber.from(0) })
        .mockResolvedValueOnce({ decimals: 6, value: BigNumber.from(0) })
        .mockResolvedValue({ decimals: 6, value: BigNumber.from('8000000') });

      const app = Fastify();
      await app.register(rebalanceRoutes, { prefix: '/bridge' });

      const build = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets',
        payload: targetRequest({
          destinationAddress: ARBITRUM_WALLET,
          destinationChain: 'hyperliquid',
          destinationNetwork: 'mainnet',
        }),
      });
      expect(build.statusCode).toBe(200);
      expect(build.json().stageIndex).toBe(0);

      // Execute stage 0 - handleTransactionExecution returns { status: 1 }
      // so the swap is confirmed immediately, triggering the atomic transition to stage 1
      const firstExecute = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets/target-funding-1/execute',
        headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      });

      expect(firstExecute.statusCode).toBe(200);
      expect(firstExecute.json().status).toBe(0);

      // Verify stage 0 confirmed and stage 1 built atomically
      const persisted = JSON.parse(readFileSync(path.join(stateRoot, 'target-funding-1.json'), 'utf8'));
      expect(persisted.stages[0].status).toBe('confirmed');
      expect(persisted.stages[0].signedTransaction).toBeUndefined();
      expect(persisted.stages[0].transactionHash).toBeDefined();
      expect(persisted.stages[1].status).toBe('built');
      expect(persisted.stages[1].kind).toBe('funding');
      expect(persisted.stages[1].builtRebalance).toBeDefined();
      expect(persisted.stages[1].builtRebalance.provider).toBe('hyperliquid_bridge2');
      expect(persisted.stages[1].builtRebalance.amount).toBe('6.0');
      expect(persisted.activeStageIndex).toBe(1);
      expect(persisted.status).toBe('built');
      expect(persisted.builtRebalance.provider).toBe('hyperliquid_bridge2');
      expect(persisted.provider).toBe('hyperliquid_bridge2');
      await app.close();
    });

    it('completes stage-0 conversion swap and transitions to stage-1 Squid build for Base on confirmed receipt', async () => {
      const signer = new Wallet(`0x${'77'.repeat(32)}`);
      const sendTransaction = jest.fn(async (serialized: string) => ({ hash: utils.keccak256(serialized) }));
      const getTransactionReceipt = jest.fn().mockResolvedValue(null);
      const ethereum = mockEthereumContexts(
        { arbitrum: { gas: '20000000000000000', usdc: '0' } },
        {
          chainId: 42161,
          getWallet: jest.fn(async () => signer),
          handleTransactionExecution: jest.fn(async () => ({ status: 1 })),
          prepareGasOptions: jest.fn(async () => ({ gasLimit: 90000, gasPrice: BigNumber.from(10) })),
          provider: {
            getGasPrice: jest.fn(async () => BigNumber.from('1000000000')),
            getTransactionCount: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2).mockResolvedValueOnce(3),
            getTransactionReceipt,
            sendTransaction,
          },
        },
      );
      const uniswapMock = {
        quoteExactOutputSingle: jest.fn(async () => utils.parseEther('0.005')),
        quoteExactInputSingle: jest.fn(async () => utils.parseUnits('6', 6)),
      };
      (Uniswap.getInstance as jest.Mock).mockResolvedValue(uniswapMock);
      const squidRoute = mockSquidRoute();

      ethereum.arbitrum.getERC20BalanceByAddress
        .mockResolvedValueOnce({ decimals: 6, value: BigNumber.from(0) })
        .mockResolvedValueOnce({ decimals: 6, value: BigNumber.from(0) })
        .mockResolvedValueOnce({ decimals: 6, value: BigNumber.from(0) })
        .mockResolvedValue({ decimals: 6, value: BigNumber.from('8000000') });

      const app = Fastify();
      await app.register(rebalanceRoutes, { prefix: '/bridge' });

      const build = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets',
        payload: targetRequest({
          destinationAddress: BASE_WALLET,
          destinationChain: 'ethereum',
          destinationNetwork: 'base',
        }),
      });
      expect(build.statusCode).toBe(200);
      expect(build.json().stageIndex).toBe(0);

      const firstExecute = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets/target-funding-1/execute',
        headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      });

      expect(firstExecute.statusCode).toBe(200);
      expect(firstExecute.json().status).toBe(0);

      const persisted = JSON.parse(readFileSync(path.join(stateRoot, 'target-funding-1.json'), 'utf8'));
      expect(persisted.stages[0].status).toBe('confirmed');
      expect(persisted.stages[1].status).toBe('built');
      expect(persisted.stages[1].kind).toBe('funding');
      expect(persisted.stages[1].builtRebalance).toBeDefined();
      expect(persisted.stages[1].builtRebalance.provider).toBe('squid_router');
      expect(persisted.stages[1].builtRebalance).toMatchObject({
        amount: '6.0',
        destinationAddress: BASE_WALLET,
        destinationAmount: '6.0',
        destinationAsset: 'USDC',
        destinationChain: 'ethereum',
        destinationNetwork: 'base',
        sourceAmount: '6.0',
      });
      expect(persisted.activeStageIndex).toBe(1);
      expect(persisted.status).toBe('built');
      expect(persisted.builtRebalance.provider).toBe('squid_router');
      expect(persisted.provider).toBe('squid_router');
      expect(JSON.parse(squidRoute.mock.calls[0][1].body)).toMatchObject({
        fromAddress: utils.getAddress(ARBITRUM_WALLET),
        fromAmount: '6000000',
        fromChain: '42161',
        fromToken: ARBITRUM_USDC,
        toAddress: BASE_WALLET,
        toChain: '8453',
        toToken: BASE_USDC,
      });

      const sendsBeforeFunding = sendTransaction.mock.calls.length;
      ethereum.arbitrum.getERC20BalanceByAddress.mockResolvedValue({ decimals: 6, value: BigNumber.from(0) });
      const blockedFunding = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets/target-funding-1/execute',
        headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      });
      expect(blockedFunding.statusCode).toBe(409);
      expect(blockedFunding.json().message).toBe('insufficient_source_or_gas');
      expect(sendTransaction).toHaveBeenCalledTimes(sendsBeforeFunding);
      await app.close();
    });

    it('fails closed on non-positive USDC delta from confirmed stage-0 conversion', async () => {
      const signer = new Wallet(`0x${'bb'.repeat(32)}`);
      const sendTransaction = jest.fn(async (serialized: string) => ({ hash: utils.keccak256(serialized) }));
      const getTransactionReceipt = jest.fn().mockResolvedValue(null);
      const ethereum = mockEthereumContexts(
        { arbitrum: { gas: '20000000000000000', usdc: '0' } },
        {
          chainId: 42161,
          getWallet: jest.fn(async () => signer),
          handleTransactionExecution: jest.fn(async () => ({ status: 1 })),
          prepareGasOptions: jest.fn(async () => ({ gasLimit: 90000, gasPrice: BigNumber.from(10) })),
          provider: {
            getGasPrice: jest.fn(async () => BigNumber.from('1000000000')),
            getTransactionCount: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2),
            getTransactionReceipt,
            sendTransaction,
          },
        },
      );
      (Uniswap.getInstance as jest.Mock).mockResolvedValue({
        quoteExactOutputSingle: jest.fn(async () => utils.parseEther('0.005')),
        quoteExactInputSingle: jest.fn(async () => utils.parseUnits('6', 6)),
      });
      // post-conversion USDC balance same as pre-conversion (0) - will cause non-positive delta
      ethereum.arbitrum.getERC20BalanceByAddress.mockResolvedValue({ decimals: 6, value: BigNumber.from(0) });
      const app = Fastify();
      await app.register(rebalanceRoutes, { prefix: '/bridge' });
      const build = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets',
        payload: targetRequest({
          destinationAddress: ARBITRUM_WALLET,
          destinationChain: 'hyperliquid',
          destinationNetwork: 'mainnet',
        }),
      });
      expect(build.statusCode).toBe(200);

      getTransactionReceipt.mockResolvedValue({ status: 1 });

      const execute = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets/target-funding-1/execute',
        headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      });

      expect(execute.statusCode).toBe(500);
      expect(execute.body).toContain('non-positive USDC output');
      const persisted = JSON.parse(readFileSync(path.join(stateRoot, 'target-funding-1.json'), 'utf8'));
      expect(persisted.stages[0].status).not.toBe('confirmed');
      expect(persisted.activeStageIndex).toBe(0);
      expect(persisted.stages[1].builtRebalance).toBeUndefined();
      expect(sendTransaction).toHaveBeenCalledTimes(3);
      await app.close();
    });

    it('fails closed on under-minimum USDC delta from confirmed stage-0 conversion', async () => {
      const signer = new Wallet(`0x${'cc'.repeat(32)}`);
      const sendTransaction = jest.fn(async (serialized: string) => ({ hash: utils.keccak256(serialized) }));
      const getTransactionReceipt = jest.fn().mockResolvedValue(null);
      const ethereum = mockEthereumContexts(
        { arbitrum: { gas: '20000000000000000', usdc: '0' } },
        {
          chainId: 42161,
          getWallet: jest.fn(async () => signer),
          handleTransactionExecution: jest.fn(async () => ({ status: 1 })),
          prepareGasOptions: jest.fn(async () => ({ gasLimit: 90000, gasPrice: BigNumber.from(10) })),
          provider: {
            getGasPrice: jest.fn(async () => BigNumber.from('1000000000')),
            getTransactionCount: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2),
            getTransactionReceipt,
            sendTransaction,
          },
        },
      );
      (Uniswap.getInstance as jest.Mock).mockResolvedValue({
        quoteExactOutputSingle: jest.fn(async () => utils.parseEther('0.005')),
        quoteExactInputSingle: jest.fn(async () => utils.parseUnits('6', 6)),
      });
      const app = Fastify();
      await app.register(rebalanceRoutes, { prefix: '/bridge' });
      const build = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets',
        payload: targetRequest({
          destinationAddress: ARBITRUM_WALLET,
          destinationChain: 'hyperliquid',
          destinationNetwork: 'mainnet',
        }),
      });
      expect(build.statusCode).toBe(200);

      getTransactionReceipt.mockResolvedValue({ status: 1 });
      ethereum.arbitrum.getERC20BalanceByAddress
        .mockResolvedValueOnce({ decimals: 6, value: BigNumber.from(0) })
        .mockResolvedValue({ decimals: 6, value: BigNumber.from(3) });

      const execute = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets/target-funding-1/execute',
        headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      });

      expect(execute.statusCode).toBe(500);
      expect(execute.body).toContain('below 5 USDC minimum');
      const persisted = JSON.parse(readFileSync(path.join(stateRoot, 'target-funding-1.json'), 'utf8'));
      expect(persisted.activeStageIndex).toBe(0);
      expect(persisted.stages[1].builtRebalance).toBeUndefined();
      expect(sendTransaction).toHaveBeenCalledTimes(3);
      await app.close();
    });

    it('executes Bridge2 in stage 1 and reports source_confirmed on confirmed receipt', async () => {
      const signer = new Wallet(`0x${'dd'.repeat(32)}`);
      const sendTransaction = jest.fn(async (serialized: string) => ({ hash: utils.keccak256(serialized) }));
      const getTransactionReceipt = jest.fn().mockResolvedValue(null);
      const ethereum = mockEthereumContexts(
        { arbitrum: { gas: '20000000000000000', usdc: '0' } },
        {
          chainId: 42161,
          getWallet: jest.fn(async () => signer),
          handleTransactionExecution: jest.fn(async () => ({ status: 1 })),
          prepareGasOptions: jest.fn(async () => ({ gasLimit: 90000, gasPrice: BigNumber.from(10) })),
          provider: {
            getGasPrice: jest.fn(async () => BigNumber.from('1000000000')),
            getTransactionCount: jest
              .fn()
              .mockResolvedValueOnce(1)
              .mockResolvedValueOnce(2)
              .mockResolvedValueOnce(3)
              .mockResolvedValueOnce(4),
            getTransactionReceipt,
            sendTransaction,
          },
        },
      );
      (Uniswap.getInstance as jest.Mock).mockResolvedValue({
        quoteExactOutputSingle: jest.fn(async () => utils.parseEther('0.005')),
        quoteExactInputSingle: jest.fn(async () => utils.parseUnits('6', 6)),
      });
      // Mock post-conversion USDC balance to 6000000 (6 USDC)
      ethereum.arbitrum.getERC20BalanceByAddress
        .mockResolvedValueOnce({ decimals: 6, value: BigNumber.from(0) })
        .mockResolvedValueOnce({ decimals: 6, value: BigNumber.from(0) })
        .mockResolvedValueOnce({ decimals: 6, value: BigNumber.from(0) })
        .mockResolvedValue({ decimals: 6, value: BigNumber.from('8000000') });
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

      getTransactionReceipt.mockResolvedValue({ status: 1 });

      const stage0Execute = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets/target-funding-1/execute',
        headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      });

      expect(stage0Execute.statusCode).toBe(200);

      let persisted = JSON.parse(readFileSync(path.join(stateRoot, 'target-funding-1.json'), 'utf8'));
      expect(persisted.activeStageIndex).toBe(1);
      expect(persisted.stages[1].status).toBe('built');

      // Now execute stage 1 (Bridge2) - prepare for a fresh send
      getTransactionReceipt.mockResolvedValue(null);

      const stage1Execute = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets/target-funding-1/execute',
        headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      });

      expect(stage1Execute.statusCode).toBe(200);
      expect(stage1Execute.json().status).toBe(0);

      persisted = JSON.parse(readFileSync(path.join(stateRoot, 'target-funding-1.json'), 'utf8'));
      expect(persisted.status).toBe('destination_pending');

      // Confirm the receipt
      getTransactionReceipt.mockResolvedValue({ status: 1 });

      const stage1Refresh = await app.inject({
        method: 'GET',
        url: '/bridge/rebalance/target-funding-1',
      });

      expect(stage1Refresh.statusCode).toBe(200);
      const refreshed = stage1Refresh.json();
      expect(refreshed.status).toBe('destination_pending');
      expect(refreshed.stageStatus).toBe('source_confirmed');
      expect(refreshed.stageIndex).toBe(1);
      expect(refreshed.stageCount).toBe(2);
      await app.close();
    });

    it('does not duplicate Bridge2 send on repeated stage-1 execute', async () => {
      const signer = new Wallet(`0x${'ee'.repeat(32)}`);
      const signTransaction = jest.spyOn(signer, 'signTransaction');
      const sendTransaction = jest.fn(async (serialized: string) => ({ hash: utils.keccak256(serialized) }));
      const getTransactionReceipt = jest.fn().mockResolvedValue(null);
      const ethereum = mockEthereumContexts(
        { arbitrum: { gas: '20000000000000000', usdc: '0' } },
        {
          chainId: 42161,
          getWallet: jest.fn(async () => signer),
          handleTransactionExecution: jest.fn(async () => ({ status: 1 })),
          prepareGasOptions: jest.fn(async () => ({ gasLimit: 90000, gasPrice: BigNumber.from(10) })),
          provider: {
            getGasPrice: jest.fn(async () => BigNumber.from('1000000000')),
            getTransactionCount: jest
              .fn()
              .mockResolvedValueOnce(1)
              .mockResolvedValueOnce(2)
              .mockResolvedValueOnce(3)
              .mockResolvedValueOnce(4),
            getTransactionReceipt,
            sendTransaction,
          },
        },
      );
      (Uniswap.getInstance as jest.Mock).mockResolvedValue({
        quoteExactOutputSingle: jest.fn(async () => utils.parseEther('0.005')),
        quoteExactInputSingle: jest.fn(async () => utils.parseUnits('6', 6)),
      });
      // Mock post-conversion USDC balance to 6000000 (6 USDC)
      ethereum.arbitrum.getERC20BalanceByAddress
        .mockResolvedValueOnce({ decimals: 6, value: BigNumber.from(0) })
        .mockResolvedValueOnce({ decimals: 6, value: BigNumber.from(0) })
        .mockResolvedValueOnce({ decimals: 6, value: BigNumber.from(0) })
        .mockResolvedValue({ decimals: 6, value: BigNumber.from('8000000') });
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

      getTransactionReceipt.mockResolvedValue({ status: 1 });
      await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets/target-funding-1/execute',
        headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      });
      getTransactionReceipt.mockResolvedValue(null);

      // First stage 1 execute
      const firstSend = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets/target-funding-1/execute',
        headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      });
      const firstSignature = firstSend.json().signature;
      const signaturesAfterFirstSend = signTransaction.mock.calls.length;
      const firstStage1Bytes = sendTransaction.mock.calls.at(-1)?.[0];

      // Second stage 1 execute - should not send again
      const secondSend = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets/target-funding-1/execute',
        headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      });

      expect(firstSend.statusCode).toBe(200);
      expect(secondSend.statusCode).toBe(200);
      expect(secondSend.json().signature).toBe(firstSignature);
      expect(secondSend.json().status).toBe(0);
      expect(signTransaction).toHaveBeenCalledTimes(signaturesAfterFirstSend);
      expect(sendTransaction.mock.calls.at(-1)?.[0]).toBe(firstStage1Bytes);
      await app.close();
    });

    it('preserves source_confirmed status on GET after confirmed stage-1 receipt', async () => {
      const signer = new Wallet(`0x${'ff'.repeat(32)}`);
      const sendTransaction = jest.fn(async (serialized: string) => ({ hash: utils.keccak256(serialized) }));
      const getTransactionReceipt = jest.fn().mockResolvedValue(null);
      const ethereum = mockEthereumContexts(
        { arbitrum: { gas: '20000000000000000', usdc: '0' } },
        {
          chainId: 42161,
          getWallet: jest.fn(async () => signer),
          handleTransactionExecution: jest.fn(async () => ({ status: 1 })),
          prepareGasOptions: jest.fn(async () => ({ gasLimit: 90000, gasPrice: BigNumber.from(10) })),
          provider: {
            getGasPrice: jest.fn(async () => BigNumber.from('1000000000')),
            getTransactionCount: jest
              .fn()
              .mockResolvedValueOnce(1)
              .mockResolvedValueOnce(2)
              .mockResolvedValueOnce(3)
              .mockResolvedValueOnce(4),
            getTransactionReceipt,
            sendTransaction,
          },
        },
      );
      (Uniswap.getInstance as jest.Mock).mockResolvedValue({
        quoteExactOutputSingle: jest.fn(async () => utils.parseEther('0.005')),
        quoteExactInputSingle: jest.fn(async () => utils.parseUnits('6', 6)),
      });
      // Mock post-conversion USDC balance to 6000000 (6 USDC)
      ethereum.arbitrum.getERC20BalanceByAddress
        .mockResolvedValueOnce({ decimals: 6, value: BigNumber.from(0) })
        .mockResolvedValueOnce({ decimals: 6, value: BigNumber.from(0) })
        .mockResolvedValueOnce({ decimals: 6, value: BigNumber.from(0) })
        .mockResolvedValue({ decimals: 6, value: BigNumber.from('8000000') });
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

      getTransactionReceipt.mockResolvedValue({ status: 1 });
      await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets/target-funding-1/execute',
        headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      });
      getTransactionReceipt.mockResolvedValue(null);

      const stage1 = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets/target-funding-1/execute',
        headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      });
      expect(stage1.statusCode).toBe(200);

      getTransactionReceipt.mockResolvedValue({ status: 1 });
      const statusAfter = await app.inject({
        method: 'GET',
        url: '/bridge/rebalance/target-funding-1',
      });

      expect(statusAfter.statusCode).toBe(200);
      const body = statusAfter.json();
      expect(body.status).toBe('destination_pending');
      expect(body.stageStatus).toBe('source_confirmed');
      expect(body.stageIndex).toBe(1);
      expect(body.stageCount).toBe(2);

      const statusAgain = await app.inject({
        method: 'GET',
        url: '/bridge/rebalance/target-funding-1',
      });
      expect(statusAgain.json().status).toBe('destination_pending');
      expect(statusAgain.json().stageStatus).toBe('source_confirmed');
      await app.close();
    });

    it('rebuilds expired stage-0 quote through buildProviderTreasurySameChainSwap before signing', async () => {
      const signer = new Wallet(`0x${'99'.repeat(32)}`);
      const sendTransaction = jest.fn(async (serialized: string) => ({ hash: utils.keccak256(serialized) }));
      const getTransactionReceipt = jest.fn().mockResolvedValue(null);
      const ethereum = mockEthereumContexts(
        { arbitrum: { gas: '20000000000000000', usdc: '0' } },
        {
          chainId: 42161,
          getWallet: jest.fn(async () => signer),
          handleTransactionExecution: jest.fn(async () => ({ status: 1 })),
          prepareGasOptions: jest.fn(async () => ({ gasLimit: 90000, gasPrice: BigNumber.from(10) })),
          provider: {
            getGasPrice: jest.fn(async () => BigNumber.from('1000000000')),
            getTransactionCount: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2),
            getTransactionReceipt,
            sendTransaction,
          },
        },
      );
      const uniswapMock = {
        quoteExactOutputSingle: jest.fn(async () => utils.parseEther('0.005')),
        quoteExactInputSingle: jest.fn(async () => utils.parseUnits('6', 6)),
      };
      (Uniswap.getInstance as jest.Mock).mockResolvedValue(uniswapMock);
      // Mock post-conversion USDC balance to 6000000 (6 USDC)
      ethereum.arbitrum.getERC20BalanceByAddress
        .mockResolvedValueOnce({ decimals: 6, value: BigNumber.from(0) })
        .mockResolvedValueOnce({ decimals: 6, value: BigNumber.from(0) })
        .mockResolvedValueOnce({ decimals: 6, value: BigNumber.from(0) })
        .mockResolvedValue({ decimals: 6, value: BigNumber.from('8000000') });
      const app = Fastify();
      await app.register(rebalanceRoutes, { prefix: '/bridge' });
      const build = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets',
        payload: targetRequest({
          destinationAddress: ARBITRUM_WALLET,
          destinationChain: 'hyperliquid',
          destinationNetwork: 'mainnet',
        }),
      });
      expect(build.statusCode).toBe(200);

      const persisted = JSON.parse(readFileSync(path.join(stateRoot, 'target-funding-1.json'), 'utf8'));
      const oldQuoteTimestamp = new Date(Date.now() - 120_000).toISOString();
      persisted.stages[0].builtRebalance.quotedAt = oldQuoteTimestamp;
      persisted.builtRebalance.quotedAt = oldQuoteTimestamp;
      persisted.stages[0].fingerprint = utils.keccak256(
        utils.toUtf8Bytes(JSON.stringify(persisted.stages[0].builtRebalance)),
      );
      writeFileSync(path.join(stateRoot, 'target-funding-1.json'), JSON.stringify(persisted));

      expect(uniswapMock.quoteExactInputSingle).toHaveBeenCalledTimes(1);

      const execute = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets/target-funding-1/execute',
        headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      });

      expect(execute.statusCode).toBe(200);
      expect(uniswapMock.quoteExactInputSingle).toHaveBeenCalledTimes(2);
      await app.close();
    });
  });

  describe('two-stage target plan state', () => {
    it('exposes neutral stage progress on target build and status without provider internals', async () => {
      mockEthereumContexts({ arbitrum: { gas: '20000000000000000', usdc: '0' } });
      (Uniswap.getInstance as jest.Mock).mockResolvedValue({
        quoteExactOutputSingle: jest.fn(async () => utils.parseEther('0.005')),
        quoteExactInputSingle: jest.fn(async () => utils.parseUnits('6', 6)),
      });
      const app = Fastify();
      await app.register(rebalanceRoutes, { prefix: '/bridge' });

      const buildResponse = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets',
        payload: targetRequest({
          destinationAddress: ARBITRUM_WALLET,
          destinationChain: 'hyperliquid',
          destinationNetwork: 'mainnet',
        }),
      });

      expect(buildResponse.statusCode).toBe(200);
      expect(buildResponse.json().stages).toEqual([
        {
          destinationAmount: '6.0',
          destinationAsset: 'USDC',
          index: 0,
          kind: 'conversion',
          sourceAmount: '0.005',
          sourceAsset: 'ETH',
          status: 'built',
        },
        { index: 1, kind: 'funding', status: 'blocked_on_prior_stage' },
      ]);

      const statePath = path.join(stateRoot, 'target-funding-1.json');
      const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
      persisted.stages[0].approvalTransactionHash = '0xapproval';
      persisted.stages[0].wrapTransactionHash = '0xwrap';
      persisted.stages[0].providerError = 'token=stage-secret provider failure';
      writeFileSync(statePath, JSON.stringify(persisted));

      const statusResponse = await app.inject({ method: 'GET', url: '/bridge/rebalance/target-funding-1' });

      expect(statusResponse.statusCode).toBe(200);
      expect(statusResponse.json().stages).toEqual([
        {
          destinationAmount: '6.0',
          destinationAsset: 'USDC',
          error: 'token [redacted] provider failure',
          index: 0,
          kind: 'conversion',
          sourceAmount: '0.005',
          sourceAsset: 'ETH',
          status: 'built',
          transactionHash: '0xapproval',
        },
        { index: 1, kind: 'funding', status: 'blocked_on_prior_stage' },
      ]);
      expect(statusResponse.json().stages[0].provider).toBeUndefined();
      expect(statusResponse.json().stages[0].providerError).toBeUndefined();
      expect(statusResponse.json().stages[0].builtRebalance).toBeUndefined();

      delete persisted.stages[0].approvalTransactionHash;
      writeFileSync(statePath, JSON.stringify(persisted));
      const wrapStatusResponse = await app.inject({ method: 'GET', url: '/bridge/rebalance/target-funding-1' });
      expect(wrapStatusResponse.json().stages[0].transactionHash).toBe('0xwrap');

      persisted.stages[0].transactionHash = '0xstage0';
      writeFileSync(statePath, JSON.stringify(persisted));
      const transactionStatusResponse = await app.inject({ method: 'GET', url: '/bridge/rebalance/target-funding-1' });
      expect(transactionStatusResponse.json().stages[0].transactionHash).toBe('0xstage0');
      await app.close();
    });

    it('rejects a plan whose conversion stage uses the funding provider', async () => {
      mockEthereumContexts({ arbitrum: { gas: '3000000000000000', usdc: '6000000' } });
      const app = Fastify();
      await app.register(rebalanceRoutes, { prefix: '/bridge' });
      const buildResponse = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets',
        payload: targetRequest({
          destinationAddress: ARBITRUM_WALLET,
          destinationChain: 'hyperliquid',
          destinationNetwork: 'mainnet',
        }),
      });
      expect(buildResponse.statusCode).toBe(200);
      const statePath = path.join(stateRoot, 'target-funding-1.json');
      const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
      persisted.planVersion = 1;
      persisted.activeStageIndex = 0;
      persisted.stages = [
        {
          index: 0,
          kind: 'conversion',
          status: 'built',
          builtRebalance: persisted.builtRebalance,
          fingerprint: utils.keccak256(utils.toUtf8Bytes(JSON.stringify(persisted.builtRebalance))),
        },
        { index: 1, kind: 'funding', status: 'blocked_on_prior_stage' },
      ];
      writeFileSync(statePath, JSON.stringify(persisted));

      const reload = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets',
        payload: targetRequest({
          destinationAddress: ARBITRUM_WALLET,
          destinationChain: 'hyperliquid',
          destinationNetwork: 'mainnet',
        }),
      });
      expect(reload.statusCode).toBe(500);
      expect(reload.body).toContain('invalid target plan topology');
      await app.close();
    });

    it('rejects a Squid plan whose funding stage uses Bridge2 (provider does not match planTarget)', async () => {
      mockEthereumContexts({ arbitrum: { gas: '20000000000000000', usdc: '0' } });
      (Uniswap.getInstance as jest.Mock).mockResolvedValue({
        quoteExactOutputSingle: jest.fn(async () => utils.parseEther('0.005')),
        quoteExactInputSingle: jest.fn(async () => utils.parseUnits('6', 6)),
      });
      const app = Fastify();
      await app.register(rebalanceRoutes, { prefix: '/bridge' });
      const buildResponse = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets',
        payload: targetRequest({
          destinationAddress: BASE_WALLET,
          destinationChain: 'ethereum',
          destinationNetwork: 'base',
        }),
      });
      expect(buildResponse.statusCode).toBe(200);
      const statePath = path.join(stateRoot, 'target-funding-1.json');
      const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
      persisted.planVersion = 1;
      persisted.activeStageIndex = 0;
      persisted.stages = [
        {
          index: 0,
          kind: 'conversion',
          status: 'built',
          builtRebalance: persisted.builtRebalance,
          fingerprint: utils.keccak256(utils.toUtf8Bytes(JSON.stringify(persisted.builtRebalance))),
        },
        {
          index: 1,
          kind: 'funding',
          status: 'built',
          builtRebalance: { ...persisted.builtRebalance, provider: 'hyperliquid_bridge2' },
          fingerprint: utils.keccak256(
            utils.toUtf8Bytes(JSON.stringify({ ...persisted.builtRebalance, provider: 'hyperliquid_bridge2' })),
          ),
        },
      ];
      persisted.planTarget = {
        ...persisted.planTarget,
        destinationChain: 'ethereum',
        destinationNetwork: 'base',
      };
      writeFileSync(statePath, JSON.stringify(persisted));

      const reload = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets',
        payload: targetRequest({
          destinationAddress: BASE_WALLET,
          destinationChain: 'ethereum',
          destinationNetwork: 'base',
        }),
      });
      expect(reload.statusCode).toBe(500);
      expect(reload.body).toContain('invalid target plan topology');
      await app.close();
    });

    it('rejects a plan whose funding stage uses Squid for a Hyperliquid target', async () => {
      mockEthereumContexts({ arbitrum: { gas: '20000000000000000', usdc: '0' } });
      (Uniswap.getInstance as jest.Mock).mockResolvedValue({
        quoteExactOutputSingle: jest.fn(async () => utils.parseEther('0.005')),
        quoteExactInputSingle: jest.fn(async () => utils.parseUnits('6', 6)),
      });
      const app = Fastify();
      await app.register(rebalanceRoutes, { prefix: '/bridge' });
      const buildResponse = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets',
        payload: targetRequest({
          destinationAddress: ARBITRUM_WALLET,
          destinationChain: 'hyperliquid',
          destinationNetwork: 'mainnet',
        }),
      });
      expect(buildResponse.statusCode).toBe(200);
      const statePath = path.join(stateRoot, 'target-funding-1.json');
      const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
      persisted.planVersion = 1;
      persisted.activeStageIndex = 0;
      persisted.stages = [
        {
          index: 0,
          kind: 'conversion',
          status: 'built',
          builtRebalance: persisted.builtRebalance,
          fingerprint: utils.keccak256(utils.toUtf8Bytes(JSON.stringify(persisted.builtRebalance))),
        },
        {
          index: 1,
          kind: 'funding',
          status: 'built',
          builtRebalance: { ...persisted.builtRebalance, provider: 'squid_router' },
          fingerprint: utils.keccak256(
            utils.toUtf8Bytes(JSON.stringify({ ...persisted.builtRebalance, provider: 'squid_router' })),
          ),
        },
      ];
      persisted.planTarget = {
        ...persisted.planTarget,
        destinationChain: 'hyperliquid',
        destinationNetwork: 'mainnet',
      };
      writeFileSync(statePath, JSON.stringify(persisted));

      const reload = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets',
        payload: targetRequest({
          destinationAddress: ARBITRUM_WALLET,
          destinationChain: 'hyperliquid',
          destinationNetwork: 'mainnet',
        }),
      });
      expect(reload.statusCode).toBe(500);
      expect(reload.body).toContain('invalid target plan topology');
      await app.close();
    });

    it('rejects plan with invalid version on reload', async () => {
      mockEthereumContexts({ arbitrum: { gas: '3000000000000000', usdc: '6000000' } });
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
      persisted.planVersion = 0;
      persisted.activeStageIndex = 0;
      persisted.stages = [{ index: 0, kind: 'conversion', status: 'built' }];
      writeFileSync(statePath, JSON.stringify(persisted));

      const reload = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets',
        payload: targetRequest({
          destinationAddress: ARBITRUM_WALLET,
          destinationChain: 'hyperliquid',
          destinationNetwork: 'mainnet',
        }),
      });
      expect(reload.statusCode).toBe(500);
      expect(reload.body).toContain('invalid target plan version');
      await app.close();
    });

    it('rejects plan with invalid stage order', async () => {
      mockEthereumContexts({ arbitrum: { gas: '3000000000000000', usdc: '6000000' } });
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
      persisted.planVersion = 1;
      persisted.activeStageIndex = 0;
      persisted.stages = [
        { index: 1, kind: 'conversion', status: 'built' },
        { index: 0, kind: 'funding', status: 'blocked_on_prior_stage' },
      ];
      writeFileSync(statePath, JSON.stringify(persisted));

      const reload = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets',
        payload: targetRequest({
          destinationAddress: ARBITRUM_WALLET,
          destinationChain: 'hyperliquid',
          destinationNetwork: 'mainnet',
        }),
      });
      expect(reload.statusCode).toBe(500);
      expect(reload.body).toContain('invalid target plan stage order');
      await app.close();
    });

    it('rejects plan with more than two stages', async () => {
      mockEthereumContexts({ arbitrum: { gas: '3000000000000000', usdc: '6000000' } });
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
      persisted.planVersion = 1;
      persisted.activeStageIndex = 0;
      persisted.stages = [
        { index: 0, kind: 'conversion', status: 'built' },
        { index: 1, kind: 'funding', status: 'built' },
        { index: 2, kind: 'funding', status: 'built' },
      ];
      writeFileSync(statePath, JSON.stringify(persisted));

      const reload = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets',
        payload: targetRequest({
          destinationAddress: ARBITRUM_WALLET,
          destinationChain: 'hyperliquid',
          destinationNetwork: 'mainnet',
        }),
      });
      expect(reload.statusCode).toBe(500);
      expect(reload.body).toContain('invalid target plan stage count');
      await app.close();
    });

    it('rejects plan with tampered stage build fingerprint', async () => {
      mockEthereumContexts({ arbitrum: { gas: '3000000000000000', usdc: '6000000' } });
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
      persisted.planVersion = 1;
      persisted.activeStageIndex = 0;
      persisted.stages = [
        {
          index: 0,
          kind: 'conversion',
          status: 'built',
          builtRebalance: { ...persisted.builtRebalance, destinationAmount: '9.9' },
          fingerprint: utils.keccak256(utils.toUtf8Bytes(JSON.stringify(persisted.builtRebalance))),
        },
        { index: 1, kind: 'funding', status: 'blocked_on_prior_stage' },
      ];
      writeFileSync(statePath, JSON.stringify(persisted));

      const reload = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets',
        payload: targetRequest({
          destinationAddress: ARBITRUM_WALLET,
          destinationChain: 'hyperliquid',
          destinationNetwork: 'mainnet',
        }),
      });
      expect(reload.statusCode).toBe(500);
      expect(reload.body).toContain('target plan stage fingerprint mismatch');
      await app.close();
    });

    it('does not add stage projection fields for a direct funded target without plan fields', async () => {
      mockEthereumContexts({ arbitrum: { gas: '3000000000000000', usdc: '6000000' } });
      const app = Fastify();
      await app.register(rebalanceRoutes, { prefix: '/bridge' });
      const buildResponse = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets',
        payload: targetRequest({
          destinationAddress: ARBITRUM_WALLET,
          destinationChain: 'hyperliquid',
          destinationNetwork: 'mainnet',
        }),
      });
      expect(buildResponse.statusCode).toBe(200);
      const body = buildResponse.json();
      expect(body.stageIndex).toBeUndefined();
      expect(body.stageCount).toBeUndefined();
      expect(body.stageStatus).toBeUndefined();
      expect(body.stages).toBeUndefined();

      const statusResponse = await app.inject({ method: 'GET', url: '/bridge/rebalance/target-funding-1' });
      expect(statusResponse.statusCode).toBe(200);
      const statusBody = statusResponse.json();
      expect(statusBody.stageIndex).toBeUndefined();
      expect(statusBody.stageCount).toBeUndefined();
      expect(statusBody.stageStatus).toBeUndefined();
      expect(statusBody.stages).toBeUndefined();
      await app.close();
    });
  });

  describe('Mayan target funding for canonical SOL on Solana', () => {
    const { buildMayanSwap, getMayanStatus } = require('../../src/bridge/providers/mayan');

    it('builds a fixed 0.0005 ETH Mayan FAST_MCTP swap for solana/mainnet-beta/SOL', async () => {
      const ethereum = mockEthereumContexts({ arbitrum: { gas: '20000000000000000', usdc: '0' } });
      const app = Fastify();
      await app.register(rebalanceRoutes, { prefix: '/bridge' });
      const response = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets',
        payload: {
          targetNotionalEur: '1',
          destinationAddress: SOLANA_WALLET,
          destinationAsset: 'SOL',
          destinationChain: 'solana',
          destinationNetwork: 'mainnet-beta',
          idempotencyKey: 'mayan-funding-1',
          mode: 'mainnet',
        },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.provider).toBe('mayan');
      expect(body.sourceAsset).toBe('ETH');
      expect(body.sourceNetwork).toBe('arbitrum');
      expect(body.destinationAsset).toBe('SOL');
      expect(body.destinationChain).toBe('solana');
      expect(body.destinationNetwork).toBe('mainnet-beta');
      expect(body.destinationAddress).toBe(SOLANA_WALLET);
      expect(body.sourceAmount).toBe('0.0005');
      expect(body.amount).toBe('0.0005');
      expect(body.txTarget).toBe('0x337685fdaB40D39bd02028545a4FfA7D287cC3E2');
      expect(body.walletAddress).toBe(utils.getAddress(ARBITRUM_WALLET));
      expect(body.quoteId).toBe('mayan-quote-1');
      expect(buildMayanSwap).toHaveBeenCalledWith({
        sourceAddress: utils.getAddress(ARBITRUM_WALLET),
        destinationAddress: SOLANA_WALLET,
        amount: '0.0005',
      });
      expect(ethereum.arbitrum.getNativeBalanceByAddress).toHaveBeenCalledWith(utils.getAddress(ARBITRUM_WALLET));
      const persisted = JSON.parse(readFileSync(path.join(stateRoot, 'mayan-funding-1.json'), 'utf8'));
      expect(persisted.provider).toBe('mayan');
      expect(persisted.builtRebalance.provider).toBe('mayan');
      expect(persisted.builtRebalance.sourceAmount).toBe('0.0005');
      expect(persisted.builtRebalance.routePayload).toBeDefined();
      expect(persisted.builtRebalance.routePayloadHash).toBeDefined();
      await app.close();
    });

    it('rejects when source wallet has insufficient native ETH for 0.0005 txValue plus gas reserve', async () => {
      const ethereum = mockEthereumContexts({ arbitrum: { gas: '1099999999999999', usdc: '0' } });
      const app = Fastify();
      await app.register(rebalanceRoutes, { prefix: '/bridge' });
      const response = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets',
        payload: {
          targetNotionalEur: '1',
          destinationAddress: SOLANA_WALLET,
          destinationAsset: 'SOL',
          destinationChain: 'solana',
          destinationNetwork: 'mainnet-beta',
          idempotencyKey: 'mayan-funding-2',
          mode: 'mainnet',
        },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().message).toBe('insufficient_source_or_gas');
      expect(ethereum.arbitrum.getWallet).not.toHaveBeenCalled();
      expect(() => readFileSync(path.join(stateRoot, 'mayan-funding-2.json'))).toThrow();
      await app.close();
    });

    it('rejects a Mayan build whose native value differs from the fixed source amount', async () => {
      const baseBuild = await buildMayanSwap({
        sourceAddress: utils.getAddress(ARBITRUM_WALLET),
        destinationAddress: SOLANA_WALLET,
        amount: '0.0005',
      });
      buildMayanSwap.mockResolvedValueOnce({ ...baseBuild, txValue: '500000000000001' });
      mockEthereumContexts({ arbitrum: { gas: '20000000000000000', usdc: '0' } });
      const app = Fastify();
      await app.register(rebalanceRoutes, { prefix: '/bridge' });
      const response = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets',
        payload: {
          targetNotionalEur: '1',
          destinationAddress: SOLANA_WALLET,
          destinationAsset: 'SOL',
          destinationChain: 'solana',
          destinationNetwork: 'mainnet-beta',
          idempotencyKey: 'mayan-funding-wrong-value',
          mode: 'mainnet',
        },
      });
      expect(response.statusCode).toBe(500);
      expect(response.body).toContain('mayan source amount must equal fixed target amount');
      expect(() => readFileSync(path.join(stateRoot, 'mayan-funding-wrong-value.json'))).toThrow();
      await app.close();
    });

    it('executes a persisted Mayan build and checks source receipt', async () => {
      const signer = new Wallet(`0x${'88'.repeat(32)}`);
      const signTransaction = jest.spyOn(signer, 'signTransaction');
      const sendTransaction = jest.fn(async (serialized: string) => ({ hash: utils.keccak256(serialized) }));
      const getTransactionReceipt = jest.fn().mockResolvedValue(null);
      const ethereum = mockEthereumContexts(
        { arbitrum: { gas: '20000000000000000', usdc: '0' } },
        {
          chainId: 42161,
          getWallet: jest.fn(async () => signer),
          handleTransactionExecution: jest.fn(async () => ({ status: 1 })),
          prepareGasOptions: jest.fn(async () => ({ gasLimit: 500000, gasPrice: BigNumber.from(10) })),
          provider: {
            getGasPrice: jest.fn(async () => BigNumber.from('1000000000')),
            getTransactionCount: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2),
            getTransactionReceipt,
            sendTransaction,
          },
        },
      );
      const app = Fastify();
      await app.register(rebalanceRoutes, { prefix: '/bridge' });
      const build = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets',
        payload: {
          targetNotionalEur: '1',
          destinationAddress: SOLANA_WALLET,
          destinationAsset: 'SOL',
          destinationChain: 'solana',
          destinationNetwork: 'mainnet-beta',
          idempotencyKey: 'mayan-funding-3',
          mode: 'mainnet',
        },
      });
      expect(build.statusCode).toBe(200);

      const execute = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets/mayan-funding-3/execute',
        headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      });
      expect(execute.statusCode).toBe(200);
      expect(execute.json().status).toBe(0);

      const persisted = JSON.parse(readFileSync(path.join(stateRoot, 'mayan-funding-3.json'), 'utf8'));
      expect(persisted.status).toBe('submitted');
      expect(persisted.transactionHash).toBeDefined();
      expect(sendTransaction).toHaveBeenCalledTimes(1);
      const sent = utils.parseTransaction(sendTransaction.mock.calls[0][0]);
      expect(sent.to).toBe(utils.getAddress('0x337685fdaB40D39bd02028545a4FfA7D287cC3E2'));
      expect(sent.data).toBe('0xabcdef');
      expect(sent.value.eq('500000000000000')).toBe(true);
      expect(ethereum.arbitrum.prepareGasOptions.mock.calls[0][1]).toBe(500000);
      expect(ethereum.arbitrum.prepareGasOptions.mock.calls[0][3]).toBe('mayan_rebalance');

      await app.close();
      const resumedApp = Fastify();
      await resumedApp.register(rebalanceRoutes, { prefix: '/bridge' });
      const retry = await resumedApp.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets/mayan-funding-3/execute',
        headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      });
      expect(retry.json().signature).toBe(execute.json().signature);
      expect(signTransaction).toHaveBeenCalledTimes(1);
      expect(sendTransaction).toHaveBeenCalledTimes(2);
      expect(sendTransaction.mock.calls[1][0]).toBe(sendTransaction.mock.calls[0][0]);
      expect(buildMayanSwap).toHaveBeenCalledTimes(1);

      // After source receipt is confirmed by fresh read and Mayan confirmed, status becomes confirmed
      getTransactionReceipt.mockResolvedValue({ status: 1 });
      const refreshed = await resumedApp.inject({ method: 'GET', url: '/bridge/rebalance/mayan-funding-3' });
      expect(refreshed.json().status).toBe('confirmed');
      await resumedApp.close();
    });

    it('marks status confirmed when Mayan explorer reports settled after source receipt', async () => {
      getMayanStatus.mockResolvedValue({ status: 'confirmed', providerStatus: 'settled' });
      const signer = new Wallet(`0x${'99'.repeat(32)}`);
      const sendTransaction = jest.fn(async (serialized: string) => ({ hash: utils.keccak256(serialized) }));
      const getTransactionReceipt = jest.fn().mockResolvedValue(null);
      const ethereum = mockEthereumContexts(
        { arbitrum: { gas: '20000000000000000', usdc: '0' } },
        {
          chainId: 42161,
          getWallet: jest.fn(async () => signer),
          handleTransactionExecution: jest.fn(async () => ({ status: 1 })),
          prepareGasOptions: jest.fn(async () => ({ gasLimit: 500000, gasPrice: BigNumber.from(10) })),
          provider: {
            getGasPrice: jest.fn(async () => BigNumber.from('1000000000')),
            getTransactionCount: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2),
            getTransactionReceipt,
            sendTransaction,
          },
        },
      );
      const app = Fastify();
      await app.register(rebalanceRoutes, { prefix: '/bridge' });
      await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets',
        payload: {
          targetNotionalEur: '1',
          destinationAddress: SOLANA_WALLET,
          destinationAsset: 'SOL',
          destinationChain: 'solana',
          destinationNetwork: 'mainnet-beta',
          idempotencyKey: 'mayan-funding-4',
          mode: 'mainnet',
        },
      });
      await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets/mayan-funding-4/execute',
        headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      });
      // Mock receipt confirmed so refreshRebalanceStatus enters destination_pending and Mayan status polling
      getTransactionReceipt.mockResolvedValue({ status: 1 });
      const statusAfterTx = await app.inject({ method: 'GET', url: '/bridge/rebalance/mayan-funding-4' });
      expect(statusAfterTx.statusCode).toBe(200);
      expect(statusAfterTx.json().status).toBe('confirmed');
      expect(statusAfterTx.json().providerStatus).toBe('settled');
      expect(statusAfterTx.json().provider).toBe('mayan');
      await app.close();
    });

    it('marks status failed when Mayan explorer reports failed after source receipt', async () => {
      getMayanStatus.mockResolvedValue({ status: 'failed', providerStatus: 'REFUNDED' });
      const signer = new Wallet(`0x${'aa'.repeat(32)}`);
      const sendTransaction = jest.fn(async (serialized: string) => ({ hash: utils.keccak256(serialized) }));
      const getTransactionReceipt = jest.fn().mockResolvedValue(null);
      mockEthereumContexts(
        { arbitrum: { gas: '20000000000000000', usdc: '0' } },
        {
          chainId: 42161,
          getWallet: jest.fn(async () => signer),
          handleTransactionExecution: jest.fn(async () => ({ status: 1 })),
          prepareGasOptions: jest.fn(async () => ({ gasLimit: 500000, gasPrice: BigNumber.from(10) })),
          provider: {
            getGasPrice: jest.fn(async () => BigNumber.from('1000000000')),
            getTransactionCount: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2),
            getTransactionReceipt,
            sendTransaction,
          },
        },
      );
      const app = Fastify();
      await app.register(rebalanceRoutes, { prefix: '/bridge' });
      await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets',
        payload: {
          targetNotionalEur: '1',
          destinationAddress: SOLANA_WALLET,
          destinationAsset: 'SOL',
          destinationChain: 'solana',
          destinationNetwork: 'mainnet-beta',
          idempotencyKey: 'mayan-funding-5',
          mode: 'mainnet',
        },
      });
      await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets/mayan-funding-5/execute',
        headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      });
      getTransactionReceipt.mockResolvedValue({ status: 1 });
      const statusAfterTx = await app.inject({ method: 'GET', url: '/bridge/rebalance/mayan-funding-5' });
      expect(statusAfterTx.statusCode).toBe(200);
      expect(statusAfterTx.json().status).toBe('failed');
      await app.close();
    });

    it('stays nonterminal when Mayan explorer reports pending after source receipt', async () => {
      getMayanStatus.mockResolvedValue({ status: 'pending', providerStatus: 'in_progress' });
      const signer = new Wallet(`0x${'bb'.repeat(32)}`);
      const sendTransaction = jest.fn(async (serialized: string) => ({ hash: utils.keccak256(serialized) }));
      const getTransactionReceipt = jest.fn().mockResolvedValue(null);
      mockEthereumContexts(
        { arbitrum: { gas: '20000000000000000', usdc: '0' } },
        {
          chainId: 42161,
          getWallet: jest.fn(async () => signer),
          handleTransactionExecution: jest.fn(async () => ({ status: 1 })),
          prepareGasOptions: jest.fn(async () => ({ gasLimit: 500000, gasPrice: BigNumber.from(10) })),
          provider: {
            getGasPrice: jest.fn(async () => BigNumber.from('1000000000')),
            getTransactionCount: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2),
            getTransactionReceipt,
            sendTransaction,
          },
        },
      );
      const app = Fastify();
      await app.register(rebalanceRoutes, { prefix: '/bridge' });
      await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets',
        payload: {
          targetNotionalEur: '1',
          destinationAddress: SOLANA_WALLET,
          destinationAsset: 'SOL',
          destinationChain: 'solana',
          destinationNetwork: 'mainnet-beta',
          idempotencyKey: 'mayan-funding-6',
          mode: 'mainnet',
        },
      });
      await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets/mayan-funding-6/execute',
        headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      });
      getTransactionReceipt.mockResolvedValue({ status: 1 });
      const statusAfterTx = await app.inject({ method: 'GET', url: '/bridge/rebalance/mayan-funding-6' });
      expect(statusAfterTx.statusCode).toBe(200);
      expect(statusAfterTx.json().status).toBe('destination_pending');
      await app.close();
    });

    it('rejects caller-supplied provider, source, and wallet authority fields for Mayan', async () => {
      mockEthereumContexts({ arbitrum: { gas: '20000000000000000', usdc: '0' } });
      const app = Fastify();
      await app.register(rebalanceRoutes, { prefix: '/bridge' });
      const response = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets',
        payload: {
          targetNotionalEur: '1',
          destinationAddress: SOLANA_WALLET,
          destinationAsset: 'SOL',
          destinationChain: 'solana',
          destinationNetwork: 'mainnet-beta',
          idempotencyKey: 'mayan-funding-7',
          mode: 'mainnet',
          provider: 'mayan',
        },
      });
      expect(response.statusCode).toBe(400);
      await app.close();
    });

    it('rejects Mayan execute when deadline is expired', async () => {
      const signer = new Wallet(`0x${'cc'.repeat(32)}`);
      const sendTransaction = jest.fn();
      const ethereum = mockEthereumContexts(
        { arbitrum: { gas: '20000000000000000', usdc: '0' } },
        { getWallet: jest.fn(async () => signer) },
      );
      const app = Fastify();
      await app.register(rebalanceRoutes, { prefix: '/bridge' });
      const baseBuild = await buildMayanSwap({
        sourceAddress: utils.getAddress(ARBITRUM_WALLET),
        destinationAddress: SOLANA_WALLET,
        amount: '0.0005',
      });
      const deadline = Math.floor(Date.now() / 1000) + 60;
      buildMayanSwap.mockResolvedValueOnce({ ...baseBuild, deadline });
      await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets',
        payload: {
          targetNotionalEur: '1',
          destinationAddress: SOLANA_WALLET,
          destinationAsset: 'SOL',
          destinationChain: 'solana',
          destinationNetwork: 'mainnet-beta',
          idempotencyKey: 'mayan-funding-expired-deadline',
          mode: 'mainnet',
        },
      });
      const now = jest.spyOn(Date, 'now').mockReturnValue((deadline + 1) * 1000);
      const execute = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets/mayan-funding-expired-deadline/execute',
        headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      });

      expect(execute.statusCode).toBe(500);
      expect(execute.body).toContain('mayan quote deadline expired before execution; rebuild fresh quote');
      expect(sendTransaction).not.toHaveBeenCalled();
      expect(ethereum.arbitrum.getWallet).not.toHaveBeenCalled();
      now.mockRestore();
      await app.close();
    });

    it('rejects persisted Mayan selection with tampered deadline via fingerprint mismatch', async () => {
      const signer = new Wallet(`0x${'dd'.repeat(32)}`);
      const sendTransaction = jest.fn();
      const ethereum = mockEthereumContexts(
        { arbitrum: { gas: '20000000000000000', usdc: '0' } },
        { getWallet: jest.fn(async () => signer) },
      );
      const app = Fastify();
      await app.register(rebalanceRoutes, { prefix: '/bridge' });
      await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets',
        payload: {
          targetNotionalEur: '1',
          destinationAddress: SOLANA_WALLET,
          destinationAsset: 'SOL',
          destinationChain: 'solana',
          destinationNetwork: 'mainnet-beta',
          idempotencyKey: 'mayan-funding-tampered-deadline',
          mode: 'mainnet',
        },
      });
      const statePath = path.join(stateRoot, 'mayan-funding-tampered-deadline.json');
      const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
      delete persisted.builtRebalance.deadline;
      writeFileSync(statePath, JSON.stringify(persisted));

      const execute = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets/mayan-funding-tampered-deadline/execute',
        headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      });

      expect(execute.statusCode).toBe(500);
      expect(execute.body).toContain('persisted target funding selection fingerprint mismatch');
      expect(sendTransaction).not.toHaveBeenCalled();
      expect(ethereum.arbitrum.getWallet).not.toHaveBeenCalled();
      await app.close();
    });

    it('rejects persisted Mayan selection with tampered gasLimit via fingerprint mismatch', async () => {
      const signer = new Wallet(`0x${'ee'.repeat(32)}`);
      const sendTransaction = jest.fn();
      const ethereum = mockEthereumContexts(
        { arbitrum: { gas: '20000000000000000', usdc: '0' } },
        { getWallet: jest.fn(async () => signer) },
      );
      const app = Fastify();
      await app.register(rebalanceRoutes, { prefix: '/bridge' });
      await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets',
        payload: {
          targetNotionalEur: '1',
          destinationAddress: SOLANA_WALLET,
          destinationAsset: 'SOL',
          destinationChain: 'solana',
          destinationNetwork: 'mainnet-beta',
          idempotencyKey: 'mayan-funding-tampered-gaslimit',
          mode: 'mainnet',
        },
      });
      const statePath = path.join(stateRoot, 'mayan-funding-tampered-gaslimit.json');
      const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
      persisted.builtRebalance.gasLimit = 999999;
      writeFileSync(statePath, JSON.stringify(persisted));

      const execute = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets/mayan-funding-tampered-gaslimit/execute',
        headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      });

      expect(execute.statusCode).toBe(500);
      expect(execute.body).toContain('persisted target funding selection fingerprint mismatch');
      expect(sendTransaction).not.toHaveBeenCalled();
      expect(ethereum.arbitrum.getWallet).not.toHaveBeenCalled();
      await app.close();
    });

    it('uses adapter gasLimit for balance reserve on build', async () => {
      const baseBuild = await buildMayanSwap({
        sourceAddress: utils.getAddress(ARBITRUM_WALLET),
        destinationAddress: SOLANA_WALLET,
        amount: '0.0005',
      });
      buildMayanSwap.mockResolvedValueOnce({ ...baseBuild, gasLimit: 321000 });
      const ethereum = mockEthereumContexts({ arbitrum: { gas: '885200000000000', usdc: '0' } });
      const app = Fastify();
      await app.register(rebalanceRoutes, { prefix: '/bridge' });
      const response = await app.inject({
        method: 'POST',
        url: '/bridge/rebalance/targets',
        payload: {
          targetNotionalEur: '1',
          destinationAddress: SOLANA_WALLET,
          destinationAsset: 'SOL',
          destinationChain: 'solana',
          destinationNetwork: 'mainnet-beta',
          idempotencyKey: 'mayan-funding-adapter-gaslimit',
          mode: 'mainnet',
        },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.provider).toBe('mayan');
      const persisted = JSON.parse(readFileSync(path.join(stateRoot, 'mayan-funding-adapter-gaslimit.json'), 'utf8'));
      expect(persisted.builtRebalance.gasLimit).toBe(321000);
      expect(ethereum.arbitrum.getNativeBalanceByAddress).toHaveBeenCalledWith(utils.getAddress(ARBITRUM_WALLET));
      await app.close();
    });
  });
});

function targetRequest(overrides: Record<string, unknown> = {}) {
  return {
    targetNotionalEur: '6',
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

function mockSquidRoute(toAmount = '6000000', gasLimit?: unknown) {
  const providerGasLimit = arguments.length >= 2 ? gasLimit : '994800';
  const fetchMock = jest.fn(async (_url: unknown, _options: Record<string, any>) => ({
    headers: { get: () => 'squid-request-1' },
    json: async () => ({
      route: {
        estimate: {
          toAmount,
          feeCosts: [{ amountUsd: '3.50' }],
          gasCosts: [{ amountUsd: '2.10' }],
        },
        id: 'squid-route-1',
        quoteId: 'squid-quote-1',
        requestId: 'squid-request-1',
        transactionRequest: {
          data: '0x1234',
          gasLimit: providerGasLimit,
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

function mockSquidWethRoute() {
  const fetchMock = jest.fn(async (_url: unknown, options: Record<string, any>) => {
    const fromAmount = BigNumber.from(JSON.parse(options.body).fromAmount);
    return squidRouteResponse(fromAmount.mul(BigNumber.from(10).pow(12)).div(3000).toString());
  });
  global.fetch = fetchMock as any;
  return fetchMock;
}

function mockSquidRouteAndStatus(status: string) {
  const fetchMock = jest.fn(async (_url: unknown, options: Record<string, any>) =>
    options.method === 'GET'
      ? { json: async () => ({ squidTransactionStatus: status }), ok: true, status: 200 }
      : squidRouteResponse('6000000'),
  );
  global.fetch = fetchMock as any;
  return fetchMock;
}

function squidRouteResponse(toAmount: string, gasLimit: unknown = '994800') {
  return {
    headers: { get: () => 'squid-request-1' },
    json: async () => ({
      route: {
        estimate: {
          toAmount,
          feeCosts: [{ amountUsd: '3.50' }],
          gasCosts: [{ amountUsd: '2.10' }],
        },
        id: 'squid-route-1',
        quoteId: 'squid-quote-1',
        requestId: 'squid-request-1',
        transactionRequest: {
          data: '0x1234',
          gasLimit,
          target: '0x00000000000000000000000000000000000000F0',
          value: '0',
        },
      },
    }),
    ok: true,
    status: 200,
  };
}
