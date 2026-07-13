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

import { rebalanceRoutes } from '../../src/bridge/rebalance.routes';
import { Ethereum } from '../../src/chains/ethereum/ethereum';
import { Uniswap } from '../../src/connectors/uniswap/uniswap';
import { ensureMarlinWalletExists } from '../../src/wallet/routes/setMarlinDefault';

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
    mockEthereumContexts({ arbitrum: { gas: '1000000000000000', usdc: '6000000' } });
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

  it('inverse-quotes realistic USDC input for a 0.01 Base WETH target', async () => {
    mockEthereumContexts({ arbitrum: { gas: '1000000000000000', usdc: '100000000' } });
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
    mockEthereumContexts({ arbitrum: { gas: '1000000000000000', usdc: '9000000' } });
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
    const ethereum = mockEthereumContexts({ arbitrum: { gas: '1000000000000000', usdc: '9000000' } });
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

  it('rejects persisted Bridge2 selection with tampered native gas bound via fingerprint mismatch', async () => {
    const ethereum = mockEthereumContexts(
      { arbitrum: { gas: '1000000000000000', usdc: '6000000' } },
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
      { arbitrum: { gas: '1000000000000000', usdc: '6000000' } },
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
      { arbitrum: { gas: '1000000000000000', usdc: '6000000' } },
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
    const signer = new Wallet(`0x${'33'.repeat(32)}`);
    const sendTransaction = jest.fn(async (serialized: string) => ({ hash: utils.keccak256(serialized) }));
    mockEthereumContexts(
      { arbitrum: { gas: '1000000000000000', usdc: '9000000' } },
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
          getTransactionCount: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2),
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
      { arbitrum: { gas: '1000000000000000', usdc: '9000000' } },
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
        { arbitrum: { gas: '1000000000000000', usdc: '9000000' } },
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
      { arbitrum: { gas: '1000000000000000', usdc: '9000000' } },
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
      { arbitrum: { gas: '1000000000000000', usdc: '9000000' } },
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
        { arbitrum: { gas: '1000000000000000', usdc: '6000000' } },
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
    mockEthereumContexts({ arbitrum: { gas: '1000000000000000', usdc: '9000000' } });
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
    mockEthereumContexts({ arbitrum: { gas: '1000000000000000', usdc: '100000000' } });
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
      mockEthereumContexts({ arbitrum: { gas: '1000000000000000', usdc: '9000000' } });
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
            transactionRequest: { data: '0x1234', target: '0x00000000000000000000000000000000000000F0', value: '0' },
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
    mockEthereumContexts({ arbitrum: { gas: '1000000000000000', usdc: '100000000' } });
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
            transactionRequest: { data: '0x1234', target: '0x00000000000000000000000000000000000000F0', value: '0' },
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
      expect(body.sourceAsset).toBe('ETH');
      expect(body.destinationAsset).toBe('USDC');
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
      expect(body.sourceAsset).toBe('ETH');
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
      const ethereum = mockEthereumContexts({ arbitrum: { gas: '1000000000000000', usdc: '6000000' } });
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

  describe('two-stage target plan execution', () => {
    const BRIDGE2 = '0x2df1c51e09aecf9cacb7bc98cb1742757f163df7';

    it('blocks stage-0 conversion when native ETH balance is below amount plus gas reserve', async () => {
      const ethereum = mockEthereumContexts(
        { arbitrum: { gas: '500000000000000', usdc: '0' } },
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
        .mockResolvedValue({ decimals: 18, value: BigNumber.from('500000000000000') });
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
    it('rejects a plan whose conversion stage uses the funding provider', async () => {
      mockEthereumContexts({ arbitrum: { gas: '1000000000000000', usdc: '6000000' } });
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

    it('rejects plan with invalid version on reload', async () => {
      mockEthereumContexts({ arbitrum: { gas: '1000000000000000', usdc: '6000000' } });
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
      mockEthereumContexts({ arbitrum: { gas: '1000000000000000', usdc: '6000000' } });
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
      mockEthereumContexts({ arbitrum: { gas: '1000000000000000', usdc: '6000000' } });
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
      mockEthereumContexts({ arbitrum: { gas: '1000000000000000', usdc: '6000000' } });
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
      mockEthereumContexts({ arbitrum: { gas: '1000000000000000', usdc: '6000000' } });
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

      const statusResponse = await app.inject({ method: 'GET', url: '/bridge/rebalance/target-funding-1' });
      expect(statusResponse.statusCode).toBe(200);
      const statusBody = statusResponse.json();
      expect(statusBody.stageIndex).toBeUndefined();
      expect(statusBody.stageCount).toBeUndefined();
      expect(statusBody.stageStatus).toBeUndefined();
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

function mockSquidRoute(toAmount = '6000000') {
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

function squidRouteResponse(toAmount: string) {
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
          target: '0x00000000000000000000000000000000000000F0',
          value: '0',
        },
      },
    }),
    ok: true,
    status: 200,
  };
}
