import { createHash } from 'crypto';
import { existsSync, readFileSync, rmSync } from 'fs';
import path from 'path';

import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Keypair, PublicKey } from '@solana/web3.js';
import { BigNumber, utils } from 'ethers';
import Fastify from 'fastify';
import yaml from 'js-yaml';

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

import {
  rebalanceRoutes,
  buildCctpBaseArbitrumUsdcTransfer,
  buildHyperliquidBridge2Transfer,
} from '../../src/bridge/rebalance.routes';
import { Ethereum } from '../../src/chains/ethereum/ethereum';
import { Solana } from '../../src/chains/solana/solana';
import { assertMainnetMutationAllowed } from '../../src/services/runtime-guard';

const WALLET = '0x00000000000000000000000000000000000000aa';
const DESTINATION_WALLET = '0x00000000000000000000000000000000000000bb';
const TOKEN = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const BRIDGE2 = '0x2df1c51e09aecf9cacb7bc98cb1742757f163df7';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ETHEREUM_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const AVALANCHE_USDC = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E';
const CODEX_USDC = '0xd996633a415985DBd7D6D12f4A4343E31f5037cf';
const CRONOS_USDC = '0x3D7F2C478aAfdB65542BCB44bCeeC05849999d2D';
const EDGE_USDC = '0x98d2919b9A214E6Fa5384AC81E6864bA686Ad74c';
const HYPEREVM_USDC = '0xb88339CB7199b77E23DB6E890353E22632Ba630f';
const INJECTIVE_USDC = '0xa00C59fF5a080D2b954d0c75e46E22a0c371235a';
const INK_USDC = '0x2D270e6886d130D724215A266106e6832161EAEd';
const LINEA_USDC = '0x176211869cA2b568f2A7D4EE941E073a821EE1ff';
const MONAD_USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';
const MORPH_USDC = '0xCfb1186F4e93D60E60a8bDd997427D1F33bc372B';
const OPTIMISM_USDC = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85';
const PHAROS_USDC = '0xC879C018dB60520F4355C26eD1a6D572cdAC1815';
const PLUME_USDC = '0x222365EF19F7947e5484218551B56bb3965Aa7aF';
const POLYGON_USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const SEI_USDC = '0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392';
const SONIC_USDC = '0x29219dd400f2Bf60E5a23d13Be72B486D4038894';
const UNICHAIN_USDC = '0x078D782b760474a361dDA0AF3839290b0EF57AD6';
const WORLD_CHAIN_USDC = '0x79a02482a880bce3f13e09da970dc34db4cd24d1';
const XDC_USDC = '0xfA2958CB79b0491CC627c1557F441eF849Ca8eb1';
const CCTP_TOKEN_MESSENGER = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d';
const CCTP_MESSAGE_TRANSMITTER = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64';
const SOLANA_CCTP_MESSAGE_TRANSMITTER = 'CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC';
const SOLANA_CCTP_TOKEN_MESSENGER = 'CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe';
const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOLANA_DESTINATION_WALLET = '7UXzqF5bBgVjrCsMk5uX6NqT3LVffxXEmPgN13YfBjgY';
const EDGE_CCTP_TOKEN_MESSENGER = '0x98706A006bc632Df31CAdFCBD43F38887ce2ca5c';
const EDGE_CCTP_MESSAGE_TRANSMITTER = '0x5b61381Fc9e58E70EfC13a4A97516997019198ee';
const CCTP_CONFIGURED_NETWORKS = [
  { alias: 'ethereum', domain: 0, gatewayNetwork: 'mainnet', tokenAddress: ETHEREUM_USDC },
  { alias: 'avalanche', domain: 1, gatewayNetwork: 'avalanche', tokenAddress: AVALANCHE_USDC },
  { alias: 'optimism', domain: 2, gatewayNetwork: 'optimism', tokenAddress: OPTIMISM_USDC },
  { alias: 'arbitrum', domain: 3, gatewayNetwork: 'arbitrum', tokenAddress: TOKEN },
  { alias: 'base', domain: 6, gatewayNetwork: 'base', tokenAddress: BASE_USDC },
  { alias: 'polygon', domain: 7, gatewayNetwork: 'polygon', tokenAddress: POLYGON_USDC },
  { alias: 'unichain', domain: 10, gatewayNetwork: 'unichain', tokenAddress: UNICHAIN_USDC },
  { alias: 'linea', domain: 11, gatewayNetwork: 'linea', tokenAddress: LINEA_USDC },
  { alias: 'codex', domain: 12, gatewayNetwork: 'codex', tokenAddress: CODEX_USDC },
  { alias: 'sonic', domain: 13, gatewayNetwork: 'sonic', tokenAddress: SONIC_USDC },
  { alias: 'world-chain', domain: 14, gatewayNetwork: 'world-chain', tokenAddress: WORLD_CHAIN_USDC },
  { alias: 'monad', domain: 15, gatewayNetwork: 'monad', tokenAddress: MONAD_USDC },
  { alias: 'sei', domain: 16, gatewayNetwork: 'sei', tokenAddress: SEI_USDC },
  { alias: 'xdc', domain: 18, gatewayNetwork: 'xdc', tokenAddress: XDC_USDC },
  { alias: 'hyperevm', domain: 19, gatewayNetwork: 'hyperevm', tokenAddress: HYPEREVM_USDC },
  { alias: 'ink', domain: 21, gatewayNetwork: 'ink', tokenAddress: INK_USDC },
  { alias: 'plume', domain: 22, gatewayNetwork: 'plume', tokenAddress: PLUME_USDC },
  {
    alias: 'edge',
    domain: 28,
    gatewayNetwork: 'edge',
    messageTransmitterAddress: EDGE_CCTP_MESSAGE_TRANSMITTER,
    tokenAddress: EDGE_USDC,
    tokenMessengerAddress: EDGE_CCTP_TOKEN_MESSENGER,
  },
  { alias: 'injective', domain: 29, gatewayNetwork: 'injective', tokenAddress: INJECTIVE_USDC },
  { alias: 'morph', domain: 30, gatewayNetwork: 'morph', tokenAddress: MORPH_USDC },
  { alias: 'pharos', domain: 31, gatewayNetwork: 'pharos', tokenAddress: PHAROS_USDC },
  { alias: 'cronos', domain: 32, gatewayNetwork: 'cronos', tokenAddress: CRONOS_USDC },
];
const REBALANCE_STATE_IDS = [
  'rebalance-1',
  'build-then-execute',
  'bridge2-receipt-unknown',
  'rebalance-no-token',
  'cctp-rebalance-1',
  'cctp-concurrent',
  'cctp-approval-pending',
  'cctp-approval-submitted-retry',
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
  'cctp-solana-destination-gas-missing',
  'cctp-solana-finalize',
  'cctp-solana-finalize-unknown',
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

  it('does not rebroadcast Bridge2 when receipt status is unknown after hash submission', async () => {
    process.env.MARLIN_RUNTIME_PROFILE = 'marlin';
    process.env.MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN = 'gateway-token';
    const sendTransaction = jest.fn(async () => ({ hash: '0xbridge2-unknown' }));
    mockEthereum({
      getWallet: jest.fn(async () => ({ sendTransaction })),
      handleTransactionExecution: jest.fn().mockRejectedValueOnce(new Error('receipt provider timeout')),
      prepareGasOptions: jest.fn(async () => ({ gasLimit: 120000, maxFeePerGas: BigNumber.from(10) })),
    });
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    await app.ready();
    const body = {
      ...baseRequest(),
      idempotencyKey: 'bridge2-receipt-unknown',
      liveActionAuthorization: treasuryAuthorization('6'),
    };

    const first = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      payload: body,
    });
    const retry = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      payload: body,
    });

    expect(first.statusCode).toBe(500);
    expect(retry.json()).toMatchObject({ signature: '0xbridge2-unknown', status: 0 });
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

    expect(result.provider).toBe('cctp_usdc');
    expect(result.sourceNetwork).toBe('base');
    expect(result.destinationNetwork).toBe('arbitrum');
    expect(result.approvalTxTarget).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(result.txTarget).toBe('0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d');
    expect(result.approvalTxCalldata).toMatch(/^0x/);
    expect(result.txCalldata).toMatch(/^0x/);
  });

  it('builds a registry-driven CCTP Ethereum to Base USDC transfer', async () => {
    const result = await buildCctpBaseArbitrumUsdcTransfer({
      ...cctpRequest(),
      destinationNetwork: 'base',
      sourceNetwork: 'ethereum',
    });
    const deposit = new utils.Interface([
      'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)',
    ]).decodeFunctionData('depositForBurn', result.txCalldata);
    const approval = new utils.Interface([
      'function approve(address spender, uint256 amount) returns (bool)',
    ]).decodeFunctionData('approve', result.approvalTxCalldata as string);

    expect(result.sourceNetwork).toBe('mainnet');
    expect(result.destinationNetwork).toBe('base');
    expect(result.approvalTxTarget).toBe(ETHEREUM_USDC);
    expect(result.txTarget).toBe(CCTP_TOKEN_MESSENGER);
    expect(approval[0]).toBe(CCTP_TOKEN_MESSENGER);
    expect(deposit[1]).toBe(6);
    expect(deposit[3]).toBe(ETHEREUM_USDC);
  });

  it.each(CCTP_CONFIGURED_NETWORKS)('builds CCTP calldata for configured $gatewayNetwork USDC', async (network) => {
    const destination = network.gatewayNetwork === 'base' ? CCTP_CONFIGURED_NETWORKS[3] : CCTP_CONFIGURED_NETWORKS[4];
    const result = await buildCctpBaseArbitrumUsdcTransfer({
      ...cctpRequest(),
      destinationNetwork: destination.alias,
      sourceNetwork: network.alias,
    });
    const deposit = new utils.Interface([
      'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)',
    ]).decodeFunctionData('depositForBurn', result.txCalldata);
    const approval = new utils.Interface([
      'function approve(address spender, uint256 amount) returns (bool)',
    ]).decodeFunctionData('approve', result.approvalTxCalldata as string);

    expect(result.sourceNetwork).toBe(network.gatewayNetwork);
    expect(result.destinationNetwork).toBe(destination.gatewayNetwork);
    expect(result.cctpSourceDomain).toBe(network.domain);
    expect(result.cctpDestinationDomain).toBe(destination.domain);
    expect(result.cctpSourceTokenMessengerAddress).toBe(network.tokenMessengerAddress ?? CCTP_TOKEN_MESSENGER);
    expect(result.cctpDestinationMessageTransmitterAddress).toBe(
      destination.messageTransmitterAddress ?? CCTP_MESSAGE_TRANSMITTER,
    );
    expect(result.approvalTxTarget).toBe(network.tokenAddress);
    expect(result.txTarget).toBe(network.tokenMessengerAddress ?? CCTP_TOKEN_MESSENGER);
    expect(approval[0]).toBe(network.tokenMessengerAddress ?? CCTP_TOKEN_MESSENGER);
    expect(deposit[1]).toBe(destination.domain);
    expect(String(deposit[3]).toLowerCase()).toBe(network.tokenAddress.toLowerCase());
  });

  it.each(CCTP_CONFIGURED_NETWORKS)('has Gateway templates for configured $gatewayNetwork CCTP USDC', (network) => {
    const repoRoot = path.resolve(__dirname, '../..');
    const chainTemplate = path.join(repoRoot, 'src/templates/chains/ethereum', `${network.gatewayNetwork}.yml`);
    const tokenTemplate = path.join(repoRoot, 'src/templates/tokens/ethereum', `${network.gatewayNetwork}.json`);
    const rootTemplate = readFileSync(path.join(repoRoot, 'src/templates/root.yml'), 'utf8');

    expect(existsSync(chainTemplate)).toBe(true);
    expect(existsSync(tokenTemplate)).toBe(true);
    expect(rootTemplate).toContain(`$namespace ethereum-${network.gatewayNetwork}:`);

    const tokens = JSON.parse(readFileSync(tokenTemplate, 'utf8'));
    expect(
      tokens.some(
        (token: { address?: string; decimals?: number; symbol?: string }) =>
          token.address?.toLowerCase() === network.tokenAddress.toLowerCase() &&
          token.decimals === 6 &&
          token.symbol === 'USDC',
      ),
    ).toBe(true);
  });

  it.each(CCTP_CONFIGURED_NETWORKS)('loads runtime chain config for configured $gatewayNetwork', (network) => {
    const repoRoot = path.resolve(__dirname, '../..');
    const chainTemplate = path.join(repoRoot, 'src/templates/chains/ethereum', `${network.gatewayNetwork}.yml`);
    const config = yaml.load(readFileSync(chainTemplate, 'utf8')) as Record<string, unknown>;

    expect(typeof config.chainID).toBe('number');
    expect(config.chainID).toBeGreaterThan(0);
    expect(config.nodeURL).toEqual(expect.stringMatching(/^https?:\/\//));
    expect(typeof config.geckoId).toBe('string');
    expect(typeof config.nativeCurrencySymbol).toBe('string');
    expect((config.nativeCurrencySymbol as string).length).toBeGreaterThan(0);
    expect(config.swapProvider).toBe('uniswap/router');
    expect(typeof config.transactionExecutionTimeoutMs).toBe('number');
    expect(config.eip1559 === true || config.eip1559 === false || config.eip1559 === undefined).toBe(true);
    if (config.eip1559 === true) {
      expect(typeof config.baseFeeMultiplier).toBe('number');
      expect(typeof config.priorityFee).toBe('number');
    }
  });

  it.each(['bsc', 'solana'])('rejects unsupported CCTP network %s before building transactions', async (network) => {
    await expect(
      buildCctpBaseArbitrumUsdcTransfer({
        ...cctpRequest(),
        sourceNetwork: network,
      }),
    ).rejects.toThrow(new RegExp(`unsupported CCTP source network: ${network}`));
  });

  it('builds CCTP EVM to Solana calldata with domain 5 and the derived USDC ATA mint recipient', async () => {
    const result = await buildCctpBaseArbitrumUsdcTransfer({
      ...cctpRequest(),
      destinationAddress: SOLANA_DESTINATION_WALLET,
      destinationNetwork: 'solana',
      provider: 'cctp_usdc',
    });
    const deposit = new utils.Interface([
      'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)',
    ]).decodeFunctionData('depositForBurn', result.txCalldata);
    const expectedAta = getAssociatedTokenAddressSync(
      new PublicKey(SOLANA_USDC_MINT),
      new PublicKey(SOLANA_DESTINATION_WALLET),
    );
    const expectedMintRecipient = `0x${Buffer.from(expectedAta.toBytes()).toString('hex')}`;

    expect(result.destinationAddress).toBe(SOLANA_DESTINATION_WALLET);
    expect(result.destinationNetwork).toBe('mainnet-beta');
    expect(result.cctpDestinationDomain).toBe(5);
    expect(result.cctpDestinationMessageTransmitterAddress).toBe(SOLANA_CCTP_MESSAGE_TRANSMITTER);
    expect(result.cctpDestinationTokenMessengerAddress).toBe(SOLANA_CCTP_TOKEN_MESSENGER);
    expect(result.cctpMintRecipient).toBe(expectedMintRecipient);
    expect(result.cctpSolanaUsdcAta).toBe(expectedAta.toBase58());
    expect(deposit[1]).toBe(5);
    expect(deposit[2]).toBe(expectedMintRecipient);
  });

  it.each(['bsc', 'starknet', 'stellar'])(
    'rejects unsupported CCTP destination network %s before building transactions',
    async (network) => {
      await expect(
        buildCctpBaseArbitrumUsdcTransfer({
          ...cctpRequest(),
          destinationNetwork: network,
        }),
      ).rejects.toThrow(new RegExp(`unsupported CCTP destination network: ${network}`));
    },
  );

  it('does not approve or burn CCTP USDC to Solana when the destination ATA or SOL gas is unavailable', async () => {
    process.env.MARLIN_RUNTIME_PROFILE = 'marlin';
    process.env.MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN = 'gateway-token';
    const sendTransaction = jest.fn();
    const getAccountInfo = jest.fn(async () => null);
    const getBalance = jest.fn(async () => 1_000_000);
    mockEthereum({
      getWallet: jest.fn(async () => ({ sendTransaction })),
      handleTransactionExecution: jest.fn(async () => ({ status: 1 })),
      prepareGasOptions: jest.fn(async () => ({ gasLimit: 120000, maxFeePerGas: BigNumber.from(10) })),
    });
    mockSolana({ connection: { getAccountInfo, getBalance } });
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    await app.ready();
    const expectedAta = getAssociatedTokenAddressSync(
      new PublicKey(SOLANA_USDC_MINT),
      new PublicKey(SOLANA_DESTINATION_WALLET),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      payload: {
        ...cctpRequest(),
        destinationAddress: SOLANA_DESTINATION_WALLET,
        destinationNetwork: 'solana-mainnet-beta',
        idempotencyKey: 'cctp-solana-destination-gas-missing',
        liveActionAuthorization: {
          ...cctpAuthorization('1.5', SOLANA_DESTINATION_WALLET),
          destination_network: 'mainnet-beta',
        },
        provider: 'cctp_usdc',
      },
    });
    const status = await app.inject({
      method: 'GET',
      url: '/bridge/rebalance/cctp-solana-destination-gas-missing',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ signature: '', status: 0 });
    expect(Solana.getInstance).toHaveBeenCalledWith('mainnet-beta');
    expect(getAccountInfo).toHaveBeenCalledWith(expectedAta);
    expect(getBalance).toHaveBeenCalledWith(new PublicKey(SOLANA_DESTINATION_WALLET));
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(status.json()).toMatchObject({
      idempotencyKey: 'cctp-solana-destination-gas-missing',
      providerStatus: 'destination_gas_unavailable',
      status: 'destination_gas_unavailable',
    });
    expect(status.json().providerError).toContain('USDC associated token account');
  });

  it('executes CCTP Base to Solana through provider-owned approve, burn, attestation, and receiveMessage', async () => {
    process.env.MARLIN_RUNTIME_PROFILE = 'marlin';
    process.env.MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN = 'gateway-token';
    const destinationWallet = Keypair.generate();
    const destinationAddress = destinationWallet.publicKey.toBase58();
    const destinationAta = getAssociatedTokenAddressSync(new PublicKey(SOLANA_USDC_MINT), destinationWallet.publicKey);
    const feeRecipient = Keypair.generate().publicKey;
    const tokenMessenger = solanaPda(new PublicKey(SOLANA_CCTP_TOKEN_MESSENGER), 'token_messenger');
    const tokenMessengerAccount = tokenMessengerAccountData(feeRecipient);
    const sendTransaction = jest
      .fn()
      .mockResolvedValueOnce({ hash: '0xapprove-solana' })
      .mockResolvedValueOnce({ hash: '0xburn-solana' });
    const getAccountInfo = jest.fn(async (address: PublicKey) => {
      if (address.equals(tokenMessenger)) {
        return { data: tokenMessengerAccount };
      }
      if (address.equals(destinationAta)) {
        return { data: Buffer.alloc(1) };
      }
      return null;
    });
    const getBalance = jest.fn(async () => 1_000_000);
    const getLatestBlockhash = jest.fn(async () => ({
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: 123,
    }));
    const confirmTransaction = jest.fn(async () => ({ value: { err: null } }));
    const simulateWithErrorHandling = jest.fn(async () => undefined);
    const sendRawTransaction = jest.fn(async () => 'solana-finalize-signature');
    mockEthereum({
      getWallet: jest.fn(async () => ({ sendTransaction })),
      handleTransactionExecution: jest.fn(async () => ({ status: 1 })),
      prepareGasOptions: jest.fn(async () => ({ gasLimit: 120000, maxFeePerGas: BigNumber.from(10) })),
    });
    mockSolana({
      connection: { confirmTransaction, getAccountInfo, getBalance, getLatestBlockhash },
      getWallet: jest.fn(async () => destinationWallet),
      sendRawTransaction,
      simulateWithErrorHandling,
    });
    mockIris(cctpSolanaIrisMessage('0xburn-solana', destinationAta.toBase58()));
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      payload: {
        ...cctpRequest(),
        destinationAddress,
        destinationNetwork: 'solana-mainnet-beta',
        idempotencyKey: 'cctp-solana-finalize',
        liveActionAuthorization: {
          ...cctpAuthorization('1.5', destinationAddress),
          destination_network: 'mainnet-beta',
        },
        provider: 'cctp_usdc',
      },
    });
    const status = await app.inject({
      method: 'GET',
      url: '/bridge/rebalance/cctp-solana-finalize',
    });
    const sentTransaction = (simulateWithErrorHandling.mock.calls as any[])[0][0];
    const receiveMessageInstruction = sentTransaction.instructions[0];
    const keys = receiveMessageInstruction.keys.map((key: any) => key.pubkey.toBase58());

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ signature: 'solana-finalize-signature', status: 1 });
    expect(sendTransaction).toHaveBeenCalledTimes(2);
    expect(simulateWithErrorHandling).toHaveBeenCalledTimes(1);
    expect(sendRawTransaction).toHaveBeenCalledWith(
      expect.anything(),
      123,
      expect.objectContaining({ destination_address: destinationAddress }),
      'cctp_usdc_rebalance',
      {
        expectedConnectorId: 'treasury',
        expectedNotional: '1.5',
        expectedWalletAddress: destinationAddress,
      },
    );
    expect(confirmTransaction).toHaveBeenCalledWith(
      {
        blockhash: '11111111111111111111111111111111',
        lastValidBlockHeight: 123,
        signature: 'solana-finalize-signature',
      },
      'confirmed',
    );
    expect(receiveMessageInstruction.programId.toBase58()).toBe(SOLANA_CCTP_MESSAGE_TRANSMITTER);
    expect(Buffer.from(receiveMessageInstruction.data.subarray(0, 8)).toString('hex')).toBe(
      anchorDiscriminatorHex('global:receive_message'),
    );
    expect(keys).toEqual([
      destinationAddress,
      destinationAddress,
      solanaPda(
        new PublicKey(SOLANA_CCTP_MESSAGE_TRANSMITTER),
        'message_transmitter_authority',
        new PublicKey(SOLANA_CCTP_TOKEN_MESSENGER).toBuffer(),
      ).toBase58(),
      solanaPda(new PublicKey(SOLANA_CCTP_MESSAGE_TRANSMITTER), 'message_transmitter').toBase58(),
      solanaPda(
        new PublicKey(SOLANA_CCTP_MESSAGE_TRANSMITTER),
        'used_nonce',
        Buffer.from(utils.arrayify(utils.hexZeroPad('0x01', 32))),
      ).toBase58(),
      SOLANA_CCTP_TOKEN_MESSENGER,
      '11111111111111111111111111111111',
      solanaPda(new PublicKey(SOLANA_CCTP_MESSAGE_TRANSMITTER), '__event_authority').toBase58(),
      SOLANA_CCTP_MESSAGE_TRANSMITTER,
      tokenMessenger.toBase58(),
      solanaPda(new PublicKey(SOLANA_CCTP_TOKEN_MESSENGER), 'remote_token_messenger', '6').toBase58(),
      solanaPda(new PublicKey(SOLANA_CCTP_TOKEN_MESSENGER), 'token_minter').toBase58(),
      solanaPda(
        new PublicKey(SOLANA_CCTP_TOKEN_MESSENGER),
        'local_token',
        new PublicKey(SOLANA_USDC_MINT).toBuffer(),
      ).toBase58(),
      solanaPda(
        new PublicKey(SOLANA_CCTP_TOKEN_MESSENGER),
        'token_pair',
        '6',
        Buffer.from(utils.arrayify(addressBytes32(BASE_USDC))),
      ).toBase58(),
      getAssociatedTokenAddressSync(new PublicKey(SOLANA_USDC_MINT), feeRecipient).toBase58(),
      destinationAta.toBase58(),
      solanaPda(
        new PublicKey(SOLANA_CCTP_TOKEN_MESSENGER),
        'custody',
        new PublicKey(SOLANA_USDC_MINT).toBuffer(),
      ).toBase58(),
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      solanaPda(new PublicKey(SOLANA_CCTP_TOKEN_MESSENGER), '__event_authority').toBase58(),
      SOLANA_CCTP_TOKEN_MESSENGER,
    ]);
    expect(status.json()).toMatchObject({
      burnTransactionHash: '0xburn-solana',
      finalizeTransactionHash: 'solana-finalize-signature',
      idempotencyKey: 'cctp-solana-finalize',
      status: 'confirmed',
    });
  });

  it('does not rebroadcast Solana receiveMessage when confirmation fails after signature submission', async () => {
    process.env.MARLIN_RUNTIME_PROFILE = 'marlin';
    process.env.MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN = 'gateway-token';
    const destinationWallet = Keypair.generate();
    const destinationAddress = destinationWallet.publicKey.toBase58();
    const destinationAta = getAssociatedTokenAddressSync(new PublicKey(SOLANA_USDC_MINT), destinationWallet.publicKey);
    const feeRecipient = Keypair.generate().publicKey;
    const tokenMessenger = solanaPda(new PublicKey(SOLANA_CCTP_TOKEN_MESSENGER), 'token_messenger');
    const sendTransaction = jest
      .fn()
      .mockResolvedValueOnce({ hash: '0xapprove-solana-unknown' })
      .mockResolvedValueOnce({ hash: '0xburn-solana-unknown' });
    const getAccountInfo = jest.fn(async (address: PublicKey) => {
      if (address.equals(tokenMessenger)) {
        return { data: tokenMessengerAccountData(feeRecipient) };
      }
      if (address.equals(destinationAta)) {
        return { data: Buffer.alloc(1) };
      }
      return null;
    });
    const getLatestBlockhash = jest.fn(async () => ({
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: 123,
    }));
    const confirmTransaction = jest.fn(async () => {
      throw new Error('Solana confirmation provider timeout');
    });
    const sendRawTransaction = jest.fn(async () => 'solana-finalize-unknown-signature');
    mockEthereum({
      getWallet: jest.fn(async () => ({ sendTransaction })),
      handleTransactionExecution: jest.fn(async () => ({ status: 1 })),
      prepareGasOptions: jest.fn(async () => ({ gasLimit: 120000, maxFeePerGas: BigNumber.from(10) })),
    });
    mockSolana({
      connection: {
        confirmTransaction,
        getAccountInfo,
        getBalance: jest.fn(async () => 1_000_000),
        getLatestBlockhash,
      },
      getWallet: jest.fn(async () => destinationWallet),
      sendRawTransaction,
      simulateWithErrorHandling: jest.fn(async () => undefined),
    });
    mockIris(cctpSolanaIrisMessage('0xburn-solana-unknown', destinationAta.toBase58()));
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    await app.ready();
    const payload = {
      ...cctpRequest(),
      destinationAddress,
      destinationNetwork: 'solana-mainnet-beta',
      idempotencyKey: 'cctp-solana-finalize-unknown',
      liveActionAuthorization: {
        ...cctpAuthorization('1.5', destinationAddress),
        destination_network: 'mainnet-beta',
      },
      provider: 'cctp_usdc',
    };

    const first = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      payload,
    });
    const retry = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      payload,
    });
    const status = await app.inject({
      method: 'GET',
      url: '/bridge/rebalance/cctp-solana-finalize-unknown',
    });

    expect(first.statusCode).toBe(500);
    expect(retry.json()).toMatchObject({ signature: 'solana-finalize-unknown-signature', status: 0 });
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(status.json()).toMatchObject({
      finalizeTransactionHash: 'solana-finalize-unknown-signature',
      status: 'finalize_submitted',
    });
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
      'cctp_usdc_rebalance',
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

  it('does not burn CCTP USDC on retry after approval hash is submitted but receipt is unknown', async () => {
    process.env.MARLIN_RUNTIME_PROFILE = 'marlin';
    process.env.MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN = 'gateway-token';
    const sendTransaction = jest.fn().mockResolvedValueOnce({ hash: '0xapproval-unknown' });
    mockEthereum({
      getWallet: jest.fn(async () => ({ sendTransaction })),
      handleTransactionExecution: jest.fn().mockRejectedValueOnce(new Error('approval receipt timeout')),
      prepareGasOptions: jest.fn(async () => ({ gasLimit: 120000, maxFeePerGas: BigNumber.from(10) })),
    });
    const app = Fastify();
    await app.register(rebalanceRoutes, { prefix: '/bridge' });
    await app.ready();
    const payload = {
      ...cctpRequest(),
      idempotencyKey: 'cctp-approval-submitted-retry',
      liveActionAuthorization: cctpAuthorization('1.5'),
    };

    const first = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      payload,
    });
    const retry = await app.inject({
      method: 'POST',
      url: '/bridge/rebalance/execute',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      payload,
    });

    expect(first.statusCode).toBe(500);
    expect(retry.json()).toMatchObject({ signature: '0xapproval-unknown', status: 0 });
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

