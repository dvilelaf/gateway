import { rmSync } from 'fs';
import path from 'path';

import { BigNumber, utils } from 'ethers';
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
const DESTINATION_WALLET = '0x00000000000000000000000000000000000000bb';
const TOKEN = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const BRIDGE2 = '0x2df1c51e09aecf9cacb7bc98cb1742757f163df7';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CCTP_TOKEN_MESSENGER = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d';
const CCTP_MESSAGE_TRANSMITTER = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64';
const REBALANCE_STATE_IDS = [
  'rebalance-1',
  'build-then-execute',
  'rebalance-no-token',
  'cctp-rebalance-1',
  'cctp-concurrent',
  'cctp-approval-pending',
  'cctp-idempotency-mismatch',
  'cctp-attestation-pending',
  'cctp-resume',
  'cctp-destination-auth-mismatch',
  'cctp-iris-rate-limited',
  'cctp-message-mismatch',
  'cctp-destination-gas-zero',
  'cctp-destination-gas-after-approval',
  'cctp-finalize-failed-retryable',
  'cctp-finalize-receipt-unknown',
  'rebalance-build-status',
];

describe('Hyperliquid Bridge2 treasury rebalance route', () => {
  const originalProfile = process.env.MARLIN_RUNTIME_PROFILE;
  const originalToken = process.env.MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN;
  const originalFetch = global.fetch;

  beforeEach(() => {
    cleanupRebalanceState();
    global.fetch = originalFetch;
  });

  afterEach(() => {
    cleanupRebalanceState();
    global.fetch = originalFetch;
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
      prepareGasOptions: jest.fn(async () => ({ gasLimit: 120000, maxFeePerGas: BigNumber.from(10) })),
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
      prepareGasOptions: jest.fn(async () => ({ gasLimit: 120000, maxFeePerGas: BigNumber.from(10) })),
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
      payload: { ...baseRequest(), idempotencyKey: 'rebalance-build-status' },
    });
    const status = await app.inject({
      method: 'GET',
      url: '/bridge/rebalance/rebalance-build-status',
    });

    expect(build.statusCode).toBe(200);
    expect(build.json().txTarget).toBe(TOKEN);
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ idempotencyKey: 'rebalance-build-status', status: 'built' });
  });

  it('rejects scoped provider-treasury authorization without the Gateway provider token', async () => {
    process.env.MARLIN_RUNTIME_PROFILE = 'marlin';
    delete process.env.MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN;
    const sendTransaction = jest.fn(async () => ({ hash: '0xdef' }));
    mockEthereum({
      getWallet: jest.fn(async () => ({ sendTransaction })),
      handleTransactionExecution: jest.fn(async () => ({ status: 1 })),
      prepareGasOptions: jest.fn(async () => ({ gasLimit: 120000, maxFeePerGas: BigNumber.from(10) })),
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

  it('allows CCTP Base to Arbitrum transfer to a different derived destination address', async () => {
    const result = await buildCctpBaseArbitrumUsdcTransfer({
      ...cctpRequest(),
      destinationAddress: '0x00000000000000000000000000000000000000bb',
    });

    expect(result.walletAddress).toBe(utils.getAddress(WALLET));
    expect(result.destinationAddress).toBe(utils.getAddress('0x00000000000000000000000000000000000000bb'));
  });

  it('executes CCTP Base to Arbitrum through provider-owned approve, burn, attestation, and finalize', async () => {
    process.env.MARLIN_RUNTIME_PROFILE = 'marlin';
    process.env.MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN = 'gateway-token';
    const sendTransaction = jest
      .fn()
      .mockResolvedValueOnce({ hash: '0xapprove' })
      .mockResolvedValueOnce({ hash: '0xburn' })
      .mockResolvedValueOnce({ hash: '0xfinalize' });
    const getWallet = jest.fn(async () => ({ sendTransaction }));
    const prepareGasOptions = jest.fn(async () => ({ gasLimit: 120000, maxFeePerGas: BigNumber.from(10) }));
    mockEthereum({
      getWallet,
      handleTransactionExecution: jest.fn(async () => ({ status: 1 })),
      prepareGasOptions,
    });
    mockIris(cctpIrisMessage('0xburn', DESTINATION_WALLET));
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      payload: {
        ...cctpRequest(),
        destinationAddress: DESTINATION_WALLET,
        liveActionAuthorization: cctpAuthorization('1.5', DESTINATION_WALLET),
      },
    });
    const status = await app.inject({
      method: 'GET',
      url: '/bridge/rebalance/cctp-rebalance-1',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().signature).toBe('0xfinalize');
    expect(sendTransaction).toHaveBeenCalledTimes(3);
    expect(sendTransaction.mock.calls[0][0].to).toBe(BASE_USDC);
    expect(sendTransaction.mock.calls[0][0].data).toMatch(/^0x095ea7b3/);
    expect(sendTransaction.mock.calls[1][0].to).toBe(CCTP_TOKEN_MESSENGER);
    expect(sendTransaction.mock.calls[1][0].data).toMatch(/^0x8e0250ee/);
    expect(sendTransaction.mock.calls[2][0].to).toBe(CCTP_MESSAGE_TRANSMITTER);
    expect(sendTransaction.mock.calls[2][0].data).toMatch(/^0x57ecfd28/);
    expect(getWallet).toHaveBeenNthCalledWith(1, utils.getAddress(WALLET));
    expect(getWallet).toHaveBeenNthCalledWith(2, utils.getAddress(DESTINATION_WALLET));
    expect(prepareGasOptions).toHaveBeenCalledTimes(5);
    expect(prepareGasOptions).toHaveBeenNthCalledWith(
      5,
      undefined,
      300000,
      cctpAuthorization('1.5', DESTINATION_WALLET),
      'cctp_base_arbitrum_usdc_rebalance',
    );
    expect(status.json()).toMatchObject({
      approvalTransactionHash: '0xapprove',
      burnTransactionHash: '0xburn',
      finalizeTransactionHash: '0xfinalize',
      idempotencyKey: 'cctp-rebalance-1',
      providerStatus: 'complete',
      status: 'confirmed',
      transactionHash: '0xfinalize',
    });
  });

  it('does not double-submit concurrent CCTP executes for the same idempotency key', async () => {
    process.env.MARLIN_RUNTIME_PROFILE = 'marlin';
    process.env.MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN = 'gateway-token';
    const sendTransaction = jest
      .fn()
      .mockResolvedValueOnce({ hash: '0xapprove-concurrent' })
      .mockResolvedValueOnce({ hash: '0xburn-concurrent' })
      .mockResolvedValueOnce({ hash: '0xfinalize-concurrent' });
    mockEthereum({
      getWallet: jest.fn(async () => ({ sendTransaction })),
      handleTransactionExecution: jest.fn(
        async () => new Promise((resolve) => setTimeout(() => resolve({ status: 1 }), 10)),
      ),
      prepareGasOptions: jest.fn(async () => ({ gasLimit: 120000, maxFeePerGas: BigNumber.from(10) })),
    });
    mockIris(cctpIrisMessage('0xburn-concurrent'));
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    await app.ready();
    const payload = {
      ...cctpRequest(),
      idempotencyKey: 'cctp-concurrent',
      liveActionAuthorization: cctpAuthorization('1.5'),
    };

    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/bridge/rebalance/execute',
        headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
        payload,
      }),
      app.inject({
        method: 'POST',
        url: '/bridge/rebalance/execute',
        headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
        payload,
      }),
    ]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect([first.json().signature, second.json().signature]).toEqual([
      '0xfinalize-concurrent',
      '0xfinalize-concurrent',
    ]);
    expect(sendTransaction).toHaveBeenCalledTimes(3);
  });

  it('does not burn CCTP USDC before approval is confirmed', async () => {
    process.env.MARLIN_RUNTIME_PROFILE = 'marlin';
    process.env.MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN = 'gateway-token';
    const sendTransaction = jest.fn().mockResolvedValueOnce({ hash: '0xapprove-pending' });
    mockEthereum({
      getWallet: jest.fn(async () => ({ sendTransaction })),
      handleTransactionExecution: jest.fn(async () => null),
      prepareGasOptions: jest.fn(async () => ({ gasLimit: 120000, maxFeePerGas: BigNumber.from(10) })),
    });
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      payload: {
        ...cctpRequest(),
        idempotencyKey: 'cctp-approval-pending',
        liveActionAuthorization: cctpAuthorization('1.5'),
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toContain('CCTP USDC approval not confirmed');
    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('does not approve or burn CCTP USDC when destination Arbitrum wallet has no ETH for finalize gas', async () => {
    process.env.MARLIN_RUNTIME_PROFILE = 'marlin';
    process.env.MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN = 'gateway-token';
    const sendTransaction = jest.fn();
    const getNativeBalanceByAddress = jest.fn(async () => ({ value: BigNumber.from(0), decimals: 18 }));
    mockEthereum({
      getNativeBalanceByAddress,
      getWallet: jest.fn(async () => ({ sendTransaction })),
      handleTransactionExecution: jest.fn(async () => ({ status: 1 })),
      prepareGasOptions: jest.fn(async () => ({ gasLimit: 120000, maxFeePerGas: BigNumber.from(10) })),
    });
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      payload: {
        ...cctpRequest(),
        idempotencyKey: 'cctp-destination-gas-zero',
        destinationAddress: DESTINATION_WALLET,
        liveActionAuthorization: cctpAuthorization('1.5', DESTINATION_WALLET),
      },
    });
    const status = await app.inject({
      method: 'GET',
      url: '/bridge/rebalance/cctp-destination-gas-zero',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ signature: '', status: 0 });
    expect(getNativeBalanceByAddress).toHaveBeenCalledWith(utils.getAddress(DESTINATION_WALLET));
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(status.json()).toMatchObject({
      idempotencyKey: 'cctp-destination-gas-zero',
      providerError: 'CCTP destination Arbitrum wallet has no ETH for receiveMessage gas',
      providerStatus: 'destination_gas_unavailable',
      status: 'destination_gas_unavailable',
    });
  });

  it('does not burn CCTP USDC after approval when destination Arbitrum gas disappears', async () => {
    process.env.MARLIN_RUNTIME_PROFILE = 'marlin';
    process.env.MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN = 'gateway-token';
    const sendTransaction = jest.fn().mockResolvedValueOnce({ hash: '0xapprove-gas-after-approval' });
    const getNativeBalanceByAddress = jest
      .fn()
      .mockResolvedValueOnce({ value: BigNumber.from(1200000), decimals: 18 })
      .mockResolvedValue({ value: BigNumber.from(0), decimals: 18 });
    mockEthereum({
      getNativeBalanceByAddress,
      getWallet: jest.fn(async () => ({ sendTransaction })),
      handleTransactionExecution: jest.fn(async () => ({ status: 1 })),
      prepareGasOptions: jest.fn(async () => ({ gasLimit: 120000, maxFeePerGas: BigNumber.from(10) })),
    });
    mockIris(cctpIrisMessage('0xburn-gas-after-approval'));
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    await app.ready();
    const payload = {
      ...cctpRequest(),
      idempotencyKey: 'cctp-destination-gas-after-approval',
      liveActionAuthorization: cctpAuthorization('1.5'),
    };

    const first = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      payload,
    });
    const status = await app.inject({
      method: 'GET',
      url: '/bridge/rebalance/cctp-destination-gas-after-approval',
    });

    expect(first.json()).toMatchObject({ signature: '0xapprove-gas-after-approval', status: 0 });
    expect(second.json()).toMatchObject({ status: 0 });
    expect(sendTransaction).toHaveBeenCalledTimes(1);
    expect(status.json()).toMatchObject({
      approvalTransactionHash: '0xapprove-gas-after-approval',
      providerStatus: 'destination_gas_unavailable',
      status: 'destination_gas_unavailable',
    });
  });

  it('rejects the same idempotency key with a different immutable request fingerprint', async () => {
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    await app.ready();

    const first = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/build',
      payload: { ...cctpRequest(), idempotencyKey: 'cctp-idempotency-mismatch' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/build',
      payload: { ...cctpRequest(), idempotencyKey: 'cctp-idempotency-mismatch', amount: '1.6' },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(500);
    expect(second.body).toContain('idempotency key already used');
  });

  it('rejects CCTP provider treasury authorization for a different destination address', async () => {
    process.env.MARLIN_RUNTIME_PROFILE = 'marlin';
    process.env.MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN = 'gateway-token';
    const sendTransaction = jest.fn();
    mockEthereum({
      getWallet: jest.fn(async () => ({ sendTransaction })),
      handleTransactionExecution: jest.fn(async () => ({ status: 1 })),
      prepareGasOptions: jest.fn(async () => ({ gasLimit: 120000, maxFeePerGas: BigNumber.from(10) })),
    });
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      payload: {
        ...cctpRequest(),
        idempotencyKey: 'cctp-destination-auth-mismatch',
        liveActionAuthorization: {
          ...cctpAuthorization('1.5'),
          destination_address: '0x00000000000000000000000000000000000000bB',
        },
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toContain('does not match destination');
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('keeps Iris pending and rate-limit responses retryable without finalizing', async () => {
    process.env.MARLIN_RUNTIME_PROFILE = 'marlin';
    process.env.MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN = 'gateway-token';
    const sendTransaction = jest
      .fn()
      .mockResolvedValueOnce({ hash: '0xapprove-pending-iris' })
      .mockResolvedValueOnce({ hash: '0xburn-pending-iris' });
    mockEthereum({
      getWallet: jest.fn(async () => ({ sendTransaction })),
      handleTransactionExecution: jest.fn(async () => ({ status: 1 })),
      prepareGasOptions: jest.fn(async () => ({ gasLimit: 120000, maxFeePerGas: BigNumber.from(10) })),
    });
    mockIris({ messages: [{ status: 'pending_confirmations' }] });
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      payload: {
        ...cctpRequest(),
        idempotencyKey: 'cctp-attestation-pending',
        liveActionAuthorization: cctpAuthorization('1.5'),
      },
    });
    const status = await app.inject({
      method: 'GET',
      url: '/bridge/rebalance/cctp-attestation-pending',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ signature: '0xburn-pending-iris', status: 0 });
    expect(sendTransaction).toHaveBeenCalledTimes(2);
    expect(status.json()).toMatchObject({
      burnTransactionHash: '0xburn-pending-iris',
      providerStatus: 'pending_confirmations',
      status: 'attestation_pending',
    });
  });

  it('keeps Iris rate limits retryable and visible without finalizing', async () => {
    process.env.MARLIN_RUNTIME_PROFILE = 'marlin';
    process.env.MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN = 'gateway-token';
    const sendTransaction = jest
      .fn()
      .mockResolvedValueOnce({ hash: '0xapprove-rate-limited' })
      .mockResolvedValueOnce({ hash: '0xburn-rate-limited' });
    mockEthereum({
      getWallet: jest.fn(async () => ({ sendTransaction })),
      handleTransactionExecution: jest.fn(async () => ({ status: 1 })),
      prepareGasOptions: jest.fn(async () => ({ gasLimit: 120000, maxFeePerGas: BigNumber.from(10) })),
    });
    mockIrisHttpError(429, { message: 'rate limited' });
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      payload: {
        ...cctpRequest(),
        idempotencyKey: 'cctp-iris-rate-limited',
        liveActionAuthorization: cctpAuthorization('1.5'),
      },
    });
    const status = await app.inject({
      method: 'GET',
      url: '/bridge/rebalance/cctp-iris-rate-limited',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ signature: '0xburn-rate-limited', status: 0 });
    expect(sendTransaction).toHaveBeenCalledTimes(2);
    expect(status.json()).toMatchObject({
      providerError: 'Iris attestation lookup rate limited',
      providerStatus: 'rate_limited',
      status: 'attestation_pending',
    });
  });

  it('validates the CCTP message before Arbitrum receiveMessage broadcast', async () => {
    process.env.MARLIN_RUNTIME_PROFILE = 'marlin';
    process.env.MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN = 'gateway-token';
    const sendTransaction = jest
      .fn()
      .mockResolvedValueOnce({ hash: '0xapprove-message-mismatch' })
      .mockResolvedValueOnce({ hash: '0xburn-message-mismatch' });
    mockEthereum({
      getWallet: jest.fn(async () => ({ sendTransaction })),
      handleTransactionExecution: jest.fn(async () => ({ status: 1 })),
      prepareGasOptions: jest.fn(async () => ({ gasLimit: 120000, maxFeePerGas: BigNumber.from(10) })),
    });
    const badMessage = cctpIrisMessage('0xburn-message-mismatch');
    (badMessage.messages[0].decodedMessage.decodedMessageBody as any).amount = '1500001';
    mockIris(badMessage);
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      payload: {
        ...cctpRequest(),
        idempotencyKey: 'cctp-message-mismatch',
        liveActionAuthorization: cctpAuthorization('1.5'),
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toContain('CCTP amount mismatch');
    expect(sendTransaction).toHaveBeenCalledTimes(2);
  });

  it('resumes CCTP after burn without rebroadcasting approval or burn', async () => {
    process.env.MARLIN_RUNTIME_PROFILE = 'marlin';
    process.env.MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN = 'gateway-token';
    const sendTransaction = jest
      .fn()
      .mockResolvedValueOnce({ hash: '0xapprove-resume' })
      .mockResolvedValueOnce({ hash: '0xburn-resume' })
      .mockResolvedValueOnce({ hash: '0xfinalize-resume' });
    mockEthereum({
      getWallet: jest.fn(async () => ({ sendTransaction })),
      handleTransactionExecution: jest.fn(async () => ({ status: 1 })),
      prepareGasOptions: jest.fn(async () => ({ gasLimit: 120000, maxFeePerGas: BigNumber.from(10) })),
    });
    mockIrisSequence([{ messages: [{ status: 'pending_confirmations' }] }, cctpIrisMessage('0xburn-resume')]);
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    await app.ready();
    const payload = {
      ...cctpRequest(),
      idempotencyKey: 'cctp-resume',
      liveActionAuthorization: cctpAuthorization('1.5'),
    };

    const first = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      payload,
    });

    expect(first.json()).toMatchObject({ signature: '0xburn-resume', status: 0 });
    expect(second.json()).toMatchObject({ signature: '0xfinalize-resume', status: 1 });
    expect(sendTransaction).toHaveBeenCalledTimes(3);
    expect(sendTransaction.mock.calls[2][0].to).toBe(CCTP_MESSAGE_TRANSMITTER);
  });

  it('keeps failed CCTP finalize receipts retryable after burn', async () => {
    process.env.MARLIN_RUNTIME_PROFILE = 'marlin';
    process.env.MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN = 'gateway-token';
    const sendTransaction = jest
      .fn()
      .mockResolvedValueOnce({ hash: '0xapprove-finalize-failed' })
      .mockResolvedValueOnce({ hash: '0xburn-finalize-failed' })
      .mockResolvedValueOnce({ hash: '0xfinalize-failed' })
      .mockResolvedValueOnce({ hash: '0xfinalize-retry' });
    mockEthereum({
      getWallet: jest.fn(async () => ({ sendTransaction })),
      handleTransactionExecution: jest
        .fn()
        .mockResolvedValueOnce({ status: 1 })
        .mockResolvedValueOnce({ status: 1 })
        .mockResolvedValueOnce({ status: 0 })
        .mockResolvedValueOnce({ status: 1 }),
      prepareGasOptions: jest.fn(async () => ({ gasLimit: 120000, maxFeePerGas: BigNumber.from(10) })),
    });
    mockIris(cctpIrisMessage('0xburn-finalize-failed'));
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      payload: {
        ...cctpRequest(),
        idempotencyKey: 'cctp-finalize-failed-retryable',
        liveActionAuthorization: cctpAuthorization('1.5'),
      },
    });
    const firstStatus = await app.inject({
      method: 'GET',
      url: '/bridge/rebalance/cctp-finalize-failed-retryable',
    });
    const retry = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      payload: {
        ...cctpRequest(),
        idempotencyKey: 'cctp-finalize-failed-retryable',
        liveActionAuthorization: cctpAuthorization('1.5'),
      },
    });
    const retryStatus = await app.inject({
      method: 'GET',
      url: '/bridge/rebalance/cctp-finalize-failed-retryable',
    });

    expect(response.json()).toMatchObject({ signature: '0xfinalize-failed', status: -1 });
    expect(firstStatus.json()).toMatchObject({
      burnTransactionHash: '0xburn-finalize-failed',
      finalizeTransactionHash: '0xfinalize-failed',
      status: 'finalize_pending',
    });
    expect(retry.json()).toMatchObject({ signature: '0xfinalize-retry', status: 1 });
    expect(retryStatus.json()).toMatchObject({
      burnTransactionHash: '0xburn-finalize-failed',
      finalizeTransactionHash: '0xfinalize-retry',
      status: 'confirmed',
    });
    expect(sendTransaction.mock.calls[3][0].to).toBe(CCTP_MESSAGE_TRANSMITTER);
  });

  it('does not rebroadcast CCTP finalize when receipt status is unknown after hash submission', async () => {
    process.env.MARLIN_RUNTIME_PROFILE = 'marlin';
    process.env.MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN = 'gateway-token';
    const sendTransaction = jest
      .fn()
      .mockResolvedValueOnce({ hash: '0xapprove-finalize-unknown' })
      .mockResolvedValueOnce({ hash: '0xburn-finalize-unknown' })
      .mockResolvedValueOnce({ hash: '0xfinalize-unknown' });
    mockEthereum({
      getWallet: jest.fn(async () => ({ sendTransaction })),
      handleTransactionExecution: jest
        .fn()
        .mockResolvedValueOnce({ status: 1 })
        .mockResolvedValueOnce({ status: 1 })
        .mockRejectedValueOnce(new Error('receipt provider timeout with token secret')),
      prepareGasOptions: jest.fn(async () => ({ gasLimit: 120000, maxFeePerGas: BigNumber.from(10) })),
    });
    mockIris(cctpIrisMessage('0xburn-finalize-unknown'));
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    await app.ready();
    const payload = {
      ...cctpRequest(),
      idempotencyKey: 'cctp-finalize-receipt-unknown',
      liveActionAuthorization: cctpAuthorization('1.5'),
    };

    const response = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      payload,
    });
    const firstStatus = await app.inject({
      method: 'GET',
      url: '/bridge/rebalance/cctp-finalize-receipt-unknown',
    });
    const retry = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      payload,
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toContain('[redacted]');
    expect(firstStatus.json()).toMatchObject({
      burnTransactionHash: '0xburn-finalize-unknown',
      finalizeTransactionHash: '0xfinalize-unknown',
      providerError: expect.stringContaining('[redacted]'),
      status: 'finalize_submitted',
    });
    expect(retry.json()).toMatchObject({ signature: '0xfinalize-unknown', status: 0 });
    expect(sendTransaction).toHaveBeenCalledTimes(3);
    expect(sendTransaction.mock.calls[2][0].to).toBe(CCTP_MESSAGE_TRANSMITTER);
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

