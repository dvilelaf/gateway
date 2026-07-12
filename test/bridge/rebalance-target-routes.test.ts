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

  it('forward-quotes a 100 EUR WETH target without destinationAmount using at most 100 USDC source budget', async () => {
    mockEthereumContexts({ arbitrum: { gas: '1000000000000000', usdc: '100000000' } });
    const fetchMock = jest.fn(async (_url: unknown, options: Record<string, any>) => {
      const body = JSON.parse(options.body);
      const fromAmount = BigNumber.from(body.fromAmount);
      return {
        headers: { get: () => 'squid-request-1' },
        json: async () => ({
          route: {
            estimate: { toAmount: fromAmount.mul(10).toString() },
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
    const squidPayload = JSON.parse(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1].body);
    expect(squidPayload.fromAmount).toBe('100000000');
    expect(squidPayload.fromToken).toBe(ARBITRUM_USDC);
    expect(squidPayload.toToken).toBe(BASE_WETH);
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
        estimate: { toAmount },
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
        estimate: { toAmount },
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