function mockSolana(overrides: Record<string, unknown> = {}) {
  const solana = {
    connection: {
      getAccountInfo: jest.fn(async () => ({})),
      getBalance: jest.fn(async () => 1_000_000),
    },
    network: 'mainnet-beta',
    ...overrides,
  };
  (Solana.getInstance as jest.Mock).mockResolvedValue(solana as unknown as Solana);
  return solana;
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

function cctpSolanaIrisMessage(_burnTransactionHash: string, mintRecipient: string) {
  const message = cctpSolanaMessageBytes(mintRecipient);
  return {
    messages: [
      {
        attestation: `0x${'11'.repeat(65)}`,
        cctpVersion: 2,
        decodedMessage: {
          sourceDomain: '6',
          destinationDomain: '5',
          sender: CCTP_TOKEN_MESSENGER,
          recipient: SOLANA_CCTP_TOKEN_MESSENGER,
          destinationCaller: '11111111111111111111111111111111',
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

function cctpSolanaMessageBytes(mintRecipient: string): string {
  return utils.hexConcat([
    uint32(1),
    uint32(6),
    uint32(5),
    utils.hexZeroPad('0x01', 32),
    addressBytes32(CCTP_TOKEN_MESSENGER),
    publicKeyBytes32(new PublicKey(SOLANA_CCTP_TOKEN_MESSENGER)),
    utils.hexZeroPad('0x', 32),
    uint32(2000),
    uint32(2000),
    uint32(1),
    addressBytes32(BASE_USDC),
    publicKeyBytes32(new PublicKey(mintRecipient)),
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

function publicKeyBytes32(publicKey: PublicKey): string {
  return `0x${Buffer.from(publicKey.toBytes()).toString('hex')}`;
}

function uint32(value: number): string {
  return utils.hexZeroPad(utils.hexlify(value), 4);
}

function solanaPda(programId: PublicKey, label: string, ...extraSeeds: (Buffer | string)[]): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(label, 'utf8'),
      ...extraSeeds.map((seed) => (typeof seed === 'string' ? Buffer.from(seed, 'utf8') : seed)),
    ],
    programId,
  )[0];
}

function tokenMessengerAccountData(feeRecipient: PublicKey): Buffer {
  const data = Buffer.alloc(174);
  data.set(feeRecipient.toBytes(), 109);
  return data;
}

function anchorDiscriminatorHex(name: string): string {
  return createHash('sha256').update(name).digest().subarray(0, 8).toString('hex');
}

function cleanupRebalanceState() {
  for (const id of REBALANCE_STATE_IDS) {
    rmSync(path.resolve(process.cwd(), 'conf/marlin/rebalances', `${id}.json`), { force: true });
    rmSync(path.resolve(process.cwd(), 'conf/marlin/rebalances', `${id}.json.tmp`), { force: true });
  }
}