function cctpAuthorization(notional: string, destinationAddress: string = WALLET) {
  return {
    action: 'gateway_rebalance',
    connector_id: 'treasury',
    destination_address: destinationAddress,
    destination_network: 'arbitrum',
    network: 'base',
    notional,
    scope: 'provider_treasury',
    source: 'marlin',
    wallet_address: WALLET,
  };
}

function mockEthereum(overrides: Record<string, unknown> = {}) {
  const ethereum = {
    getNativeBalanceByAddress: jest.fn(async () => ({
      decimals: 18,
      value: BigNumber.from('1000000000000000000'),
    })),
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

function mockIris(body: Record<string, unknown>) {
  global.fetch = jest.fn(async () => ({
    headers: { get: () => 'application/json' },
    json: async () => body,
    ok: true,
    status: 200,
    statusText: 'OK',
  })) as any;
}

function mockIrisHttpError(status: number, body: Record<string, unknown>) {
  global.fetch = jest.fn(async () => ({
    headers: { get: () => 'application/json' },
    json: async () => body,
    ok: false,
    status,
    statusText: 'Rate Limited',
  })) as any;
}

function mockIrisSequence(bodies: Record<string, unknown>[]) {
  global.fetch = jest.fn(async () => {
    const body = bodies.shift() ?? bodies[bodies.length - 1] ?? { messages: [{ status: 'pending' }] };
    return {
      headers: { get: () => 'application/json' },
      json: async () => body,
      ok: true,
      status: 200,
      statusText: 'OK',
    };
  }) as any;
}

function cctpIrisMessage(_burnTransactionHash: string, mintRecipient: string = WALLET) {
  const message = cctpMessageBytes(mintRecipient);
  return {
    messages: [
      {
        attestation: `0x${'11'.repeat(65)}`,
        cctpVersion: 2,
        decodedMessage: {
          sourceDomain: '6',
          destinationDomain: '3',
          sender: CCTP_TOKEN_MESSENGER,
          recipient: CCTP_TOKEN_MESSENGER,
          destinationCaller: utils.hexZeroPad('0x', 32),
          decodedMessageBody: {
            burnToken: BASE_USDC,
            mintRecipient,
            amount: '1500000',
            messageSender: WALLET,
          },
        },
        message,
        status: 'complete',
      },
    ],
  };
}

function cctpMessageBytes(mintRecipient: string = WALLET): string {
  return utils.hexConcat([
    uint32(1),
    uint32(6),
    uint32(3),
    utils.hexZeroPad('0x01', 32),
    addressBytes32(CCTP_TOKEN_MESSENGER),
    addressBytes32(CCTP_TOKEN_MESSENGER),
    utils.hexZeroPad('0x', 32),
    uint32(2000),
    uint32(2000),
    uint32(1),
    addressBytes32(BASE_USDC),
    addressBytes32(mintRecipient),
    utils.hexZeroPad(utils.hexlify(1500000), 32),
    addressBytes32(WALLET),
    utils.hexZeroPad('0x', 32),
    utils.hexZeroPad('0x', 32),
    utils.hexZeroPad('0x', 32),
  ]);
}

function addressBytes32(address: string): string {
  return utils.hexZeroPad(utils.getAddress(address), 32);
}

function uint32(value: number): string {
  return utils.hexZeroPad(utils.hexlify(value), 4);
}

function cleanupRebalanceState() {
  for (const id of REBALANCE_STATE_IDS) {
    rmSync(path.resolve(process.cwd(), 'conf/marlin/rebalances', `${id}.json`), { force: true });
    rmSync(path.resolve(process.cwd(), 'conf/marlin/rebalances', `${id}.json.tmp`), { force: true });
  }
}
