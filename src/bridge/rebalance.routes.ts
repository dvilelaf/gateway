import { createHash } from 'crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';

import { Static, Type } from '@sinclair/typebox';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import { BigNumber, utils } from 'ethers';
import { FastifyPluginAsync } from 'fastify';

import { Ethereum } from '../chains/ethereum/ethereum';
import { Solana } from '../chains/solana/solana';
import { Uniswap } from '../connectors/uniswap/uniswap';
import { UniswapConfig } from '../connectors/uniswap/uniswap.config';
import { ChainExecuteSwapResponseSchema } from '../schemas/chain-schema';
import {
  LiveActionAuthorization,
  assertMainnetMutationAllowed,
  marlinGatewayProviderIntentTokenMatches,
  marlinProviderIntentAuthorizationMatches,
} from '../services/runtime-guard';

const MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN_HEADER = 'x-marlin-gateway-provider-intent-token';
const HYPERLIQUID_BRIDGE2_ADDRESS = '0x2df1c51e09aecf9cacb7bc98cb1742757f163df7';
const ARBITRUM_USDC_ADDRESS = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const CCTP_V2_TOKEN_MESSENGER_ADDRESS = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d';
const CCTP_V2_MESSAGE_TRANSMITTER_ADDRESS = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64';
const CCTP_SOLANA_DOMAIN = 5;
const CCTP_SOLANA_MESSAGE_TRANSMITTER_V2_PROGRAM = 'CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC';
const CCTP_SOLANA_TOKEN_MESSENGER_MINTER_V2_PROGRAM = 'CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe';
const SOLANA_MAINNET_BETA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BASE_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_WETH_ADDRESS = '0x4200000000000000000000000000000000000006';
const CCTP_STANDARD_FINALITY_THRESHOLD = 2000;
const CCTP_MESSAGE_NONCE_OFFSET = 12;
const CCTP_MESSAGE_SENDER_OFFSET = 44;
const CCTP_BURN_MESSAGE_BURN_TOKEN_OFFSET = 152;
const CCTP_SOLANA_TOKEN_MESSENGER_FEE_RECIPIENT_OFFSET = 109;
const HYPERLIQUID_BRIDGE2_MIN_USDC = '5';
const HYPERLIQUID_BRIDGE2_GAS_LIMIT = 120000;
const CCTP_APPROVE_GAS_LIMIT = 90000;
const CCTP_BURN_GAS_LIMIT = 220000;
const CCTP_FINALIZE_GAS_LIMIT = 300000;
const CCTP_IRIS_MAINNET_URL = 'https://iris-api.circle.com';
const CCTP_DESTINATION_GAS_PROVIDER_STATUS = 'destination_gas_unavailable';
const USDC_DECIMALS = 6;
const CCTP_USDC_PROVIDER = 'cctp_usdc';
const CCTP_BASE_ARBITRUM_USDC_PROVIDER = 'cctp_base_arbitrum_usdc';
const CCTP_USDC_PROVIDER_INTENT_SOURCE = 'cctp_usdc_rebalance';
const SQUID_ROUTER_PROVIDER = 'squid_router';
const SQUID_ROUTER_PROVIDER_INTENT_SOURCE = 'squid_router_rebalance';
const SQUID_ROUTER_MAINNET_URL = 'https://v2.api.squidrouter.com';
const SQUID_ROUTER_GAS_LIMIT = 450000;
const SQUID_ROUTER_APPROVE_GAS_LIMIT = 90000;
const SQUID_NATIVE_TOKEN_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const SQUID_NATIVE_ASSET_DECIMALS = 18;
const PROVIDER_TREASURY_SAME_CHAIN_SWAP = 'provider_treasury_same_chain_swap';
const TARGET_FUNDING_BLOCKER = 'insufficient_source_or_gas';
const TARGET_FUNDING_GAS_BUFFER_NUMERATOR = 12;
const TARGET_FUNDING_GAS_BUFFER_DENOMINATOR = 10;
const SQUID_INVERSE_QUOTE_MAX_EXPANSIONS = 32;
const SQUID_INVERSE_QUOTE_MAX_BISECTIONS = 24;
const PROVIDER_TREASURY_SAME_CHAIN_SWAP_GAS_LIMIT = 450000;
const PROVIDER_TREASURY_WRAP_GAS_LIMIT = 90000;
const ARBITRUM_WETH_ADDRESS = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
const UNISWAP_V3_SWAP_ROUTER_02_ARBITRUM = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
const UNISWAP_WETH_USDC_ARBITRUM_FEE = 500;
const CCTP_REGISTRY_VERSION = 'cctp-v2-evm-usdc-configured-2026-07-08';
const RAW_TRANSACTION_PAYLOAD_FIELDS = [
  'txTarget',
  'txCalldata',
  'txValue',
  'routePayload',
  'routePayloadHash',
  'gasLimit',
  'privateKey',
  'mnemonic',
  'walletFile',
];

const SQUID_EVM_USDC_ASSETS = {
  arbitrum: ARBITRUM_USDC_ADDRESS,
  avalanche: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
  base: BASE_USDC_ADDRESS,
  mainnet: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  optimism: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  polygon: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
} as const;
const TARGET_FUNDING_EVM_SOURCE_NETWORKS = ['arbitrum', 'base', 'mainnet', 'optimism', 'polygon', 'avalanche'] as const;
const TARGET_FUNDING_EVM_USDC_SOURCES = TARGET_FUNDING_EVM_SOURCE_NETWORKS.map((network) => ({
  network,
  tokenAddress: SQUID_EVM_USDC_ASSETS[network],
}));

const CCTP_EVM_USDC_NETWORKS = {
  arbitrum: cctpEvmUsdcNetwork(3, 'arbitrum', ARBITRUM_USDC_ADDRESS),
  avalanche: cctpEvmUsdcNetwork(1, 'avalanche', '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E'),
  base: cctpEvmUsdcNetwork(6, 'base', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
  codex: cctpEvmUsdcNetwork(12, 'codex', '0xd996633a415985DBd7D6D12f4A4343E31f5037cf'),
  cronos: cctpEvmUsdcNetwork(32, 'cronos', '0x3D7F2C478aAfdB65542BCB44bCeeC05849999d2D'),
  edge: cctpEvmUsdcNetwork(
    28,
    'edge',
    '0x98d2919b9A214E6Fa5384AC81E6864bA686Ad74c',
    '0x98706A006bc632Df31CAdFCBD43F38887ce2ca5c',
    '0x5b61381Fc9e58E70EfC13a4A97516997019198ee',
  ),
  ethereum: cctpEvmUsdcNetwork(0, 'mainnet', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'),
  hyperevm: cctpEvmUsdcNetwork(19, 'hyperevm', '0xb88339CB7199b77E23DB6E890353E22632Ba630f'),
  injective: cctpEvmUsdcNetwork(29, 'injective', '0xa00C59fF5a080D2b954d0c75e46E22a0c371235a'),
  ink: cctpEvmUsdcNetwork(21, 'ink', '0x2D270e6886d130D724215A266106e6832161EAEd'),
  linea: cctpEvmUsdcNetwork(11, 'linea', '0x176211869cA2b568f2A7D4EE941E073a821EE1ff'),
  mainnet: cctpEvmUsdcNetwork(0, 'mainnet', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'),
  monad: cctpEvmUsdcNetwork(15, 'monad', '0x754704Bc059F8C67012fEd69BC8A327a5aafb603'),
  morph: cctpEvmUsdcNetwork(30, 'morph', '0xCfb1186F4e93D60E60a8bDd997427D1F33bc372B'),
  optimism: cctpEvmUsdcNetwork(2, 'optimism', '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'),
  'op-mainnet': cctpEvmUsdcNetwork(2, 'optimism', '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'),
  pharos: cctpEvmUsdcNetwork(31, 'pharos', '0xC879C018dB60520F4355C26eD1a6D572cdAC1815'),
  plume: cctpEvmUsdcNetwork(22, 'plume', '0x222365EF19F7947e5484218551B56bb3965Aa7aF'),
  polygon: cctpEvmUsdcNetwork(7, 'polygon', '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'),
  sei: cctpEvmUsdcNetwork(16, 'sei', '0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392'),
  sonic: cctpEvmUsdcNetwork(13, 'sonic', '0x29219dd400f2Bf60E5a23d13Be72B486D4038894'),
  unichain: cctpEvmUsdcNetwork(10, 'unichain', '0x078D782b760474a361dDA0AF3839290b0EF57AD6'),
  'world-chain': cctpEvmUsdcNetwork(14, 'world-chain', '0x79a02482a880bce3f13e09da970dc34db4cd24d1'),
  xdc: cctpEvmUsdcNetwork(18, 'xdc', '0xfA2958CB79b0491CC627c1557F441eF849Ca8eb1'),
};

const CCTP_SOLANA_USDC_DESTINATION_NETWORKS = {
  solana: cctpSolanaUsdcDestinationNetwork(),
  'solana-mainnet-beta': cctpSolanaUsdcDestinationNetwork(),
  'mainnet-beta': cctpSolanaUsdcDestinationNetwork(),
};

const HyperliquidBridge2RebalanceRequestSchema = Type.Object(
  {
    provider: Type.Literal('hyperliquid_bridge2'),
    idempotencyKey: Type.String({ minLength: 1 }),
    mode: Type.Literal('mainnet'),
    sourceChain: Type.Literal('ethereum'),
    sourceNetwork: Type.Literal('arbitrum'),
    sourceAsset: Type.Literal('USDC'),
    destinationVenue: Type.Literal('hyperliquid'),
    destinationAsset: Type.Literal('USDC'),
    walletAddress: Type.String({ minLength: 1 }),
    destinationAddress: Type.String({ minLength: 1 }),
    amount: Type.String({ minLength: 1 }),
    liveActionAuthorization: Type.Optional(Type.Any()),
  },
  { additionalProperties: false },
);

const CctpBaseArbitrumRebalanceRequestSchema = Type.Object(
  {
    provider: Type.Union([Type.Literal(CCTP_BASE_ARBITRUM_USDC_PROVIDER), Type.Literal(CCTP_USDC_PROVIDER)]),
    idempotencyKey: Type.String({ minLength: 1 }),
    mode: Type.Literal('mainnet'),
    sourceChain: Type.Literal('ethereum'),
    sourceNetwork: Type.String({ minLength: 1 }),
    sourceAsset: Type.Literal('USDC'),
    destinationNetwork: Type.String({ minLength: 1 }),
    destinationAsset: Type.Literal('USDC'),
    walletAddress: Type.String({ minLength: 1 }),
    destinationAddress: Type.String({ minLength: 1 }),
    amount: Type.String({ minLength: 1 }),
    liveActionAuthorization: Type.Optional(Type.Any()),
  },
  { additionalProperties: false },
);

const SquidRouterRebalanceRequestSchema = Type.Object(
  {
    provider: Type.Literal(SQUID_ROUTER_PROVIDER),
    idempotencyKey: Type.String({ minLength: 1 }),
    mode: Type.Literal('mainnet'),
    sourceChain: Type.Literal('ethereum'),
    sourceNetwork: Type.String({ minLength: 1 }),
    sourceAsset: Type.String({ minLength: 1 }),
    sourceAssetDecimals: Type.Optional(
      Type.Union([Type.Number({ minimum: 0, maximum: 36 }), Type.String({ minLength: 1 })]),
    ),
    destinationChain: Type.String({ minLength: 1 }),
    destinationNetwork: Type.String({ minLength: 1 }),
    destinationAsset: Type.String({ minLength: 1 }),
    walletAddress: Type.String({ minLength: 1 }),
    destinationAddress: Type.String({ minLength: 1 }),
    amount: Type.String({ minLength: 1 }),
    liveActionAuthorization: Type.Optional(Type.Any()),
  },
  { additionalProperties: false },
);

const BridgeRebalanceRequestSchema = Type.Object(
  {
    provider: Type.Union([
      Type.Literal('hyperliquid_bridge2'),
      Type.Literal(SQUID_ROUTER_PROVIDER),
      Type.Literal(PROVIDER_TREASURY_SAME_CHAIN_SWAP),
    ]),
    idempotencyKey: Type.String({ minLength: 1 }),
    mode: Type.Literal('mainnet'),
    sourceChain: Type.Literal('ethereum'),
    sourceNetwork: Type.String({ minLength: 1 }),
    sourceAsset: Type.String({ minLength: 1 }),
    sourceAssetDecimals: Type.Optional(
      Type.Union([Type.Number({ minimum: 0, maximum: 36 }), Type.String({ minLength: 1 })]),
    ),
    destinationAsset: Type.String({ minLength: 1 }),
    walletAddress: Type.String({ minLength: 1 }),
    destinationAddress: Type.String({ minLength: 1 }),
    amount: Type.String({ minLength: 1 }),
    destinationChain: Type.Optional(Type.String({ minLength: 1 })),
    destinationNetwork: Type.Optional(Type.String({ minLength: 1 })),
    destinationVenue: Type.Optional(Type.String({ minLength: 1 })),
    liveActionAuthorization: Type.Optional(Type.Any()),
  },
  { additionalProperties: false },
);

const TargetFundingRequestSchema = Type.Object(
  {
    idempotencyKey: Type.String({ minLength: 1 }),
    mode: Type.Literal('mainnet'),
    destinationChain: Type.String({ minLength: 1 }),
    destinationNetwork: Type.String({ minLength: 1 }),
    destinationAsset: Type.String({ minLength: 1 }),
    destinationAddress: Type.String({ minLength: 1 }),
    targetNotionalEur: Type.String({ minLength: 1 }),
    destinationAmount: Type.Optional(Type.String({ minLength: 1 })),
    maxCostBps: Type.Optional(Type.Union([Type.Number({ minimum: 0, maximum: 10000 }), Type.String({ minLength: 1 })])),
    provider: Type.Optional(Type.Never()),
    gasLimit: Type.Optional(Type.Never()),
    mnemonic: Type.Optional(Type.Never()),
    privateKey: Type.Optional(Type.Never()),
    routePayload: Type.Optional(Type.Never()),
    routePayloadHash: Type.Optional(Type.Never()),
    sourceAsset: Type.Optional(Type.Never()),
    sourceAssetDecimals: Type.Optional(Type.Never()),
    sourceChain: Type.Optional(Type.Never()),
    sourceNetwork: Type.Optional(Type.Never()),
    txCalldata: Type.Optional(Type.Never()),
    txTarget: Type.Optional(Type.Never()),
    txValue: Type.Optional(Type.Never()),
    walletAddress: Type.Optional(Type.Never()),
    walletFile: Type.Optional(Type.Never()),
  },
  { additionalProperties: false },
);

const TargetFundingBlockerResponseSchema = Type.Object({
  error: Type.Literal('Conflict'),
  message: Type.Literal(TARGET_FUNDING_BLOCKER),
  statusCode: Type.Literal(409),
});

const BridgeRebalanceExecutionStatusSchema = Type.Object({
  idempotencyKey: Type.String(),
  status: Type.String(),
  amount: Type.Optional(Type.String()),
  approvalTransactionHash: Type.Optional(Type.String()),
  burnTransactionHash: Type.Optional(Type.String()),
  destinationAddress: Type.Optional(Type.String()),
  destinationAsset: Type.Optional(Type.String()),
  destinationChain: Type.Optional(Type.String()),
  destinationNetwork: Type.Optional(Type.String()),
  destinationVenue: Type.Optional(Type.String()),
  finalizeTransactionHash: Type.Optional(Type.String()),
  provider: Type.Optional(Type.String()),
  transactionHash: Type.Optional(Type.String()),
  wrapTransactionHash: Type.Optional(Type.String()),
  sourceChain: Type.Optional(Type.String()),
  sourceNetwork: Type.Optional(Type.String()),
  providerStatus: Type.Optional(Type.String()),
  providerError: Type.Optional(Type.String()),
});

const BridgeRebalanceBuildResponseSchema = Type.Object({
  provider: Type.String(),
  idempotencyKey: Type.String(),
  sourceChain: Type.Literal('ethereum'),
  sourceNetwork: Type.String(),
  sourceAsset: Type.String(),
  destinationVenue: Type.Optional(Type.String()),
  destinationChain: Type.Optional(Type.String()),
  destinationNetwork: Type.Optional(Type.String()),
  destinationAsset: Type.String(),
  walletAddress: Type.String(),
  destinationAddress: Type.String(),
  amount: Type.String(),
  txTarget: Type.String(),
  txCalldataHash: Type.String(),
  txValueHash: Type.Optional(Type.String()),
  approvalTxTarget: Type.Optional(Type.String()),
  approvalCalldataHash: Type.Optional(Type.String()),
  minAmount: Type.String(),
  providerRouteId: Type.Optional(Type.String()),
  quoteId: Type.Optional(Type.String()),
  sourceAmount: Type.Optional(Type.String()),
  quotedAt: Type.Optional(Type.String()),
  quotedProviderCostUsd: Type.Optional(Type.String()),
  quotedGasCostUsd: Type.Optional(Type.String()),
  destinationAmount: Type.Optional(Type.String()),
  quotedNativeGasAmount: Type.Optional(Type.String()),
  quotedNativeGasAsset: Type.Optional(Type.String()),
});

type BridgeRebalanceRequest = Static<typeof BridgeRebalanceRequestSchema>;
type BridgeRebalanceStatus = Static<typeof BridgeRebalanceExecutionStatusSchema>;
type TargetFundingRequest = Static<typeof TargetFundingRequestSchema>;
type HyperliquidBridge2RebalanceRequest = Static<typeof HyperliquidBridge2RebalanceRequestSchema>;
type CctpBaseArbitrumRebalanceRequest = Static<typeof CctpBaseArbitrumRebalanceRequestSchema>;
type SquidRouterRebalanceRequest = Static<typeof SquidRouterRebalanceRequestSchema>;

const erc20Interface = new utils.Interface(['function transfer(address to, uint256 amount) returns (bool)']);
const erc20ApprovalInterface = new utils.Interface([
  'function approve(address spender, uint256 amount) returns (bool)',
]);
const wethInterface = new utils.Interface(['function deposit() payable']);
const uniswapV3SwapRouter02Interface = new utils.Interface([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
]);
const cctpTokenMessengerInterface = new utils.Interface([
  'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)',
]);
const cctpMessageTransmitterInterface = new utils.Interface([
  'function receiveMessage(bytes message, bytes attestation) returns (bool)',
]);

export const rebalanceRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: TargetFundingRequest }>(
    '/rebalance/targets',
    {
      schema: {
        description: 'Build and persist a provider-owned route for a destination funding need.',
        tags: ['/bridge'],
        body: TargetFundingRequestSchema,
        response: {
          200: BridgeRebalanceBuildResponseSchema,
          409: TargetFundingBlockerResponseSchema,
        },
      },
    },
    async (request, reply) =>
      withRebalanceLock(request.body.idempotencyKey, async () => {
        try {
          const built = await loadOrBuildTargetFunding(request.body);
          return rebalanceBuildResponse(built);
        } catch (error) {
          if (error instanceof TargetFundingBlockedError) {
            return reply.status(409).send(targetFundingBlockerResponse());
          }
          throw error;
        }
      }),
  );

  fastify.post<{ Params: { idempotencyKey: string } }>(
    '/rebalance/targets/:idempotencyKey/execute',
    {
      schema: {
        description: 'Execute the immutable provider selection persisted for a destination funding need.',
        tags: ['/bridge'],
        params: Type.Object({ idempotencyKey: Type.String({ minLength: 1 }) }),
        response: {
          200: ChainExecuteSwapResponseSchema,
          409: TargetFundingBlockerResponseSchema,
        },
      },
    },
    async (request, reply) =>
      withRebalanceLock(request.params.idempotencyKey, async () => {
        try {
          return await executePersistedTargetFunding(
            request.params.idempotencyKey,
            request.headers[MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN_HEADER],
          );
        } catch (error) {
          if (error instanceof TargetFundingBlockedError) {
            return reply.status(409).send(targetFundingBlockerResponse());
          }
          throw error;
        }
      }),
  );

  fastify.post<{ Body: BridgeRebalanceRequest }>(
    '/rebalance/build',
    {
      schema: {
        description: 'Build a provider-owned treasury rebalance route.',
        tags: ['/bridge'],
        body: BridgeRebalanceRequestSchema,
        response: { 200: BridgeRebalanceBuildResponseSchema },
      },
      preValidation: rejectRawTransactionPayloadFields,
    },
    async (request) => {
      const built = await buildProviderOwnedRebalance(request.body);
      const state = await loadOrCreateRebalanceState(built, request.body);
      await saveRebalanceState({
        ...state,
        idempotencyKey: request.body.idempotencyKey,
        status: state.status,
      });
      return rebalanceBuildResponse(built);
    },
  );

  fastify.post<{ Body: BridgeRebalanceRequest }>(
    '/rebalance/execute',
    {
      schema: {
        description: 'Execute a provider-owned treasury rebalance route.',
        tags: ['/bridge'],
        body: BridgeRebalanceRequestSchema,
        response: { 200: ChainExecuteSwapResponseSchema },
      },
      preValidation: rejectRawTransactionPayloadFields,
    },
    async (request) =>
      withRebalanceLock(request.body.idempotencyKey, async () => {
        const built = await buildProviderOwnedRebalance(request.body);
        const existing = await loadOrCreateRebalanceState(built, request.body, {
          allowUnsubmittedRefresh: request.body.provider === SQUID_ROUTER_PROVIDER,
        });
        const existingHash = bestKnownTransactionHash(existing);
        const wrapAmbiguousRecoverable =
          ['wrap_submitted', 'wrap_submission_pending', 'wrap_submission_ambiguous'].includes(existing.status) &&
          existing.wrapSignedTransaction &&
          existing.wrapTransactionHash;
        if (
          existing.status === 'confirmed' ||
          existing.status === 'failed' ||
          (isRebalanceSubmissionInDoubt(existing.status) && !wrapAmbiguousRecoverable)
        ) {
          return {
            signature: existingHash,
            status: existing.status === 'confirmed' ? 1 : existing.status === 'failed' ? -1 : 0,
          };
        }
        const tokenAuthorized = marlinGatewayProviderIntentTokenMatches(
          request.headers[MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN_HEADER],
        );
        const liveActionAuthorization =
          tokenAuthorized &&
          marlinProviderIntentAuthorizationMatches(request.body.liveActionAuthorization as LiveActionAuthorization, {
            action: 'gateway_rebalance',
            connector_id: providerTreasuryConnectorId(request.body.provider),
            network: built.sourceNetwork,
            notional: request.body.amount,
            scope: 'provider_treasury',
            source: 'marlin',
            wallet_address: request.body.walletAddress,
          })
            ? (request.body.liveActionAuthorization as LiveActionAuthorization)
            : undefined;
        if (!liveActionAuthorization) {
          throw new Error('provider treasury authorization required');
        }
        assertCctpDestinationAuthorization(built, liveActionAuthorization);

        assertMainnetMutationAllowed({
          chain: 'ethereum',
          expectedConnectorId: providerTreasuryConnectorId(request.body.provider),
          expectedNotional: request.body.amount,
          expectedWalletAddress: request.body.walletAddress,
          internalProviderIntentSource: providerTreasuryIntentSource(request.body.provider),
          liveActionAuthorization,
          network: built.sourceNetwork,
          operation: 'ethereum_transaction',
        });
        try {
          const execution = await executeProviderOwnedRebalance(built, liveActionAuthorization, existing);
          const status = execution.status;
          await saveRebalanceState({
            ...existing,
            approvalTransactionHash: execution.approvalTransactionHash,
            burnTransactionHash: execution.burnTransactionHash,
            cctpAttestation: execution.cctpAttestation,
            cctpMessage: execution.cctpMessage,
            cctpMessageHash: execution.cctpMessageHash,
            finalizeTransactionHash: execution.finalizeTransactionHash,
            idempotencyKey: request.body.idempotencyKey,
            providerError: execution.providerError,
            providerStatus: execution.providerStatus,
            status,
            transactionHash: execution.transactionHash || bestKnownTransactionHash(existing),
            wrapTransactionHash: execution.wrapTransactionHash ?? existing.wrapTransactionHash,
          });
          return { signature: execution.transactionHash, status: execution.responseStatus };
        } catch (error: any) {
          const latest = (await readRebalanceState(request.body.idempotencyKey)) ?? existing;
          const retryableCctpStatus = recoverableRebalanceErrorStatus(latest);
          await saveRebalanceState({
            ...latest,
            idempotencyKey: request.body.idempotencyKey,
            providerError: redactProviderError(error),
            status: retryableCctpStatus,
          });
          throw new Error(redactProviderError(error));
        }
      }),
  );

  fastify.get<{ Params: { idempotencyKey: string } }>(
    '/rebalance/:idempotencyKey',
    {
      schema: {
        description: 'Return provider-owned treasury rebalance status.',
        tags: ['/bridge'],
        params: Type.Object({ idempotencyKey: Type.String({ minLength: 1 }) }),
        response: { 200: BridgeRebalanceExecutionStatusSchema },
      },
    },
    async (request) =>
      (await refreshRebalanceStatus(request.params.idempotencyKey)) ?? {
        idempotencyKey: request.params.idempotencyKey,
        status: 'not_found',
      },
  );
};

type BuiltProviderOwnedRebalance = {
  amount: string;
  approvalCalldataHash?: string;
  approvalTxCalldata?: string;
  approvalTxTarget?: string;
  destinationAddress: string;
  destinationAsset: string;
  destinationNetwork?: string;
  destinationVenue?: string;
  idempotencyKey: string;
  minAmount: string;
  provider: 'hyperliquid_bridge2' | 'cctp_usdc' | 'squid_router' | typeof PROVIDER_TREASURY_SAME_CHAIN_SWAP;
  sourceAsset: string;
  sourceAmount?: string;
  sourceChain: 'ethereum';
  sourceNetwork: string;
  tokenAddress: string;
  txCalldata: string;
  txCalldataHash: string;
  txTarget: string;
  txValue?: string;
  txValueHash?: string;
  walletAddress: string;
  wrapTxCalldata?: string;
  wrapTxCalldataHash?: string;
  wrapTxTarget?: string;
  wrapTxValue?: string;
  wrapTxValueHash?: string;
  cctpDestinationDomain?: number;
  cctpDestinationMessageTransmitterAddress?: string;
  cctpDestinationTokenMessengerAddress?: string;
  cctpMintRecipient?: string;
  cctpSolanaUsdcAta?: string;
  cctpSourceDomain?: number;
  cctpSourceTokenMessengerAddress?: string;
  destinationChain?: string;
  providerRouteId?: string;
  quoteId?: string;
  quotedAt?: string;
  quotedProviderCostUsd?: string;
  quotedGasCostUsd?: string;
  squidDestinationChainId?: string;
  squidSourceChainId?: string;
  squidStatusRequestId?: string;
  providerDestinationAmount?: string;
  destinationAmount?: string;
  quotedNativeGasAmount?: string;
  quotedNativeGasAsset?: string;
};

type ProviderOwnedRebalanceExecution = {
  approvalTransactionHash?: string;
  burnTransactionHash?: string;
  cctpAttestation?: string;
  cctpMessage?: string;
  cctpMessageHash?: string;
  finalizeTransactionHash?: string;
  providerError?: string;
  providerStatus?: string;
  responseStatus: -1 | 0 | 1;
  status: string;
  transactionHash: string;
  wrapTransactionHash?: string;
};

type DurableRebalanceState = BridgeRebalanceStatus & {
  approvalSignedTransaction?: string;
  amount: string;
  burnTransactionHash?: string;
  cctpAttestation?: string;
  cctpMessage?: string;
  cctpMessageHash?: string;
  cctpMintRecipient?: string;
  cctpSolanaUsdcAta?: string;
  destinationAmount?: string;
  destinationChain?: string;
  destinationAddress: string;
  destinationAsset: string;
  destinationNetwork?: string;
  destinationVenue?: string;
  finalizeTransactionHash?: string;
  provider: BuiltProviderOwnedRebalance['provider'];
  providerRouteId?: string;
  quoteId?: string;
  quotedAt?: string;
  quotedProviderCostUsd?: string;
  quotedGasCostUsd?: string;
  squidDestinationChainId?: string;
  squidSourceChainId?: string;
  requestFingerprint: string;
  sourceAmount?: string;
  squidStatusRequestId?: string;
  sourceChain: string;
  sourceNetwork: string;
  txCalldataHash?: string;
  txTarget?: string;
  txValueHash?: string;
  walletAddress: string;
  wrapTransactionHash?: string;
  wrapSignedTransaction?: string;
  builtRebalance?: BuiltProviderOwnedRebalance;
  targetRequestFingerprint?: string;
  maxCostBps?: string;
  signedTransaction?: string;
  quotedNativeGasAmount?: string;
  quotedNativeGasAsset?: string;
};

type TargetFundingDestination = {
  canonicalChain: 'ethereum' | 'solana';
  canonicalNetwork: 'arbitrum' | 'base' | 'mainnet-beta';
  destinationAsset: 'USDC' | 'WETH';
  destinationAssetAddress: string;
  destinationAssetDecimals: number;
  destinationChain: 'ethereum' | 'hyperliquid' | 'solana';
  destinationNetwork: string;
  provider: 'hyperliquid_bridge2' | 'squid_router';
};

type TargetFundingSource = (typeof TARGET_FUNDING_EVM_USDC_SOURCES)[number] & {
  walletAddress: string;
};

class TargetFundingBlockedError extends Error {
  constructor() {
    super(TARGET_FUNDING_BLOCKER);
    this.name = 'TargetFundingBlockedError';
  }
}

type CircleCctpMessagesResponse = {
  messages?: CircleCctpMessage[];
};

type CircleCctpMessage = {
  attestation?: unknown;
  cctpVersion?: unknown;
  decodedMessage?: {
    sourceDomain?: unknown;
    destinationDomain?: unknown;
    sender?: unknown;
    recipient?: unknown;
    destinationCaller?: unknown;
    messageBody?: unknown;
    decodedMessageBody?: {
      burnToken?: unknown;
      mintRecipient?: unknown;
      amount?: unknown;
      messageSender?: unknown;
    };
  };
  message?: unknown;
  status?: unknown;
};

type CctpEvmUsdcNetwork = {
  chain: 'ethereum';
  domain: number;
  gatewayNetwork: string;
  messageTransmitterAddress: string;
  tokenAddress: string;
  tokenMessengerAddress: string;
};

type CctpSolanaUsdcDestinationNetwork = {
  chain: 'solana';
  domain: number;
  gatewayNetwork: string;
  messageTransmitterAddress: string;
  tokenMessengerAddress: string;
  usdcMintAddress: string;
};

type CctpUsdcDestinationNetwork = CctpEvmUsdcNetwork | CctpSolanaUsdcDestinationNetwork;

type SquidCostEntry = {
  amountUsd?: unknown;
};

type SquidRouteQuoteResponse = {
  estimate?: {
    toAmount?: unknown;
    feeCosts?: SquidCostEntry[];
    gasCosts?: SquidCostEntry[];
  };
  id?: unknown;
  quoteId?: unknown;
  routeId?: unknown;
  requestId?: unknown;
  route?: {
    estimate?: {
      toAmount?: unknown;
      feeCosts?: SquidCostEntry[];
      gasCosts?: SquidCostEntry[];
    };
    id?: unknown;
    quoteId?: unknown;
    requestId?: unknown;
    transactionRequest?: SquidTransactionRequest;
  };
  transactionRequest?: SquidTransactionRequest;
  xRequestId?: string;
};

type SquidTransactionRequest = {
  data?: unknown;
  target?: unknown;
  to?: unknown;
  value?: unknown;
};

const rebalanceLocks = new Map<string, Promise<void>>();

function rebalanceBuildResponse(built: BuiltProviderOwnedRebalance) {
  return {
    amount: built.amount,
    destinationAddress: built.destinationAddress,
    destinationAsset: built.destinationAsset,
    destinationChain: built.destinationChain,
    destinationNetwork: built.destinationNetwork,
    destinationVenue: built.destinationVenue,
    idempotencyKey: built.idempotencyKey,
    minAmount: built.minAmount,
    provider: built.provider,
    approvalCalldataHash: built.approvalCalldataHash,
    approvalTxTarget: built.approvalTxTarget,
    providerRouteId: built.providerRouteId,
    quoteId: built.quoteId,
    sourceAmount: built.sourceAmount,
    sourceAsset: built.sourceAsset,
    sourceChain: built.sourceChain,
    sourceNetwork: built.sourceNetwork,
    txCalldataHash: built.txCalldataHash,
    txTarget: built.txTarget,
    txValueHash: built.txValueHash,
    walletAddress: built.walletAddress,
    quotedAt: built.provider === PROVIDER_TREASURY_SAME_CHAIN_SWAP ? undefined : built.quotedAt,
    quotedProviderCostUsd: built.quotedProviderCostUsd,
    quotedGasCostUsd: built.quotedGasCostUsd,
    destinationAmount: built.destinationAmount,
    quotedNativeGasAmount: built.quotedNativeGasAmount,
    quotedNativeGasAsset: built.quotedNativeGasAsset,
  };
}

async function loadOrBuildTargetFunding(body: TargetFundingRequest): Promise<BuiltProviderOwnedRebalance> {
  const destination = resolveTargetFundingDestination(body);
  const maxCostBps = normalizeMaxCostBps(body.maxCostBps);
  const canonicalDestinationAddress = await canonicalTargetFundingWalletAddress(
    destination.canonicalChain,
    destination.canonicalNetwork,
  );
  if (!targetFundingAddressesEqual(body.destinationAddress, canonicalDestinationAddress, destination.canonicalChain)) {
    throw new Error('destinationAddress does not match the canonical MARLIN_MNEMONIC wallet');
  }
  const targetRequestFingerprint = targetFundingRequestFingerprint(
    body,
    destination,
    canonicalDestinationAddress,
    maxCostBps,
  );
  const existing = await readRebalanceState(body.idempotencyKey);
  if (existing) {
    if (existing.targetRequestFingerprint !== targetRequestFingerprint || !existing.builtRebalance) {
      throw new Error('idempotency key already used for a different rebalance request');
    }
    assertPersistedTargetFundingIntegrity(existing);
    return existing.builtRebalance;
  }

  const built = await selectAndBuildTargetFunding(body, destination, canonicalDestinationAddress, maxCostBps);
  const state: DurableRebalanceState = {
    ...newRebalanceState(
      built,
      { idempotencyKey: body.idempotencyKey } as BridgeRebalanceRequest,
      rebalanceRequestFingerprint(built),
    ),
    builtRebalance: built,
    maxCostBps,
    targetRequestFingerprint,
  };
  await saveRebalanceState(state);
  return built;
}

async function selectAndBuildTargetFunding(
  body: TargetFundingRequest,
  destination: TargetFundingDestination,
  destinationAddress: string,
  maxCostBps: string | undefined,
): Promise<BuiltProviderOwnedRebalance> {
  const sourceBudgetUnits = utils.parseUnits(body.targetNotionalEur, USDC_DECIMALS);
  if (sourceBudgetUnits.lte(0)) {
    throw new Error('target funding notional must be positive');
  }
  const hasDestinationAmount = body.destinationAmount !== undefined;
  const destinationAmountUnits = hasDestinationAmount
    ? utils.parseUnits(body.destinationAmount, destination.destinationAssetDecimals)
    : undefined;
  const sourceAmount = utils.formatUnits(sourceBudgetUnits, USDC_DECIMALS);

  const sourceContexts =
    destination.provider === 'hyperliquid_bridge2'
      ? TARGET_FUNDING_EVM_USDC_SOURCES.filter((source) => source.network === 'arbitrum')
      : TARGET_FUNDING_EVM_USDC_SOURCES.filter((source) => source.network !== destination.canonicalNetwork);
  let providerError: unknown;
  let fundedSourceFound = false;
  let sourceBalanceUnavailable = false;
  for (const sourceContext of sourceContexts) {
    const source: TargetFundingSource = {
      ...sourceContext,
      walletAddress: await canonicalTargetFundingWalletAddress('ethereum', sourceContext.network),
    };
    const gasLimit =
      destination.provider === 'hyperliquid_bridge2'
        ? HYPERLIQUID_BRIDGE2_GAS_LIMIT
        : SQUID_ROUTER_APPROVE_GAS_LIMIT + SQUID_ROUTER_GAS_LIMIT;
    let squidBuild: BuiltProviderOwnedRebalance | undefined;
    let candidateSourceAmountUnits = sourceBudgetUnits;
    if (
      destination.provider === SQUID_ROUTER_PROVIDER &&
      destination.destinationAsset !== 'USDC' &&
      hasDestinationAmount
    ) {
      try {
        await provisionTargetFundingSourceWallet(source);
        squidBuild = await buildInverseQuotedSquidTargetFunding(
          body,
          destination,
          destinationAddress,
          source,
          destinationAmountUnits,
          maxCostBps,
        );
        candidateSourceAmountUnits = utils.parseUnits(squidBuild.amount, USDC_DECIMALS);
        if (candidateSourceAmountUnits.gt(sourceBudgetUnits)) {
          providerError = new Error('target funding source budget exceeded for inverse-quoted route');
          continue;
        }
      } catch (error) {
        providerError = error;
        continue;
      }
    }
    const sourceStatus = await targetFundingSourceStatus(source, candidateSourceAmountUnits, gasLimit);
    if (sourceStatus.status === 'unavailable') {
      sourceBalanceUnavailable = true;
      continue;
    }
    if (sourceStatus.status === 'insufficient') {
      continue;
    }
    fundedSourceFound = true;
    if (!squidBuild) {
      await provisionTargetFundingSourceWallet(source);
    }
    if (destination.provider === 'hyperliquid_bridge2') {
      const bridgeAmount = utils.formatUnits(sourceBudgetUnits, USDC_DECIMALS);
      const built = await buildHyperliquidBridge2Transfer({
        amount: bridgeAmount,
        destinationAddress,
        destinationAsset: 'USDC',
        destinationVenue: 'hyperliquid',
        idempotencyKey: body.idempotencyKey,
        mode: 'mainnet',
        provider: 'hyperliquid_bridge2',
        sourceAsset: 'USDC',
        sourceChain: 'ethereum',
        sourceNetwork: 'arbitrum',
        walletAddress: source.walletAddress,
      });
      return {
        ...built,
        destinationChain: destination.destinationChain,
        destinationNetwork: destination.destinationNetwork,
        quotedNativeGasAmount: utils.formatEther(sourceStatus.requiredGas!),
        quotedNativeGasAsset: 'ETH',
        quotedAt: sourceStatus.quotedAt!,
      };
    }
    try {
      const built =
        squidBuild ??
        (await buildSquidRouterRebalance({
          amount: sourceAmount,
          destinationAddress,
          destinationAsset: destination.destinationAssetAddress,
          destinationChain: destination.canonicalChain,
          destinationNetwork: destination.canonicalNetwork,
          idempotencyKey: body.idempotencyKey,
          mode: 'mainnet',
          provider: SQUID_ROUTER_PROVIDER,
          sourceAsset: source.tokenAddress,
          sourceAssetDecimals: USDC_DECIMALS,
          sourceChain: 'ethereum',
          sourceNetwork: source.network,
          walletAddress: source.walletAddress,
        }));
      if (built.quotedProviderCostUsd === undefined) {
        throw new Error('Squid route missing feeCosts');
      }
      if (built.quotedGasCostUsd === undefined) {
        throw new Error('Squid route missing gasCosts');
      }
      if (
        hasDestinationAmount &&
        (!built.providerDestinationAmount || BigNumber.from(built.providerDestinationAmount).lt(destinationAmountUnits))
      ) {
        throw new Error('Squid route exceeds maxCostBps or does not satisfy destination funding amount');
      }
      if (!hasDestinationAmount && built.providerDestinationAmount === undefined) {
        throw new Error('Squid route did not return a destination amount');
      }
      const destinationAmount =
        built.providerDestinationAmount !== undefined
          ? utils.formatUnits(built.providerDestinationAmount, destination.destinationAssetDecimals)
          : undefined;
      return {
        ...built,
        amount: hasDestinationAmount
          ? body.destinationAmount!
          : utils.formatUnits(built.providerDestinationAmount!, destination.destinationAssetDecimals),
        destinationAmount,
        destinationAsset: destination.destinationAsset,
        destinationChain: destination.destinationChain,
        destinationNetwork: destination.destinationNetwork,
        sourceAmount: built.amount,
      };
    } catch (error) {
      providerError = error;
    }
  }
  if (!fundedSourceFound) {
    if (sourceBalanceUnavailable) {
      throw new Error('target funding source balance unavailable');
    }
    throw new TargetFundingBlockedError();
  }
  throw providerError instanceof Error ? providerError : new Error('provider target funding route unavailable');
}

async function buildInverseQuotedSquidTargetFunding(
  body: TargetFundingRequest,
  destination: TargetFundingDestination,
  destinationAddress: string,
  source: TargetFundingSource,
  destinationAmountUnits: BigNumber,
  maxCostBps: string | undefined,
): Promise<BuiltProviderOwnedRebalance> {
  const quote = (amountUnits: BigNumber) =>
    buildSquidRouterRebalance({
      amount: utils.formatUnits(amountUnits, USDC_DECIMALS),
      destinationAddress,
      destinationAsset: destination.destinationAssetAddress,
      destinationChain: destination.canonicalChain,
      destinationNetwork: destination.canonicalNetwork,
      idempotencyKey: body.idempotencyKey,
      mode: 'mainnet',
      provider: SQUID_ROUTER_PROVIDER,
      sourceAsset: source.tokenAddress,
      sourceAssetDecimals: USDC_DECIMALS,
      sourceChain: 'ethereum',
      sourceNetwork: source.network,
      walletAddress: source.walletAddress,
    });
  const satisfiesTarget = (built: BuiltProviderOwnedRebalance) =>
    built.providerDestinationAmount !== undefined &&
    BigNumber.from(built.providerDestinationAmount).gte(destinationAmountUnits);

  let low = BigNumber.from(0);
  let high = utils.parseUnits('1', USDC_DECIMALS);
  let sufficient: BuiltProviderOwnedRebalance | undefined;
  for (let attempt = 0; attempt < SQUID_INVERSE_QUOTE_MAX_EXPANSIONS; attempt += 1) {
    const built = await quote(high);
    if (satisfiesTarget(built)) {
      sufficient = built;
      break;
    }
    low = high;
    high = high.mul(2);
  }
  if (!sufficient) {
    throw new Error('Squid route could not bound destination funding amount');
  }

  for (let attempt = 0; attempt < SQUID_INVERSE_QUOTE_MAX_BISECTIONS && high.sub(low).gt(1); attempt += 1) {
    const midpoint = low.add(high).div(2);
    const built = await quote(midpoint);
    if (satisfiesTarget(built)) {
      high = midpoint;
      sufficient = built;
    } else {
      low = midpoint;
    }
  }

  const selectedSourceAmount = targetFundingSourceAmountUnits(high, maxCostBps);
  if (selectedSourceAmount.eq(high) && sufficient.amount === utils.formatUnits(high, USDC_DECIMALS)) {
    return sufficient;
  }
  const selected = await quote(selectedSourceAmount);
  if (!satisfiesTarget(selected)) {
    throw new Error('Squid route exceeds maxCostBps or does not satisfy destination funding amount');
  }
  return selected;
}

type TargetFundingSourceStatusResult = {
  status: 'funded' | 'insufficient' | 'unavailable';
  requiredGas?: BigNumber;
  quotedAt?: string;
};

async function targetFundingSourceStatus(
  source: TargetFundingSource,
  amountUnits: BigNumber,
  gasLimit: number,
): Promise<TargetFundingSourceStatusResult> {
  try {
    const ethereum = await Ethereum.getInstance(source.network);
    const token = ethereum.getContract(source.tokenAddress, ethereum.provider);
    const [nativeBalance, tokenBalance, gasPrice] = await Promise.all([
      ethereum.getNativeBalanceByAddress(source.walletAddress),
      ethereum.getERC20BalanceByAddress(token, source.walletAddress, USDC_DECIMALS, 5000, 'USDC'),
      ethereum.provider.getGasPrice(),
    ]);
    const requiredGas = BigNumber.from(gasPrice)
      .mul(gasLimit)
      .mul(TARGET_FUNDING_GAS_BUFFER_NUMERATOR)
      .div(TARGET_FUNDING_GAS_BUFFER_DENOMINATOR);
    const quotedAt = new Date().toISOString();
    return BigNumber.from(tokenBalance.value).gte(amountUnits) && BigNumber.from(nativeBalance.value).gte(requiredGas)
      ? { status: 'funded', requiredGas, quotedAt }
      : { status: 'insufficient', requiredGas, quotedAt };
  } catch {
    return { status: 'unavailable' };
  }
}

async function executePersistedTargetFunding(idempotencyKey: string, providerIntentToken: unknown) {
  let state = await readRebalanceState(idempotencyKey);
  if (!state?.builtRebalance || !state.targetRequestFingerprint) {
    throw new Error('target funding selection not found');
  }
  assertPersistedTargetFundingIntegrity(state);
  const built = state.builtRebalance;
  const existingHash = bestKnownTransactionHash(state);
  if (state.status === 'confirmed' || state.status === 'failed') {
    return {
      signature: existingHash,
      status: state.status === 'confirmed' ? 1 : state.status === 'failed' ? -1 : 0,
    };
  }
  if (!marlinGatewayProviderIntentTokenMatches(providerIntentToken)) {
    throw new Error('provider treasury authorization required');
  }
  const source = {
    network: built.sourceNetwork,
    tokenAddress: built.tokenAddress,
    walletAddress: built.walletAddress,
  } as TargetFundingSource;
  const gasLimit =
    built.provider === SQUID_ROUTER_PROVIDER
      ? SQUID_ROUTER_APPROVE_GAS_LIMIT + SQUID_ROUTER_GAS_LIMIT
      : HYPERLIQUID_BRIDGE2_GAS_LIMIT;
  const sourceAmount = built.sourceAmount ?? built.amount;
  if (!state.signedTransaction && !state.transactionHash) {
    const sourceStatus = await targetFundingSourceStatus(
      source,
      utils.parseUnits(sourceAmount, USDC_DECIMALS),
      gasLimit,
    );
    if (sourceStatus.status === 'unavailable') {
      throw new Error('target funding source balance unavailable');
    }
    if (sourceStatus.status === 'insufficient') {
      throw new TargetFundingBlockedError();
    }
    if (built.provider === 'hyperliquid_bridge2') {
      const quotedNativeGasAmount = built.quotedNativeGasAmount;
      const quotedNativeGasAsset = built.quotedNativeGasAsset;
      const quotedAt = built.quotedAt;
      if (!quotedNativeGasAmount || !quotedNativeGasAsset || !quotedAt) {
        throw new Error('target funding Bridge2 native gas estimate missing');
      }
      if (quotedNativeGasAsset !== 'ETH') {
        throw new Error('target funding Bridge2 native gas asset must be ETH');
      }
      const quotedTimestamp = new Date(quotedAt).getTime();
      if (!Number.isFinite(quotedTimestamp) || quotedTimestamp > Date.now()) {
        throw new Error('target funding Bridge2 quote timestamp invalid');
      }
      const freshGasWei = sourceStatus.requiredGas!;
      const persistedGasWei = utils.parseEther(quotedNativeGasAmount);
      if (freshGasWei.gt(persistedGasWei)) {
        throw new TargetFundingBlockedError();
      }
    }
  }
  await provisionTargetFundingSourceWallet(source);
  const liveActionAuthorization: LiveActionAuthorization = {
    action: 'gateway_rebalance',
    connector_id: providerTreasuryConnectorId(built.provider),
    network: built.sourceNetwork,
    notional: sourceAmount,
    scope: 'provider_treasury',
    source: 'marlin',
    wallet_address: built.walletAddress,
  };
  assertMainnetMutationAllowed({
    chain: 'ethereum',
    expectedConnectorId: providerTreasuryConnectorId(built.provider),
    expectedNotional: sourceAmount,
    expectedWalletAddress: built.walletAddress,
    internalProviderIntentSource: providerTreasuryIntentSource(built.provider),
    liveActionAuthorization,
    network: built.sourceNetwork,
    operation: 'ethereum_transaction',
  });
  try {
    const execution = await executeProviderOwnedRebalance(built, liveActionAuthorization, state);
    const latest = (await readRebalanceState(idempotencyKey)) ?? state;
    state = {
      ...latest,
      approvalTransactionHash: execution.approvalTransactionHash,
      providerError: execution.providerError,
      providerStatus: execution.providerStatus,
      status: execution.status,
      transactionHash: execution.transactionHash || bestKnownTransactionHash(state),
    };
    await saveRebalanceState(state);
    return { signature: execution.transactionHash, status: execution.responseStatus };
  } catch (error) {
    const latest = (await readRebalanceState(idempotencyKey)) ?? state;
    await saveRebalanceState({
      ...latest,
      providerError: redactProviderError(error),
      status: recoverableRebalanceErrorStatus(latest),
    });
    throw new Error(redactProviderError(error));
  }
}

function resolveTargetFundingDestination(body: TargetFundingRequest): TargetFundingDestination {
  const chain = body.destinationChain.trim().toLowerCase();
  const network = body.destinationNetwork.trim().toLowerCase();
  const asset = body.destinationAsset.trim().toUpperCase();
  if (chain === 'hyperliquid' && network === 'mainnet' && asset === 'USDC') {
    return {
      canonicalChain: 'ethereum',
      canonicalNetwork: 'arbitrum',
      destinationAsset: 'USDC',
      destinationAssetAddress: ARBITRUM_USDC_ADDRESS,
      destinationAssetDecimals: USDC_DECIMALS,
      destinationChain: 'hyperliquid',
      destinationNetwork: 'mainnet',
      provider: 'hyperliquid_bridge2',
    };
  }
  if (
    ((chain === 'ethereum' && ['base', 'base-mainnet'].includes(network)) ||
      (chain === 'base' && ['mainnet', 'base', 'base-mainnet'].includes(network))) &&
    (asset === 'USDC' || asset === 'WETH')
  ) {
    return {
      canonicalChain: 'ethereum',
      canonicalNetwork: 'base',
      destinationAsset: asset,
      destinationAssetAddress: asset === 'USDC' ? BASE_USDC_ADDRESS : BASE_WETH_ADDRESS,
      destinationAssetDecimals: asset === 'USDC' ? USDC_DECIMALS : 18,
      destinationChain: 'ethereum',
      destinationNetwork: 'base',
      provider: SQUID_ROUTER_PROVIDER,
    };
  }
  if (chain === 'solana' && ['mainnet-beta', 'solana-mainnet-beta', 'solana'].includes(network) && asset === 'USDC') {
    return {
      canonicalChain: 'solana',
      canonicalNetwork: 'mainnet-beta',
      destinationAsset: 'USDC',
      destinationAssetAddress: SOLANA_MAINNET_BETA_USDC_MINT,
      destinationAssetDecimals: USDC_DECIMALS,
      destinationChain: 'solana',
      destinationNetwork: 'mainnet-beta',
      provider: SQUID_ROUTER_PROVIDER,
    };
  }
  throw new Error('unsupported target funding destination asset');
}

async function provisionTargetFundingSourceWallet(source: TargetFundingSource): Promise<void> {
  const { ensureMarlinWalletExists, marlinWalletPolicyFor } = await import('../wallet/routes/setMarlinDefault');
  const policy = marlinWalletPolicyFor('ethereum', source.network);
  if (!policy) {
    throw new Error(`canonical wallet policy unavailable for ethereum/${source.network}`);
  }
  await ensureMarlinWalletExists({
    address: utils.getAddress(source.walletAddress),
    chain: 'ethereum',
    network: source.network,
    walletRef: policy.walletRef,
  });
}

async function canonicalTargetFundingWalletAddress(chain: 'ethereum' | 'solana', network: string): Promise<string> {
  const { deriveMarlinDefaultWalletMaterial, marlinWalletPolicyFor, normalizedMnemonicFromEnv } = await import(
    '../wallet/routes/setMarlinDefault'
  );
  const policy = marlinWalletPolicyFor(chain, network);
  if (!policy) {
    throw new Error(`canonical wallet policy unavailable for ${chain}/${network}`);
  }
  return deriveMarlinDefaultWalletMaterial(normalizedMnemonicFromEnv(), policy).address;
}

function targetFundingAddressesEqual(left: string, right: string, chain: 'ethereum' | 'solana'): boolean {
  if (chain === 'solana') {
    return left.trim() === right.trim();
  }
  return addressesEqual(left, right);
}

function normalizeMaxCostBps(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > 10000) {
    throw new Error('maxCostBps must be between 0 and 10000');
  }
  return String(value).trim();
}

function targetFundingSourceAmountUnits(destinationAmountUnits: BigNumber, maxCostBps: string | undefined): BigNumber {
  if (maxCostBps === undefined) {
    return destinationAmountUnits;
  }
  const scale = BigNumber.from(10).pow(6);
  const denominator = BigNumber.from(10000).mul(scale);
  const maxCost = utils.parseUnits(maxCostBps, 6);
  return destinationAmountUnits.mul(denominator.add(maxCost)).add(denominator.sub(1)).div(denominator);
}

function targetFundingRequestFingerprint(
  body: TargetFundingRequest,
  destination: TargetFundingDestination,
  destinationAddress: string,
  maxCostBps: string | undefined,
): string {
  return utils.keccak256(
    utils.toUtf8Bytes(
      JSON.stringify({
        targetNotionalEur: body.targetNotionalEur,
        destinationAmount: body.destinationAmount,
        destinationAddress,
        destinationAsset: destination.destinationAsset,
        destinationChain: destination.destinationChain,
        destinationNetwork: destination.destinationNetwork,
        maxCostBps,
        mode: body.mode,
      }),
    ),
  );
}

function targetFundingBlockerResponse() {
  return { error: 'Conflict' as const, message: TARGET_FUNDING_BLOCKER, statusCode: 409 as const };
}

function assertPersistedTargetFundingIntegrity(state: DurableRebalanceState): void {
  if (!state.builtRebalance || state.requestFingerprint !== rebalanceRequestFingerprint(state.builtRebalance)) {
    throw new Error('persisted target funding selection fingerprint mismatch');
  }
}

export async function buildProviderOwnedRebalance(body: BridgeRebalanceRequest): Promise<BuiltProviderOwnedRebalance> {
  if (body.provider === SQUID_ROUTER_PROVIDER) {
    return buildSquidRouterRebalance(body as SquidRouterRebalanceRequest);
  }
  if (body.provider === PROVIDER_TREASURY_SAME_CHAIN_SWAP) {
    return buildProviderTreasurySameChainSwap(body);
  }
  if (body.provider !== 'hyperliquid_bridge2') {
    throw new Error('CCTP treasury rebalance is disabled; use squid_router');
  }
  return buildHyperliquidBridge2Transfer(body as HyperliquidBridge2RebalanceRequest);
}

export async function buildProviderTreasurySameChainSwap(
  body: BridgeRebalanceRequest,
): Promise<BuiltProviderOwnedRebalance> {
  if (body.sourceChain !== 'ethereum' || body.sourceNetwork.trim().toLowerCase() !== 'arbitrum') {
    throw new Error('same-chain treasury swap supports only ethereum/arbitrum');
  }
  if (body.destinationNetwork !== undefined && body.destinationNetwork.trim().toLowerCase() !== 'arbitrum') {
    throw new Error('same-chain treasury swap destinationNetwork must be arbitrum');
  }
  const walletAddress = utils.getAddress(body.walletAddress);
  const destinationAddress = utils.getAddress(body.destinationAddress);
  if (walletAddress !== destinationAddress) {
    throw new Error('same-chain treasury swap destinationAddress must equal walletAddress');
  }
  const sourceAsset = normalizeSameChainSwapSourceAsset(body.sourceAsset);
  if (!sameChainDestinationIsArbitrumUsdc(body.destinationAsset)) {
    throw new Error('same-chain treasury swap destinationAsset must be Arbitrum USDC');
  }
  const amountUnits = utils.parseUnits(body.amount, 18);
  if (amountUnits.lte(0)) {
    throw new Error('same-chain treasury swap amount must be positive');
  }

  const slippagePct = UniswapConfig.config.slippagePct;
  if (typeof slippagePct !== 'number' || !Number.isFinite(slippagePct) || slippagePct < 0 || slippagePct > 100) {
    throw new Error('same-chain treasury swap Uniswap slippagePct must be a valid percentage between 0 and 100');
  }

  const uniswap = await Uniswap.getInstance('arbitrum');
  const quotedAmountOut = await uniswap.quoteExactInputSingle(
    ARBITRUM_WETH_ADDRESS,
    ARBITRUM_USDC_ADDRESS,
    UNISWAP_WETH_USDC_ARBITRUM_FEE,
    amountUnits,
  );
  if (quotedAmountOut.isZero()) {
    throw new Error('same-chain treasury swap Uniswap V3 quote is zero');
  }

  const slippageBps = Math.round(slippagePct * 100);
  const minAmountUnits = quotedAmountOut.mul(10000 - slippageBps).div(10000);
  if (minAmountUnits.isZero()) {
    throw new Error('same-chain treasury swap minimum output is zero after slippage');
  }

  const minAmountFormatted = utils.formatUnits(minAmountUnits, USDC_DECIMALS);
  const destinationAmountFormatted = utils.formatUnits(quotedAmountOut, USDC_DECIMALS);
  const quotedAt = new Date().toISOString();

  const wrapTxCalldata = sourceAsset === 'ETH' ? wethInterface.encodeFunctionData('deposit') : undefined;
  const wrapTxValue = sourceAsset === 'ETH' ? amountUnits.toString() : undefined;
  const approvalTxCalldata = erc20ApprovalInterface.encodeFunctionData('approve', [
    UNISWAP_V3_SWAP_ROUTER_02_ARBITRUM,
    amountUnits,
  ]);
  const txCalldata = uniswapV3SwapRouter02Interface.encodeFunctionData('exactInputSingle', [
    {
      amountIn: amountUnits,
      amountOutMinimum: minAmountUnits,
      fee: UNISWAP_WETH_USDC_ARBITRUM_FEE,
      recipient: walletAddress,
      sqrtPriceLimitX96: BigNumber.from(0),
      tokenIn: ARBITRUM_WETH_ADDRESS,
      tokenOut: ARBITRUM_USDC_ADDRESS,
    },
  ]);
  return {
    amount: body.amount,
    approvalCalldataHash: utils.keccak256(approvalTxCalldata),
    approvalTxCalldata,
    approvalTxTarget: ARBITRUM_WETH_ADDRESS,
    destinationAddress,
    destinationAmount: destinationAmountFormatted,
    destinationAsset: 'USDC',
    destinationNetwork: 'arbitrum',
    idempotencyKey: body.idempotencyKey,
    minAmount: minAmountFormatted,
    provider: PROVIDER_TREASURY_SAME_CHAIN_SWAP,
    quotedAt,
    sourceAsset,
    sourceChain: 'ethereum',
    sourceNetwork: 'arbitrum',
    tokenAddress: ARBITRUM_WETH_ADDRESS,
    txCalldata,
    txCalldataHash: utils.keccak256(txCalldata),
    txTarget: UNISWAP_V3_SWAP_ROUTER_02_ARBITRUM,
    txValue: '0',
    txValueHash: transactionValueHash('0'),
    walletAddress,
    wrapTxCalldata,
    wrapTxCalldataHash: wrapTxCalldata ? utils.keccak256(wrapTxCalldata) : undefined,
    wrapTxTarget: wrapTxCalldata ? ARBITRUM_WETH_ADDRESS : undefined,
    wrapTxValue,
    wrapTxValueHash: wrapTxValue ? transactionValueHash(wrapTxValue) : undefined,
  };
}

export async function buildSquidRouterRebalance(
  body: SquidRouterRebalanceRequest,
): Promise<BuiltProviderOwnedRebalance> {
  const sourceAsset = normalizeSquidSourceAsset(body.sourceAsset);
  const sourceAssetDecimals = squidSourceAssetDecimals(sourceAsset, body.sourceNetwork, body.sourceAssetDecimals);
  const amountUnits = utils.parseUnits(body.amount, sourceAssetDecimals);
  if (amountUnits.lte(0)) {
    throw new Error('Squid Router rebalance amount must be positive');
  }
  const walletAddress = utils.getAddress(body.walletAddress);
  const destinationAddress = requireNonEmptyText(body.destinationAddress, 'Squid destination address');
  const destinationChain = requireNonEmptyText(body.destinationChain, 'Squid destination chain');
  const squidSourceChainId = resolveSquidSourceChainId(body.sourceChain, body.sourceNetwork);
  const squidDestinationChainId = resolveSquidDestinationChainId(destinationChain, body.destinationNetwork);
  const quote = await fetchSquidRouteQuote(
    body,
    walletAddress,
    destinationAddress,
    amountUnits.toString(),
    squidSourceChainId,
    squidDestinationChainId,
    sourceAsset,
  );
  const transactionRequest = quote.route?.transactionRequest ?? quote.transactionRequest;
  const txTarget = requireAddress(transactionRequest?.target ?? transactionRequest?.to, 'Squid transaction target');
  const txCalldata = requireHex(transactionRequest?.data, 'Squid transaction calldata');
  const txValue = normalizeTransactionValue(transactionRequest?.value ?? '0');
  const approvalTxCalldata = isSquidNativeToken(sourceAsset)
    ? undefined
    : erc20ApprovalInterface.encodeFunctionData('approve', [txTarget, amountUnits]);
  const routeEstimate = quote.route?.estimate ?? quote.estimate;
  const providerCostUsd = sumSquidCostUsd(routeEstimate?.feeCosts);
  const gasCostUsd = sumSquidCostUsd(routeEstimate?.gasCosts);
  return {
    approvalCalldataHash: approvalTxCalldata ? utils.keccak256(approvalTxCalldata) : undefined,
    approvalTxCalldata,
    approvalTxTarget: isSquidNativeToken(sourceAsset) ? undefined : sourceAsset,
    amount: body.amount,
    destinationAddress,
    destinationAsset: body.destinationAsset,
    destinationChain,
    destinationNetwork: body.destinationNetwork,
    idempotencyKey: body.idempotencyKey,
    minAmount: '0.000001',
    provider: SQUID_ROUTER_PROVIDER,
    providerDestinationAmount: optionalText(routeEstimate?.toAmount),
    providerRouteId: optionalText(quote.route?.id ?? quote.routeId ?? quote.id),
    quoteId: optionalText(quote.route?.quoteId ?? quote.quoteId ?? quote.route?.requestId ?? quote.requestId),
    quotedAt: new Date().toISOString(),
    quotedProviderCostUsd: providerCostUsd,
    quotedGasCostUsd: gasCostUsd,
    sourceAsset,
    sourceChain: 'ethereum',
    sourceNetwork: body.sourceNetwork,
    squidDestinationChainId,
    squidSourceChainId,
    squidStatusRequestId: optionalText(
      quote.xRequestId ?? quote.route?.requestId ?? quote.requestId ?? quote.route?.id ?? quote.id,
    ),
    tokenAddress: sourceAsset,
    txCalldata,
    txCalldataHash: utils.keccak256(txCalldata),
    txTarget,
    txValue,
    txValueHash: transactionValueHash(txValue),
    walletAddress,
  };
}

async function fetchSquidRouteQuote(
  body: SquidRouterRebalanceRequest,
  walletAddress: string,
  destinationAddress: string,
  amountUnits: string,
  squidSourceChainId: string,
  squidDestinationChainId: string,
  sourceAsset: string,
): Promise<SquidRouteQuoteResponse> {
  const response = await fetch(squidApiUrl('/v2/route').toString(), {
    body: JSON.stringify({
      fromAddress: walletAddress,
      fromAmount: amountUnits,
      fromChain: squidSourceChainId,
      fromToken: sourceAsset,
      toAddress: destinationAddress,
      toChain: squidDestinationChainId,
      toToken: body.destinationAsset,
    }),
    headers: squidHeaders(),
    method: 'POST',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw new Error(`Squid route lookup failed with HTTP ${response.status}`);
  }
  const quote = (await response.json()) as SquidRouteQuoteResponse;
  return {
    ...quote,
    xRequestId: optionalText(response.headers.get('x-request-id') ?? response.headers.get('X-Request-Id')),
  };
}

async function fetchSquidRouteStatus(
  state: DurableRebalanceState,
): Promise<{ providerError?: string; status: string }> {
  const url = squidApiUrl('/v2/status');
  url.searchParams.set('transactionId', state.transactionHash as string);
  url.searchParams.set('requestId', state.squidStatusRequestId as string);
  url.searchParams.set('fromChainId', state.squidSourceChainId as string);
  url.searchParams.set('toChainId', state.squidDestinationChainId as string);
  url.searchParams.set('quoteId', state.quoteId as string);
  const response = await fetch(url.toString(), {
    headers: squidHeaders(),
    method: 'GET',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw new Error(`Squid status lookup failed with HTTP ${response.status}`);
  }
  const body = (await response.json()) as Record<string, unknown>;
  return {
    providerError: body.error === undefined ? undefined : redactProviderError(body.error),
    status: String(body.squidTransactionStatus ?? body.routeStatus ?? body.status ?? 'UNKNOWN'),
  };
}

function squidApiUrl(route: string): URL {
  return new URL(route, (process.env.SQUID_API_BASE_URL ?? SQUID_ROUTER_MAINNET_URL).trim());
}

function squidHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-integrator-id': (process.env.SQUID_INTEGRATOR_ID ?? 'marlin').trim() || 'marlin',
  };
}

function resolveSquidSourceChainId(chain: string, network: string): string {
  const normalizedChain = chain.trim().toLowerCase();
  if (normalizedChain !== 'ethereum') {
    throw new Error('Squid Router source chain currently supports EVM execution only');
  }
  return squidEvmChainId(network);
}

function resolveSquidDestinationChainId(chain: string, network: string): string {
  const normalizedChain = chain.trim().toLowerCase();
  const normalizedNetwork = network.trim().toLowerCase();
  if (normalizedChain === 'ethereum') {
    return squidEvmChainId(network);
  }
  const solanaNetworks = ['solana', 'mainnet-beta', 'solana-mainnet-beta'];
  if (normalizedChain === 'solana' && solanaNetworks.includes(normalizedNetwork)) {
    return 'solana';
  }
  const xrplNetworks = ['xrpl', 'xrpl-mainnet', 'mainnet'];
  if (normalizedChain === 'xrpl' && xrplNetworks.includes(normalizedNetwork)) {
    return 'xrpl';
  }
  throw new Error('unsupported Squid Router destination network');
}

function squidEvmChainId(network: string): string {
  const normalizedNetwork = network.trim().toLowerCase();
  const evmNetworks: Record<string, string> = {
    arbitrum: '42161',
    avalanche: '43114',
    base: '8453',
    bsc: '56',
    mainnet: '1',
    optimism: '10',
    polygon: '137',
  };
  const chainId = evmNetworks[normalizedNetwork];
  if (!chainId) {
    throw new Error('unsupported Squid Router EVM network');
  }
  return chainId;
}

function isSquidNativeToken(value: string): boolean {
  return value.trim().toLowerCase() === SQUID_NATIVE_TOKEN_ADDRESS.toLowerCase();
}

function normalizeSquidSourceAsset(value: string): string {
  if (isSquidNativeToken(value)) {
    return SQUID_NATIVE_TOKEN_ADDRESS;
  }
  return requireAddress(value, 'Squid source asset');
}

function squidSourceAssetDecimals(sourceAsset: string, sourceNetwork: string, override: unknown): number {
  if (override !== undefined) {
    const decimals = Number(override);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
      throw new Error('Squid source asset decimals must be an integer between 0 and 36');
    }
    return decimals;
  }
  if (isSquidNativeToken(sourceAsset)) {
    return SQUID_NATIVE_ASSET_DECIMALS;
  }
  const known = knownSquidSourceAssetDecimals(sourceNetwork, sourceAsset);
  if (known !== undefined) {
    return known;
  }
  throw new Error('Squid ERC20 source asset decimals required for unknown token');
}

function knownSquidSourceAssetDecimals(sourceNetwork: string, sourceAsset: string): number | undefined {
  const network = sourceNetwork.trim().toLowerCase();
  const asset = sourceAsset.trim().toLowerCase();
  const tokenAddress = SQUID_EVM_USDC_ASSETS[network as keyof typeof SQUID_EVM_USDC_ASSETS];
  return tokenAddress?.toLowerCase() === asset ? USDC_DECIMALS : undefined;
}

export async function buildHyperliquidBridge2Transfer(
  body: HyperliquidBridge2RebalanceRequest,
): Promise<BuiltProviderOwnedRebalance> {
  if (!addressesEqual(body.walletAddress, body.destinationAddress)) {
    throw new Error('hyperliquid Bridge2 credits sender; destinationAddress must equal walletAddress');
  }
  const amountUnits = utils.parseUnits(body.amount, USDC_DECIMALS);
  const minimumUnits = utils.parseUnits(HYPERLIQUID_BRIDGE2_MIN_USDC, USDC_DECIMALS);
  if (amountUnits.lt(minimumUnits)) {
    throw new Error('hyperliquid Bridge2 minimum deposit is 5 USDC');
  }
  const txCalldata = erc20Interface.encodeFunctionData('transfer', [HYPERLIQUID_BRIDGE2_ADDRESS, amountUnits]);
  return {
    amount: body.amount,
    destinationAddress: utils.getAddress(body.destinationAddress),
    destinationAmount: body.amount,
    destinationAsset: 'USDC',
    destinationVenue: 'hyperliquid',
    idempotencyKey: body.idempotencyKey,
    minAmount: HYPERLIQUID_BRIDGE2_MIN_USDC,
    provider: 'hyperliquid_bridge2',
    sourceAmount: body.amount,
    sourceAsset: 'USDC',
    sourceChain: 'ethereum',
    sourceNetwork: 'arbitrum',
    tokenAddress: ARBITRUM_USDC_ADDRESS,
    txCalldata,
    txCalldataHash: utils.keccak256(txCalldata),
    txTarget: ARBITRUM_USDC_ADDRESS,
    walletAddress: utils.getAddress(body.walletAddress),
  };
}

export async function buildCctpBaseArbitrumUsdcTransfer(
  body: CctpBaseArbitrumRebalanceRequest,
): Promise<BuiltProviderOwnedRebalance> {
  const sourceNetwork = requireCctpEvmUsdcNetwork(body.sourceNetwork, 'source');
  const destinationNetwork = requireCctpUsdcDestinationNetwork(body.destinationNetwork);
  if (sourceNetwork.gatewayNetwork === destinationNetwork.gatewayNetwork) {
    throw new Error('CCTP source and destination networks must differ');
  }
  const amountUnits = utils.parseUnits(body.amount, USDC_DECIMALS);
  if (amountUnits.lte(0)) {
    throw new Error('CCTP transfer amount must be positive');
  }
  const walletAddress = utils.getAddress(body.walletAddress);
  const destination = buildCctpDestination(body.destinationAddress, destinationNetwork);
  const destinationCaller = utils.hexZeroPad('0x', 32);
  const approvalTxCalldata = erc20ApprovalInterface.encodeFunctionData('approve', [
    sourceNetwork.tokenMessengerAddress,
    amountUnits,
  ]);
  const txCalldata = cctpTokenMessengerInterface.encodeFunctionData('depositForBurn', [
    amountUnits,
    destinationNetwork.domain,
    destination.mintRecipient,
    sourceNetwork.tokenAddress,
    destinationCaller,
    BigNumber.from(0),
    CCTP_STANDARD_FINALITY_THRESHOLD,
  ]);
  return {
    amount: body.amount,
    approvalCalldataHash: utils.keccak256(approvalTxCalldata),
    approvalTxCalldata,
    approvalTxTarget: sourceNetwork.tokenAddress,
    cctpDestinationDomain: destinationNetwork.domain,
    cctpDestinationMessageTransmitterAddress: destinationNetwork.messageTransmitterAddress,
    cctpDestinationTokenMessengerAddress: destinationNetwork.tokenMessengerAddress,
    cctpMintRecipient: destination.mintRecipient,
    cctpSolanaUsdcAta: destination.solanaUsdcAta,
    cctpSourceDomain: sourceNetwork.domain,
    cctpSourceTokenMessengerAddress: sourceNetwork.tokenMessengerAddress,
    destinationAddress: destination.destinationAddress,
    destinationAsset: 'USDC',
    destinationChain: destinationNetwork.chain,
    destinationNetwork: destinationNetwork.gatewayNetwork,
    idempotencyKey: body.idempotencyKey,
    minAmount: '0.000001',
    provider: CCTP_USDC_PROVIDER,
    sourceAsset: 'USDC',
    sourceChain: 'ethereum',
    sourceNetwork: sourceNetwork.gatewayNetwork,
    tokenAddress: sourceNetwork.tokenAddress,
    txCalldata,
    txCalldataHash: utils.keccak256(txCalldata),
    txTarget: sourceNetwork.tokenMessengerAddress,
    walletAddress,
  };
}

async function executeProviderOwnedRebalance(
  built: BuiltProviderOwnedRebalance,
  liveActionAuthorization: LiveActionAuthorization,
  state: DurableRebalanceState,
): Promise<ProviderOwnedRebalanceExecution> {
  if (built.provider === CCTP_USDC_PROVIDER) {
    return executeCctpBaseArbitrumUsdcTransfer(built, liveActionAuthorization, state);
  }
  if (built.provider === SQUID_ROUTER_PROVIDER) {
    return executeSingleTransactionRebalance(
      built,
      liveActionAuthorization,
      state,
      SQUID_ROUTER_GAS_LIMIT,
      SQUID_ROUTER_PROVIDER_INTENT_SOURCE,
    );
  }
  if (built.provider === PROVIDER_TREASURY_SAME_CHAIN_SWAP) {
    return executeProviderTreasurySameChainSwap(built, liveActionAuthorization, state);
  }
  return executeSingleTransactionRebalance(
    built,
    liveActionAuthorization,
    state,
    HYPERLIQUID_BRIDGE2_GAS_LIMIT,
    'hyperliquid_bridge2_rebalance',
  );
}

function rebalanceGasGuardContext(built: BuiltProviderOwnedRebalance, walletAddress = built.walletAddress) {
  return {
    expectedConnectorId: providerTreasuryConnectorId(built.provider),
    expectedNotional: built.sourceAmount ?? built.amount,
    expectedWalletAddress: walletAddress,
  };
}

async function executeProviderTreasurySameChainSwap(
  built: BuiltProviderOwnedRebalance,
  liveActionAuthorization: LiveActionAuthorization,
  state: DurableRebalanceState,
): Promise<ProviderOwnedRebalanceExecution> {
  let wrapTransactionHash = state.wrapTransactionHash;
  if (built.wrapTxCalldata && built.wrapTxTarget && built.wrapTxValue) {
    const ethereum = await Ethereum.getInstance(built.sourceNetwork);
    const wallet = await ethereum.getWallet(built.walletAddress);
    if (wrapTransactionHash) {
      const receipt = await ethereum.provider.getTransactionReceipt(wrapTransactionHash);
      if (receipt?.status === 0) {
        return {
          responseStatus: -1,
          status: 'failed',
          transactionHash: wrapTransactionHash,
          wrapTransactionHash,
        };
      }
      if (!receipt && state.wrapSignedTransaction) {
        const wrapTx = await ethereum.provider.sendTransaction(state.wrapSignedTransaction);
        const wrapReceipt = await ethereum.handleTransactionExecution(wrapTx);
        if (wrapReceipt?.status !== 1) {
          return {
            responseStatus: 0,
            status: 'wrap_submitted',
            transactionHash: wrapTransactionHash,
            wrapTransactionHash,
          };
        }
      } else if (!receipt) {
        return {
          responseStatus: 0,
          status: 'wrap_submitted',
          transactionHash: wrapTransactionHash,
          wrapTransactionHash,
        };
      }
      state = { ...state, status: 'wrap_confirmed' };
      await saveRebalanceState(state);
    } else {
      const gasOptions = await ethereum.prepareGasOptions(
        undefined,
        PROVIDER_TREASURY_WRAP_GAS_LIMIT,
        liveActionAuthorization,
        PROVIDER_TREASURY_SAME_CHAIN_SWAP,
        rebalanceGasGuardContext(built),
      );
      state = await prepareRecoverableEvmTransaction(ethereum, wallet, state, 'wrap', {
        data: built.wrapTxCalldata,
        to: built.wrapTxTarget,
        value: BigNumber.from(built.wrapTxValue),
        ...gasOptions,
      });
      wrapTransactionHash = state.wrapTransactionHash;
      const wrapTx = await ethereum.provider.sendTransaction(state.wrapSignedTransaction as string);
      state = { ...state, status: 'wrap_submitted', wrapTransactionHash };
      await saveRebalanceState(state);
      const wrapReceipt = await ethereum.handleTransactionExecution(wrapTx);
      if (wrapReceipt?.status !== 1) {
        throw new Error('same-chain treasury ETH wrap not confirmed');
      }
      state = { ...state, status: 'wrap_confirmed', wrapTransactionHash };
      await saveRebalanceState(state);
    }
  }
  const execution = await executeSingleTransactionRebalance(
    built,
    liveActionAuthorization,
    state,
    PROVIDER_TREASURY_SAME_CHAIN_SWAP_GAS_LIMIT,
    PROVIDER_TREASURY_SAME_CHAIN_SWAP,
  );
  return {
    ...execution,
    wrapTransactionHash,
  };
}

async function executeSingleTransactionRebalance(
  built: BuiltProviderOwnedRebalance,
  liveActionAuthorization: LiveActionAuthorization,
  state: DurableRebalanceState,
  gasLimit: number,
  providerIntentSource: string,
): Promise<ProviderOwnedRebalanceExecution> {
  const ethereum = await Ethereum.getInstance(built.sourceNetwork);
  const wallet = await ethereum.getWallet(built.walletAddress);
  let approvalTransactionHash = state.approvalTransactionHash;
  if (built.approvalTxCalldata && built.approvalTxTarget) {
    if (approvalTransactionHash) {
      const receipt = await ethereum.provider.getTransactionReceipt(approvalTransactionHash);
      if (receipt?.status === 0) {
        return { approvalTransactionHash, responseStatus: -1, status: 'failed', transactionHash: '' };
      }
      if (!receipt && state.approvalSignedTransaction) {
        const approvalTx = await ethereum.provider.sendTransaction(state.approvalSignedTransaction);
        const recoveredReceipt = await ethereum.handleTransactionExecution(approvalTx);
        if (recoveredReceipt?.status !== 1) {
          return { approvalTransactionHash, responseStatus: 0, status: 'approval_submitted', transactionHash: '' };
        }
      } else if (!receipt) {
        return { approvalTransactionHash, responseStatus: 0, status: 'approval_submitted', transactionHash: '' };
      }
      state = { ...state, status: 'approval_confirmed' };
      await saveRebalanceState(state);
    } else {
      const approvalGasOptions = await ethereum.prepareGasOptions(
        undefined,
        SQUID_ROUTER_APPROVE_GAS_LIMIT,
        liveActionAuthorization,
        providerIntentSource,
        rebalanceGasGuardContext(built),
      );
      state = await prepareRecoverableEvmTransaction(ethereum, wallet, state, 'approval', {
        data: built.approvalTxCalldata,
        to: built.approvalTxTarget,
        value: BigNumber.from(0),
        ...approvalGasOptions,
      });
      approvalTransactionHash = state.approvalTransactionHash;
      const approvalTx = await ethereum.provider.sendTransaction(state.approvalSignedTransaction as string);
      const approvalReceipt = await ethereum.handleTransactionExecution(approvalTx);
      if (approvalReceipt?.status !== 1) {
        throw new Error('Squid ERC20 approval not confirmed');
      }
      state = {
        ...state,
        approvalTransactionHash,
        status: 'approval_confirmed',
      };
      await saveRebalanceState(state);
    }
  }
  if (state.transactionHash) {
    const receipt = await ethereum.provider.getTransactionReceipt(state.transactionHash);
    if (receipt) {
      const outcome = sourceReceiptOutcome(built.provider, receipt.status);
      return {
        approvalTransactionHash,
        responseStatus: outcome.responseStatus,
        status: outcome.status,
        transactionHash: state.transactionHash,
      };
    }
    if (!state.signedTransaction) {
      return {
        approvalTransactionHash,
        responseStatus: 0,
        status: 'submitted',
        transactionHash: state.transactionHash,
      };
    }
    const recoveredTx = await ethereum.provider.sendTransaction(state.signedTransaction);
    const recoveredReceipt = await ethereum.handleTransactionExecution(recoveredTx);
    const outcome = sourceReceiptOutcome(built.provider, recoveredReceipt?.status);
    return {
      approvalTransactionHash,
      responseStatus: outcome.responseStatus,
      status: outcome.status,
      transactionHash: state.transactionHash,
    };
  }
  const gasOptions = await ethereum.prepareGasOptions(
    undefined,
    gasLimit,
    liveActionAuthorization,
    providerIntentSource,
    rebalanceGasGuardContext(built),
  );
  state = await prepareRecoverableEvmTransaction(ethereum, wallet, state, 'submission', {
    data: built.txCalldata,
    to: built.txTarget,
    value: BigNumber.from(built.txValue ?? 0),
    ...gasOptions,
  });
  const txResponse = await ethereum.provider.sendTransaction(state.signedTransaction as string);
  const receipt = await ethereum.handleTransactionExecution(txResponse);
  const outcome = sourceReceiptOutcome(built.provider, receipt?.status);
  return {
    approvalTransactionHash,
    responseStatus: outcome.responseStatus,
    status: outcome.status,
    transactionHash: txResponse.hash,
  };
}

function sourceReceiptOutcome(
  provider: BuiltProviderOwnedRebalance['provider'],
  receiptStatus: number | undefined,
): { responseStatus: -1 | 0 | 1; status: string } {
  if (receiptStatus === 0) {
    return { responseStatus: -1, status: 'failed' };
  }
  if (receiptStatus === 1 && provider !== SQUID_ROUTER_PROVIDER) {
    return { responseStatus: 1, status: 'confirmed' };
  }
  return { responseStatus: 0, status: 'submitted' };
}

async function prepareRecoverableEvmTransaction(
  ethereum: Ethereum,
  wallet: Awaited<ReturnType<Ethereum['getWallet']>>,
  state: DurableRebalanceState,
  step: 'approval' | 'submission' | 'wrap',
  transaction: Record<string, unknown>,
): Promise<DurableRebalanceState> {
  const nonce = await ethereum.provider.getTransactionCount(state.walletAddress, 'pending');
  const serialized = await wallet.signTransaction({ ...transaction, chainId: ethereum.chainId, nonce });
  const transactionHash = utils.keccak256(serialized);
  const pending: DurableRebalanceState = {
    ...state,
    ...(step === 'approval'
      ? { approvalSignedTransaction: serialized, approvalTransactionHash: transactionHash }
      : step === 'wrap'
        ? { wrapSignedTransaction: serialized, wrapTransactionHash: transactionHash }
        : { signedTransaction: serialized, transactionHash }),
    status:
      step === 'approval'
        ? 'approval_submission_pending'
        : step === 'wrap'
          ? 'wrap_submission_pending'
          : 'submission_pending',
  };
  await saveRebalanceState(pending);
  return pending;
}

async function executeCctpBaseArbitrumUsdcTransfer(
  built: BuiltProviderOwnedRebalance,
  liveActionAuthorization: LiveActionAuthorization,
  state: DurableRebalanceState,
): Promise<ProviderOwnedRebalanceExecution> {
  assertBuiltCctpRegistryValues(built);
  if (!built.approvalTxCalldata || !built.approvalTxTarget) {
    throw new Error('CCTP approval transaction missing from provider-owned build');
  }
  if (!state.burnTransactionHash) {
    const destinationGasPreflight = await checkCctpDestinationGas(
      built,
      built.destinationNetwork,
      built.destinationAddress,
      liveActionAuthorization,
    );
    if (destinationGasPreflight.available === false) {
      return {
        approvalTransactionHash: state.approvalTransactionHash,
        burnTransactionHash: state.burnTransactionHash,
        providerError: destinationGasPreflight.providerError,
        providerStatus: CCTP_DESTINATION_GAS_PROVIDER_STATUS,
        responseStatus: 0,
        status: 'destination_gas_unavailable',
        transactionHash: '',
      };
    }
  }
  const ethereum = await Ethereum.getInstance(built.sourceNetwork);
  const wallet = await ethereum.getWallet(built.walletAddress);
  let approvalTransactionHash = state.approvalTransactionHash;
  if (approvalTransactionHash && state.status === 'approval_submitted') {
    return {
      approvalTransactionHash,
      responseStatus: 0,
      status: 'approval_submitted',
      transactionHash: approvalTransactionHash,
    };
  }
  if (!approvalTransactionHash) {
    const approvalGasOptions = await ethereum.prepareGasOptions(
      undefined,
      CCTP_APPROVE_GAS_LIMIT,
      liveActionAuthorization,
      CCTP_USDC_PROVIDER_INTENT_SOURCE,
      rebalanceGasGuardContext(built),
    );
    state = await markRebalanceSubmissionPending(state, 'approval');
    const approvalTx = await wallet.sendTransaction({
      data: built.approvalTxCalldata,
      to: built.approvalTxTarget,
      value: BigNumber.from(0),
      ...approvalGasOptions,
    });
    approvalTransactionHash = approvalTx.hash;
    state = {
      ...state,
      approvalTransactionHash,
      status: 'approval_submitted',
      transactionHash: approvalTransactionHash,
    };
    await saveRebalanceState(state);
    const approvalReceipt = await ethereum.handleTransactionExecution(approvalTx);
    if (approvalReceipt?.status !== 1) {
      throw new Error('CCTP USDC approval not confirmed');
    }
    state = {
      ...state,
      approvalTransactionHash,
      status: 'approval_confirmed',
      transactionHash: approvalTransactionHash,
    };
    await saveRebalanceState(state);
  }

  let burnTransactionHash = state.burnTransactionHash;
  if (!burnTransactionHash) {
    const destinationGasPreflight = await checkCctpDestinationGas(
      built,
      built.destinationNetwork,
      built.destinationAddress,
      liveActionAuthorization,
    );
    if (destinationGasPreflight.available === false) {
      return {
        approvalTransactionHash,
        providerError: destinationGasPreflight.providerError,
        providerStatus: CCTP_DESTINATION_GAS_PROVIDER_STATUS,
        responseStatus: 0,
        status: 'destination_gas_unavailable',
        transactionHash: approvalTransactionHash ?? '',
      };
    }
    const burnGasOptions = await ethereum.prepareGasOptions(
      undefined,
      CCTP_BURN_GAS_LIMIT,
      liveActionAuthorization,
      CCTP_USDC_PROVIDER_INTENT_SOURCE,
      rebalanceGasGuardContext(built),
    );
    state = await markRebalanceSubmissionPending(state, 'burn');
    const burnTx = await wallet.sendTransaction({
      data: built.txCalldata,
      to: built.txTarget,
      value: BigNumber.from(0),
      ...burnGasOptions,
    });
    burnTransactionHash = burnTx.hash;
    state = {
      ...state,
      approvalTransactionHash,
      burnTransactionHash,
      status: 'burn_submitted',
      transactionHash: burnTransactionHash,
    };
    await saveRebalanceState(state);
    const burnReceipt = await ethereum.handleTransactionExecution(burnTx);
    if (burnReceipt?.status !== 1) {
      return {
        approvalTransactionHash,
        burnTransactionHash: burnTx.hash,
        responseStatus: burnReceipt?.status === 0 ? -1 : 0,
        status: burnReceipt?.status === 0 ? 'failed' : 'burn_submitted',
        transactionHash: burnTx.hash,
      };
    }
    state = {
      ...state,
      approvalTransactionHash,
      burnTransactionHash,
      status: 'burn_confirmed',
      transactionHash: burnTransactionHash,
    };
    await saveRebalanceState(state);
  }

  if (state.finalizeTransactionHash && state.status !== 'finalize_pending') {
    return {
      approvalTransactionHash,
      burnTransactionHash,
      cctpAttestation: state.cctpAttestation,
      cctpMessage: state.cctpMessage,
      cctpMessageHash: state.cctpMessageHash,
      finalizeTransactionHash: state.finalizeTransactionHash,
      providerStatus: state.providerStatus,
      responseStatus: state.status === 'confirmed' ? 1 : 0,
      status: state.status,
      transactionHash: state.finalizeTransactionHash,
    };
  }

  const attestation = await fetchCctpAttestation(state, built);
  if (attestation.status === 'pending') {
    return {
      approvalTransactionHash,
      burnTransactionHash,
      providerError: attestation.providerError,
      providerStatus: attestation.providerStatus,
      responseStatus: 0,
      status: 'attestation_pending',
      transactionHash: burnTransactionHash,
    };
  }
  state = {
    ...state,
    cctpAttestation: attestation.attestation,
    cctpMessage: attestation.message,
    cctpMessageHash: attestation.messageHash,
    providerError: undefined,
    providerStatus: attestation.providerStatus,
    status: 'attestation_ready',
  };
  await saveRebalanceState(state);

  if (built.destinationChain === 'solana') {
    return executeCctpSolanaReceiveMessage(
      built,
      liveActionAuthorization,
      state,
      approvalTransactionHash,
      burnTransactionHash,
    );
  }

  const finalizeEthereum = await Ethereum.getInstance(built.destinationNetwork);
  assertMainnetMutationAllowed({
    chain: 'ethereum',
    expectedConnectorId: providerTreasuryConnectorId(built.provider),
    expectedNotional: built.amount,
    expectedWalletAddress: built.destinationAddress,
    internalProviderIntentSource: CCTP_USDC_PROVIDER_INTENT_SOURCE,
    liveActionAuthorization,
    network: built.destinationNetwork,
    operation: 'ethereum_transaction',
  });
  const finalizeWallet = await finalizeEthereum.getWallet(built.destinationAddress);
  const finalizeCalldata = cctpMessageTransmitterInterface.encodeFunctionData('receiveMessage', [
    state.cctpMessage,
    state.cctpAttestation,
  ]);
  const finalizeGasOptions = await finalizeEthereum.prepareGasOptions(
    undefined,
    CCTP_FINALIZE_GAS_LIMIT,
    liveActionAuthorization,
    CCTP_USDC_PROVIDER_INTENT_SOURCE,
    rebalanceGasGuardContext(built, built.destinationAddress),
  );
  state = await markRebalanceSubmissionPending(state, 'finalize');
  const finalizeTx = await finalizeWallet.sendTransaction({
    data: finalizeCalldata,
    to: built.cctpDestinationMessageTransmitterAddress,
    value: BigNumber.from(0),
    ...finalizeGasOptions,
  });
  state = {
    ...state,
    finalizeTransactionHash: finalizeTx.hash,
    status: 'finalize_submitted',
    transactionHash: finalizeTx.hash,
  };
  await saveRebalanceState(state);
  const finalizeReceipt = await finalizeEthereum.handleTransactionExecution(finalizeTx);
  const finalizeStatus =
    finalizeReceipt?.status === 1
      ? 'confirmed'
      : finalizeReceipt?.status === 0
        ? 'finalize_pending'
        : 'finalize_submitted';
  return {
    approvalTransactionHash,
    burnTransactionHash,
    cctpAttestation: state.cctpAttestation,
    cctpMessage: state.cctpMessage,
    cctpMessageHash: state.cctpMessageHash,
    finalizeTransactionHash: finalizeTx.hash,
    providerStatus: state.providerStatus,
    responseStatus: finalizeReceipt?.status === 1 ? 1 : finalizeReceipt?.status === 0 ? -1 : 0,
    status: finalizeStatus,
    transactionHash: finalizeTx.hash,
  };
}

async function checkCctpDestinationGas(
  built: BuiltProviderOwnedRebalance,
  destinationNetwork: string | undefined,
  destinationAddress: string,
  liveActionAuthorization: LiveActionAuthorization,
): Promise<{ available: true } | { available: false; providerError: string }> {
  if (!destinationNetwork) {
    return { available: false, providerError: 'CCTP destination network missing before burn' };
  }
  if (built.destinationChain === 'solana') {
    return checkCctpSolanaDestinationReady(built, destinationNetwork, destinationAddress);
  }
  try {
    const finalizeEthereum = await Ethereum.getInstance(destinationNetwork);
    const gasOptions = await finalizeEthereum.prepareGasOptions(
      undefined,
      CCTP_FINALIZE_GAS_LIMIT,
      liveActionAuthorization,
      CCTP_USDC_PROVIDER_INTENT_SOURCE,
      rebalanceGasGuardContext(built, destinationAddress),
    );
    const feePerGas = BigNumber.from(gasOptions.maxFeePerGas ?? gasOptions.gasPrice ?? 0);
    const requiredGas = BigNumber.from(gasOptions.gasLimit ?? CCTP_FINALIZE_GAS_LIMIT).mul(feePerGas);
    const nativeBalance = await finalizeEthereum.getNativeBalanceByAddress(destinationAddress);
    if (BigNumber.from(nativeBalance.value).gte(requiredGas) && requiredGas.gt(0)) {
      return { available: true };
    }
    return {
      available: false,
      providerError:
        destinationNetwork === 'arbitrum'
          ? 'CCTP destination Arbitrum wallet has no ETH for receiveMessage gas'
          : `CCTP destination ${destinationNetwork} wallet has no native gas for receiveMessage`,
    };
  } catch (error: any) {
    return {
      available: false,
      providerError:
        destinationNetwork === 'arbitrum'
          ? `CCTP destination Arbitrum ETH gas balance unavailable before burn: ${redactProviderError(error)}`
          : `CCTP destination ${destinationNetwork} native gas balance unavailable before burn: ${redactProviderError(error)}`,
    };
  }
}

async function checkCctpSolanaDestinationReady(
  built: BuiltProviderOwnedRebalance,
  destinationNetwork: string,
  destinationAddress: string,
): Promise<{ available: true } | { available: false; providerError: string }> {
  if (!built.cctpSolanaUsdcAta) {
    return { available: false, providerError: 'CCTP Solana USDC associated token account missing from build' };
  }
  try {
    const solana = await Solana.getInstance(destinationNetwork);
    const owner = new PublicKey(destinationAddress);
    const ata = new PublicKey(built.cctpSolanaUsdcAta);
    const [ataAccount, solBalance] = await Promise.all([
      solana.connection.getAccountInfo(ata),
      solana.connection.getBalance(owner),
    ]);
    const errors: string[] = [];
    if (!ataAccount) {
      errors.push(`USDC associated token account ${ata.toBase58()} does not exist`);
    }
    if (solBalance <= 0) {
      errors.push(`destination owner ${owner.toBase58()} has no SOL for receiveMessage gas/rent`);
    }
    if (errors.length > 0) {
      return {
        available: false,
        providerError: `CCTP destination Solana ${destinationNetwork} ${errors.join('; ')}`,
      };
    }
    return { available: true };
  } catch (error: any) {
    return {
      available: false,
      providerError: `CCTP destination Solana ${destinationNetwork} readiness unavailable before burn: ${redactProviderError(error)}`,
    };
  }
}

async function executeCctpSolanaReceiveMessage(
  built: BuiltProviderOwnedRebalance,
  liveActionAuthorization: LiveActionAuthorization,
  state: DurableRebalanceState,
  approvalTransactionHash: string | undefined,
  burnTransactionHash: string,
): Promise<ProviderOwnedRebalanceExecution> {
  if (!state.cctpMessage || !state.cctpAttestation || !built.destinationNetwork) {
    throw new Error('CCTP Solana finalize requires message, attestation, and destination network');
  }
  const solana = await Solana.getInstance(built.destinationNetwork);
  const payer = await solana.getWallet(built.destinationAddress);
  const instruction = await buildCctpSolanaReceiveMessageInstruction(solana, built, state, payer.publicKey);
  const transaction = new Transaction().add(instruction);
  transaction.feePayer = payer.publicKey;
  const { blockhash, lastValidBlockHeight } = await solana.connection.getLatestBlockhash();
  transaction.recentBlockhash = blockhash;
  transaction.sign(payer);
  await solana.simulateWithErrorHandling(transaction);
  state = await markRebalanceSubmissionPending(state, 'finalize');
  const finalizeTransactionHash = await solana.sendRawTransaction(
    transaction.serialize(),
    lastValidBlockHeight,
    liveActionAuthorization,
    CCTP_USDC_PROVIDER_INTENT_SOURCE,
    {
      expectedConnectorId: providerTreasuryConnectorId(built.provider),
      expectedNotional: built.amount,
      expectedWalletAddress: built.destinationAddress,
    },
  );
  await saveRebalanceState({
    ...state,
    finalizeTransactionHash,
    status: 'finalize_submitted',
    transactionHash: finalizeTransactionHash,
  });
  const confirmation = await solana.connection.confirmTransaction(
    { blockhash, lastValidBlockHeight, signature: finalizeTransactionHash },
    'confirmed',
  );
  const confirmed = confirmation.value.err === null;
  const status = confirmed ? 'confirmed' : 'finalize_pending';
  return {
    approvalTransactionHash,
    burnTransactionHash,
    cctpAttestation: state.cctpAttestation,
    cctpMessage: state.cctpMessage,
    cctpMessageHash: state.cctpMessageHash,
    finalizeTransactionHash,
    providerStatus: state.providerStatus,
    responseStatus: confirmed ? 1 : -1,
    status,
    transactionHash: finalizeTransactionHash,
  };
}

async function buildCctpSolanaReceiveMessageInstruction(
  solana: Solana,
  built: BuiltProviderOwnedRebalance,
  state: DurableRebalanceState,
  payer: PublicKey,
): Promise<TransactionInstruction> {
  assertBuiltCctpRegistryValues(built);
  if (!state.cctpMessage || !state.cctpAttestation || !state.cctpSolanaUsdcAta) {
    throw new Error('CCTP Solana receiveMessage state missing message, attestation, or recipient ATA');
  }
  const message = Buffer.from(utils.arrayify(state.cctpMessage));
  const attestation = Buffer.from(utils.arrayify(state.cctpAttestation));
  const sourceDomain = parseCctpRawMessage(state.cctpMessage).sourceDomain;
  const messageTransmitterProgram = new PublicKey(built.cctpDestinationMessageTransmitterAddress);
  const tokenMessengerMinterProgram = new PublicKey(built.cctpDestinationTokenMessengerAddress);
  const usdcMint = new PublicKey(SOLANA_MAINNET_BETA_USDC_MINT);
  const tokenMessenger = findSolanaProgramAddress(tokenMessengerMinterProgram, 'token_messenger');
  const feeRecipient = await readCctpSolanaFeeRecipient(solana, tokenMessenger);
  const localToken = findSolanaProgramAddress(tokenMessengerMinterProgram, 'local_token', usdcMint.toBuffer());
  const tokenMinter = findSolanaProgramAddress(tokenMessengerMinterProgram, 'token_minter');
  return new TransactionInstruction({
    programId: messageTransmitterProgram,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: false },
      {
        pubkey: findSolanaProgramAddress(
          messageTransmitterProgram,
          'message_transmitter_authority',
          tokenMessengerMinterProgram.toBuffer(),
        ),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: findSolanaProgramAddress(messageTransmitterProgram, 'message_transmitter'),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: findSolanaProgramAddress(
          messageTransmitterProgram,
          'used_nonce',
          message.subarray(CCTP_MESSAGE_NONCE_OFFSET, CCTP_MESSAGE_SENDER_OFFSET),
        ),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: tokenMessengerMinterProgram, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      {
        pubkey: findSolanaProgramAddress(messageTransmitterProgram, '__event_authority'),
        isSigner: false,
        isWritable: false,
      },
      { pubkey: messageTransmitterProgram, isSigner: false, isWritable: false },
      { pubkey: tokenMessenger, isSigner: false, isWritable: false },
      {
        pubkey: findSolanaProgramAddress(tokenMessengerMinterProgram, 'remote_token_messenger', String(sourceDomain)),
        isSigner: false,
        isWritable: false,
      },
      { pubkey: tokenMinter, isSigner: false, isWritable: true },
      { pubkey: localToken, isSigner: false, isWritable: true },
      {
        pubkey: findSolanaProgramAddress(
          tokenMessengerMinterProgram,
          'token_pair',
          String(sourceDomain),
          message.subarray(CCTP_BURN_MESSAGE_BURN_TOKEN_OFFSET, CCTP_BURN_MESSAGE_BURN_TOKEN_OFFSET + 32),
        ),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: getAssociatedTokenAddressSync(usdcMint, feeRecipient),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: new PublicKey(state.cctpSolanaUsdcAta), isSigner: false, isWritable: true },
      {
        pubkey: findSolanaProgramAddress(tokenMessengerMinterProgram, 'custody', usdcMint.toBuffer()),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      {
        pubkey: findSolanaProgramAddress(tokenMessengerMinterProgram, '__event_authority'),
        isSigner: false,
        isWritable: false,
      },
      { pubkey: tokenMessengerMinterProgram, isSigner: false, isWritable: false },
    ],
    data: encodeAnchorReceiveMessageData(message, attestation),
  });
}

async function readCctpSolanaFeeRecipient(solana: Solana, tokenMessenger: PublicKey): Promise<PublicKey> {
  const account = await solana.connection.getAccountInfo(tokenMessenger);
  if (!account?.data || account.data.length < CCTP_SOLANA_TOKEN_MESSENGER_FEE_RECIPIENT_OFFSET + 32) {
    throw new Error('CCTP Solana tokenMessenger account missing fee recipient');
  }
  return new PublicKey(
    account.data.subarray(
      CCTP_SOLANA_TOKEN_MESSENGER_FEE_RECIPIENT_OFFSET,
      CCTP_SOLANA_TOKEN_MESSENGER_FEE_RECIPIENT_OFFSET + 32,
    ),
  );
}

function encodeAnchorReceiveMessageData(message: Buffer, attestation: Buffer): Buffer {
  return concatBuffers([
    anchorDiscriminator('global:receive_message'),
    encodeBorshBytes(message),
    encodeBorshBytes(attestation),
  ]);
}

function encodeBorshBytes(value: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(value.length, 0);
  return concatBuffers([length, value]);
}

function anchorDiscriminator(name: string): Buffer {
  return createHash('sha256').update(name).digest().subarray(0, 8);
}

function concatBuffers(chunks: Buffer[]): Buffer {
  const output = Buffer.alloc(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function findSolanaProgramAddress(programId: PublicKey, label: string, ...extraSeeds: (Buffer | string)[]): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(label, 'utf8'),
      ...extraSeeds.map((seed) => (typeof seed === 'string' ? Buffer.from(seed, 'utf8') : seed)),
    ],
    programId,
  )[0];
}

async function fetchCctpAttestation(
  state: DurableRebalanceState,
  built: BuiltProviderOwnedRebalance,
): Promise<
  | {
      attestation: string;
      message: string;
      messageHash: string;
      providerStatus: string;
      status: 'ready';
    }
  | { providerError?: string; providerStatus: string; status: 'pending' }
> {
  if (state.cctpAttestation && state.cctpMessage && state.cctpMessageHash) {
    return {
      attestation: state.cctpAttestation,
      message: state.cctpMessage,
      messageHash: state.cctpMessageHash,
      providerStatus: state.providerStatus ?? 'complete',
      status: 'ready',
    };
  }
  if (!state.burnTransactionHash) {
    throw new Error('CCTP burn transaction hash missing before attestation lookup');
  }
  let response: CircleCctpMessagesResponse;
  try {
    const url = new URL(
      `/v2/messages/${built.cctpSourceDomain}`,
      (process.env.CCTP_IRIS_API_BASE_URL ?? CCTP_IRIS_MAINNET_URL).trim(),
    );
    url.searchParams.set('transactionHash', state.burnTransactionHash);
    const irisResponse = await fetch(url.toString(), {
      method: 'GET',
      signal: AbortSignal.timeout(15000),
    });
    if (!irisResponse.ok) {
      if (irisResponse.status === 404 || irisResponse.status === 429) {
        return {
          providerError:
            irisResponse.status === 429 ? 'Iris attestation lookup rate limited' : 'Iris attestation not available',
          providerStatus: irisResponse.status === 429 ? 'rate_limited' : 'pending',
          status: 'pending',
        };
      }
      throw new Error(`Iris attestation lookup failed with HTTP ${irisResponse.status}`);
    }
    response = (await irisResponse.json()) as CircleCctpMessagesResponse;
  } catch (error: any) {
    throw new Error(redactProviderError(error));
  }

  const message = response.messages?.[0];
  const providerStatus = String(message?.status ?? 'pending');
  if (!message || providerStatus !== 'complete') {
    return { providerStatus, status: 'pending' };
  }
  validateCctpMessage(state, built, message);
  return {
    attestation: requireHex(message.attestation, 'CCTP attestation'),
    message: requireHex(message.message, 'CCTP message'),
    messageHash: utils.keccak256(requireHex(message.message, 'CCTP message')),
    providerStatus,
    status: 'ready',
  };
}

function validateCctpMessage(
  state: DurableRebalanceState,
  built: BuiltProviderOwnedRebalance,
  message: CircleCctpMessage,
): void {
  assertBuiltCctpRegistryValues(built);
  const rawMessage = requireHex(message.message, 'CCTP message');
  const messageHash = utils.keccak256(rawMessage);
  const parsed = parseCctpRawMessage(rawMessage);
  if (state.cctpMessageHash && state.cctpMessageHash !== messageHash) {
    throw new Error('CCTP message hash changed for rebalance request');
  }
  if (Number(message.cctpVersion) !== 2) {
    throw new Error('CCTP message version mismatch');
  }
  const decoded = message.decodedMessage;
  const body = decoded?.decodedMessageBody;
  if (
    parsed.sourceDomain !== built.cctpSourceDomain ||
    String(decoded?.sourceDomain) !== String(built.cctpSourceDomain)
  ) {
    throw new Error('CCTP source domain mismatch');
  }
  if (
    parsed.destinationDomain !== built.cctpDestinationDomain ||
    String(decoded?.destinationDomain) !== String(built.cctpDestinationDomain)
  ) {
    throw new Error('CCTP destination domain mismatch');
  }
  if (
    !addressesEqual(bytes32ToAddress(parsed.sender), built.cctpSourceTokenMessengerAddress) ||
    !addressesEqual(bytes32ToAddress(String(decoded?.sender ?? '')), built.cctpSourceTokenMessengerAddress)
  ) {
    throw new Error('CCTP sender mismatch');
  }
  if (
    !cctpDestinationAddressMatches(
      parsed.recipient,
      built.cctpDestinationTokenMessengerAddress,
      built.destinationChain,
    ) ||
    !cctpDestinationAddressMatches(
      String(decoded?.recipient ?? ''),
      built.cctpDestinationTokenMessengerAddress,
      built.destinationChain,
    )
  ) {
    throw new Error('CCTP recipient mismatch');
  }
  if (!isZeroBytes32OrAddress(parsed.destinationCaller) || !isZeroBytes32OrAddress(decoded?.destinationCaller)) {
    throw new Error('CCTP destination caller must allow provider-owned finalize');
  }
  if (
    !addressesEqual(bytes32ToAddress(parsed.burnToken), built.tokenAddress) ||
    !addressesEqual(bytes32ToAddress(String(body?.burnToken ?? '')), built.tokenAddress)
  ) {
    throw new Error('CCTP burn token mismatch');
  }
  if (
    !cctpMintRecipientMatches(parsed.mintRecipient, state) ||
    !cctpMintRecipientMatches(String(body?.mintRecipient ?? ''), state)
  ) {
    throw new Error('CCTP mint recipient mismatch');
  }
  if (
    !addressesEqual(bytes32ToAddress(parsed.messageSender), state.walletAddress) ||
    !addressesEqual(bytes32ToAddress(String(body?.messageSender ?? '')), state.walletAddress)
  ) {
    throw new Error('CCTP message sender mismatch');
  }
  const expectedAmount = utils.parseUnits(state.amount, USDC_DECIMALS).toString();
  if (
    parsed.amount.toString() !== expectedAmount ||
    BigNumber.from(String(body?.amount ?? '-1')).toString() !== expectedAmount
  ) {
    throw new Error('CCTP amount mismatch');
  }
}

function cctpDestinationAddressMatches(
  value: string,
  expectedAddress: string,
  destinationChain: BuiltProviderOwnedRebalance['destinationChain'],
): boolean {
  if (destinationChain !== 'solana') {
    return addressesEqual(bytes32ToAddress(value), expectedAddress);
  }
  try {
    const expected = publicKeyToBytes32(new PublicKey(expectedAddress));
    return cctpBytes32OrSolanaAddressMatches(value, expected, expectedAddress);
  } catch {
    return false;
  }
}

function cctpMintRecipientMatches(value: string, state: DurableRebalanceState): boolean {
  if (state.destinationChain !== 'solana') {
    return addressesEqual(bytes32ToAddress(value), state.destinationAddress);
  }
  if (!state.cctpMintRecipient || !state.cctpSolanaUsdcAta) {
    return false;
  }
  return cctpBytes32OrSolanaAddressMatches(value, state.cctpMintRecipient, state.cctpSolanaUsdcAta);
}

function cctpBytes32OrSolanaAddressMatches(value: string, expectedBytes32: string, expectedBase58: string): boolean {
  if (utils.isHexString(value)) {
    return value.toLowerCase() === expectedBytes32.toLowerCase();
  }
  return value === expectedBase58;
}

function assertCctpDestinationAuthorization(
  built: BuiltProviderOwnedRebalance,
  authorization: LiveActionAuthorization,
): void {
  if (built.provider !== CCTP_USDC_PROVIDER) {
    return;
  }
  const fields = authorization as Record<string, unknown>;
  if (
    !authorizationValueMatches(built.destinationNetwork, fields.destination_network) ||
    !authorizationValueMatches(built.destinationAddress, fields.destination_address)
  ) {
    throw new Error('CCTP provider treasury authorization does not match destination');
  }
}

async function refreshRebalanceStatus(idempotencyKey: string): Promise<DurableRebalanceState | undefined> {
  let state = await readRebalanceState(idempotencyKey);
  if (!state || state.status === 'confirmed' || state.status === 'failed') {
    return state;
  }
  if (state.transactionHash && ['hyperliquid_bridge2', SQUID_ROUTER_PROVIDER].includes(state.provider)) {
    try {
      const ethereum = await Ethereum.getInstance(state.sourceNetwork);
      const receipt = await ethereum.provider.getTransactionReceipt(state.transactionHash);
      if (receipt?.status === 0) {
        state = { ...state, status: 'failed' };
        await saveRebalanceState(state);
        return state;
      }
      if (receipt?.status === 1 && state.provider !== SQUID_ROUTER_PROVIDER) {
        state = { ...state, status: 'confirmed' };
        await saveRebalanceState(state);
        return state;
      }
    } catch (error) {
      state = { ...state, providerError: redactProviderError(error) };
      await saveRebalanceState(state);
    }
  }
  if (state.provider !== SQUID_ROUTER_PROVIDER) {
    return state;
  }
  if (
    !state.transactionHash ||
    !state.squidStatusRequestId ||
    !state.squidSourceChainId ||
    !state.squidDestinationChainId ||
    !state.quoteId
  ) {
    return state;
  }
  try {
    const squidStatus = await fetchSquidRouteStatus(state);
    const mapped = mapSquidStatus(squidStatus.status);
    const refreshed = removeUndefinedFields({
      ...state,
      providerError: squidStatus.providerError,
      providerStatus: mapped.providerStatus,
      status: mapped.status,
    });
    await saveRebalanceState(refreshed);
    return refreshed;
  } catch (error: any) {
    const refreshed = removeUndefinedFields({
      ...state,
      providerError: redactProviderError(error),
      providerStatus: 'status_unavailable',
    });
    await saveRebalanceState(refreshed);
    return refreshed;
  }
}

async function loadOrCreateRebalanceState(
  built: BuiltProviderOwnedRebalance,
  body: BridgeRebalanceRequest,
  options: { allowUnsubmittedRefresh?: boolean } = {},
): Promise<DurableRebalanceState> {
  const requestFingerprint = rebalanceRequestFingerprint(built);
  const existing = await readRebalanceState(body.idempotencyKey);
  if (existing) {
    if (existing.requestFingerprint !== requestFingerprint) {
      if (options.allowUnsubmittedRefresh && !rebalanceHasSideEffect(existing)) {
        const refreshed = newRebalanceState(built, body, requestFingerprint);
        await saveRebalanceState(refreshed);
        return refreshed;
      }
      throw new Error('idempotency key already used for a different rebalance request');
    }
    return existing;
  }
  const state = newRebalanceState(built, body, requestFingerprint);
  await saveRebalanceState(state);
  return state;
}

function newRebalanceState(
  built: BuiltProviderOwnedRebalance,
  body: BridgeRebalanceRequest,
  requestFingerprint: string,
): DurableRebalanceState {
  return {
    amount: built.amount,
    cctpMintRecipient: built.cctpMintRecipient,
    cctpSolanaUsdcAta: built.cctpSolanaUsdcAta,
    destinationAmount: built.destinationAmount,
    destinationChain: built.destinationChain,
    destinationAddress: built.destinationAddress,
    destinationAsset: built.destinationAsset,
    destinationNetwork: built.destinationNetwork,
    destinationVenue: built.destinationVenue,
    idempotencyKey: body.idempotencyKey,
    provider: built.provider,
    providerRouteId: built.providerRouteId,
    quoteId: built.quoteId,
    quotedAt: built.quotedAt,
    quotedProviderCostUsd: built.quotedProviderCostUsd,
    quotedGasCostUsd: built.quotedGasCostUsd,
    quotedNativeGasAmount: built.quotedNativeGasAmount,
    quotedNativeGasAsset: built.quotedNativeGasAsset,
    requestFingerprint,
    sourceAmount: built.sourceAmount,
    squidDestinationChainId: built.squidDestinationChainId,
    squidSourceChainId: built.squidSourceChainId,
    squidStatusRequestId: built.squidStatusRequestId,
    sourceChain: built.sourceChain,
    sourceNetwork: built.sourceNetwork,
    status: 'built',
    txCalldataHash: built.txCalldataHash,
    txTarget: built.txTarget,
    txValueHash: built.txValueHash,
    walletAddress: built.walletAddress,
    wrapTransactionHash: undefined,
  };
}

function rebalanceHasSideEffect(state: DurableRebalanceState): boolean {
  return Boolean(
    isRebalanceSubmissionInDoubt(state.status) ||
      state.approvalTransactionHash ||
      state.burnTransactionHash ||
      state.finalizeTransactionHash ||
      state.transactionHash ||
      state.wrapTransactionHash,
  );
}

async function readRebalanceState(idempotencyKey: string): Promise<DurableRebalanceState | undefined> {
  const filePath = rebalanceStatePath(idempotencyKey);
  if (!existsSync(filePath)) {
    return undefined;
  }
  return JSON.parse(readFileSync(filePath, 'utf8')) as DurableRebalanceState;
}

async function saveRebalanceState(state: DurableRebalanceState): Promise<void> {
  const dir = rebalanceStateDir();
  mkdirSync(dir, { recursive: true });
  const filePath = rebalanceStatePath(state.idempotencyKey);
  const tmpPath = `${filePath}.tmp`;
  const persisted = removeUndefinedFields(state);
  writeFileSync(tmpPath, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 });
  const tmpFd = openSync(tmpPath, 'r');
  try {
    fsyncSync(tmpFd);
  } finally {
    closeSync(tmpFd);
  }
  renameSync(tmpPath, filePath);
  const dirFd = openSync(dir, 'r');
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

function rebalanceStateDir(): string {
  const configuredRoot = process.env.MARLIN_REBALANCE_STATE_ROOT?.trim();
  return configuredRoot ? path.resolve(configuredRoot) : '/home/gateway/data/marlin/rebalances';
}

function rebalanceStatePath(idempotencyKey: string): string {
  return path.join(rebalanceStateDir(), `${safeRebalanceId(idempotencyKey)}.json`);
}

function safeRebalanceId(idempotencyKey: string): string {
  const safe = idempotencyKey
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return safe || utils.keccak256(utils.toUtf8Bytes(idempotencyKey)).slice(2);
}

async function markRebalanceSubmissionPending(
  state: DurableRebalanceState,
  step: 'approval' | 'burn' | 'finalize' | 'submission' | 'wrap',
): Promise<DurableRebalanceState> {
  const pending = {
    ...state,
    status: step === 'submission' ? 'submission_pending' : `${step}_submission_pending`,
  };
  await saveRebalanceState(pending);
  return pending;
}

function isRebalanceSubmissionInDoubt(status: string): boolean {
  return (
    status === 'submission_pending' ||
    status === 'submission_ambiguous' ||
    /_submission_(?:pending|ambiguous)$/.test(status)
  );
}

function rebalanceRequestFingerprint(built: BuiltProviderOwnedRebalance): string {
  return utils.keccak256(
    utils.toUtf8Bytes(
      JSON.stringify({
        approvalCalldataHash: built.approvalCalldataHash,
        approvalTxTarget: built.approvalTxTarget,
        amount: built.amount,
        cctpDestinationDomain: built.cctpDestinationDomain,
        cctpDestinationMessageTransmitterAddress: built.cctpDestinationMessageTransmitterAddress,
        cctpDestinationTokenMessengerAddress: built.cctpDestinationTokenMessengerAddress,
        cctpMintRecipient: built.cctpMintRecipient,
        cctpRegistryVersion: built.provider === CCTP_USDC_PROVIDER ? CCTP_REGISTRY_VERSION : undefined,
        cctpSolanaUsdcAta: built.cctpSolanaUsdcAta,
        cctpSourceDomain: built.cctpSourceDomain,
        cctpSourceTokenMessengerAddress: built.cctpSourceTokenMessengerAddress,
        destinationAddress: built.destinationAddress,
        destinationAmount: built.destinationAmount,
        destinationAsset: built.destinationAsset,
        destinationChain: built.destinationChain,
        destinationNetwork: built.destinationNetwork,
        destinationVenue: built.destinationVenue,
        providerRouteId: built.providerRouteId,
        providerDestinationAmount: built.providerDestinationAmount,
        quoteId: built.quoteId,
        quotedProviderCostUsd: built.quotedProviderCostUsd,
        quotedGasCostUsd: built.quotedGasCostUsd,
        quotedNativeGasAmount: built.quotedNativeGasAmount,
        quotedNativeGasAsset: built.quotedNativeGasAsset,
        provider: built.provider,
        squidDestinationChainId: built.squidDestinationChainId,
        squidSourceChainId: built.squidSourceChainId,
        squidStatusRequestId: built.squidStatusRequestId,
        sourceChain: built.sourceChain,
        sourceAmount: built.sourceAmount,
        sourceNetwork: built.sourceNetwork,
        tokenAddress: built.tokenAddress,
        txCalldataHash: built.txCalldataHash,
        txTarget: built.txTarget,
        txValueHash: built.txValueHash,
        walletAddress: built.walletAddress,
        wrapTxCalldataHash: built.wrapTxCalldataHash,
        wrapTxTarget: built.wrapTxTarget,
        wrapTxValueHash: built.wrapTxValueHash,
      }),
    ),
  );
}

function bestKnownTransactionHash(state: DurableRebalanceState): string {
  return (
    state.finalizeTransactionHash ??
    state.burnTransactionHash ??
    state.transactionHash ??
    state.approvalTransactionHash ??
    state.wrapTransactionHash ??
    ''
  );
}

function redactProviderError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : JSON.stringify(error ?? 'unknown provider error');
  return raw
    .replace(/0x[a-fA-F0-9]{80,}/g, '[redacted-hex]')
    .replace(/([?&](?:api_?key|token|signature|attestation)=)[^&\s]+/gi, '$1[redacted]')
    .replace(
      /\b(token|api[-_]?key|signature|attestation|secret|mnemonic|private_?key|wallet_?file|bearer)\b[:=\s]+[^\s&]+/gi,
      '$1 [redacted]',
    )
    .slice(0, 300);
}

function requireAddress(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} missing or invalid`);
  }
  return utils.getAddress(value);
}

function requireNonEmptyText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} missing or invalid`);
  }
  return value;
}

function requireHex(value: unknown, label: string): string {
  if (typeof value !== 'string' || !utils.isHexString(value)) {
    throw new Error(`${label} missing or invalid`);
  }
  return value;
}

function normalizeTransactionValue(value: unknown): string {
  if (value === undefined || value === null || String(value).trim() === '') {
    return '0';
  }
  if (typeof value === 'string' && utils.isHexString(value)) {
    return BigNumber.from(value).toString();
  }
  return BigNumber.from(String(value)).toString();
}

function transactionValueHash(value: string): string {
  return utils.keccak256(utils.defaultAbiCoder.encode(['uint256'], [BigNumber.from(value)]));
}

function optionalText(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const text = String(value).trim();
  return text ? text : undefined;
}

function sumSquidCostUsd(entries: SquidCostEntry[] | undefined): string | undefined {
  if (entries === undefined) {
    return undefined;
  }
  if (entries.length === 0) {
    return '0';
  }
  let total: BigNumber | undefined;
  for (const entry of entries) {
    if (entry.amountUsd === undefined || entry.amountUsd === null) {
      throw new Error('Squid cost entry missing amountUsd');
    }
    const raw = entry.amountUsd;
    const text = typeof raw === 'string' ? raw.trim() : String(raw).trim();
    if (text === '') {
      throw new Error('Squid cost entry has empty amountUsd');
    }
    if (/[eE]/.test(text)) {
      throw new Error('Squid cost amountUsd uses exponent notation');
    }
    const dotIndex = text.indexOf('.');
    if (dotIndex !== -1 && text.length - dotIndex - 1 > 12) {
      throw new Error('Squid cost amountUsd exceeds maximum precision of 12 decimals');
    }
    let scaledUnits: BigNumber;
    try {
      scaledUnits = utils.parseUnits(text, 12);
    } catch {
      throw new Error('Squid cost amountUsd is not a valid decimal string');
    }
    if (scaledUnits.lt(0)) {
      throw new Error('Squid cost amountUsd is negative');
    }
    total = total ? total.add(scaledUnits) : scaledUnits;
  }
  if (total === undefined) {
    return undefined;
  }
  return utils.formatUnits(total, 12).replace(/\.?0+$/, '');
}

function normalizeSameChainSwapSourceAsset(value: string): 'ETH' | typeof ARBITRUM_WETH_ADDRESS {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'eth') {
    return 'ETH';
  }
  if (normalized === 'weth' || normalized === ARBITRUM_WETH_ADDRESS.toLowerCase()) {
    return ARBITRUM_WETH_ADDRESS;
  }
  throw new Error('same-chain treasury swap sourceAsset must be ETH or Arbitrum WETH');
}

function sameChainDestinationIsArbitrumUsdc(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === 'usdc' || normalized === ARBITRUM_USDC_ADDRESS.toLowerCase();
}

function mapSquidStatus(value: string): { providerStatus: string; status: string } {
  const normalized = value.trim().toUpperCase();
  if (normalized === 'SUCCESS') {
    return { providerStatus: 'success', status: 'confirmed' };
  }
  if (normalized === 'ONGOING' || normalized === 'PENDING') {
    return { providerStatus: 'ongoing', status: 'submitted' };
  }
  if (normalized === 'NEEDS_GAS') {
    return { providerStatus: 'needs_gas', status: 'action_required' };
  }
  if (normalized === 'PARTIAL_SUCCESS') {
    return { providerStatus: 'partial_success', status: 'action_required' };
  }
  if (normalized === 'NOT_FOUND') {
    return { providerStatus: 'not_found', status: 'submitted' };
  }
  if (normalized.includes('REFUND') || normalized.includes('FAIL')) {
    return { providerStatus: 'failed', status: 'failed' };
  }
  return { providerStatus: 'unknown', status: 'submitted' };
}

function bytes32ToAddress(value: string): string {
  if (!utils.isHexString(value)) {
    return '';
  }
  if (utils.hexDataLength(value) === 20) {
    return utils.getAddress(value);
  }
  if (utils.hexDataLength(value) !== 32) {
    return '';
  }
  return utils.getAddress(utils.hexDataSlice(value, 12));
}

function isZeroBytes32OrAddress(value: unknown): boolean {
  if (value === '11111111111111111111111111111111') {
    return true;
  }
  if (typeof value !== 'string' || !utils.isHexString(value)) {
    return false;
  }
  return BigNumber.from(value).isZero();
}

function parseCctpRawMessage(message: string): {
  amount: BigNumber;
  burnToken: string;
  destinationCaller: string;
  destinationDomain: number;
  messageSender: string;
  mintRecipient: string;
  recipient: string;
  sender: string;
  sourceDomain: number;
} {
  if (utils.hexDataLength(message) < 376) {
    throw new Error('CCTP message too short');
  }
  return {
    amount: BigNumber.from(utils.hexDataSlice(message, 216, 248)),
    burnToken: utils.hexDataSlice(message, 152, 184),
    destinationCaller: utils.hexDataSlice(message, 108, 140),
    destinationDomain: BigNumber.from(utils.hexDataSlice(message, 8, 12)).toNumber(),
    messageSender: utils.hexDataSlice(message, 248, 280),
    mintRecipient: utils.hexDataSlice(message, 184, 216),
    recipient: utils.hexDataSlice(message, 76, 108),
    sender: utils.hexDataSlice(message, 44, 76),
    sourceDomain: BigNumber.from(utils.hexDataSlice(message, 4, 8)).toNumber(),
  };
}

function removeUndefinedFields<T extends Record<string, any>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, fieldValue]) => fieldValue !== undefined)) as T;
}

function providerTreasuryConnectorId(provider: string): string {
  if (
    isCctpProvider(provider) ||
    provider === SQUID_ROUTER_PROVIDER ||
    provider === PROVIDER_TREASURY_SAME_CHAIN_SWAP
  ) {
    return 'treasury';
  }
  return 'hyperliquid';
}

function providerTreasuryIntentSource(provider: string): string {
  if (isCctpProvider(provider)) {
    return CCTP_USDC_PROVIDER_INTENT_SOURCE;
  }
  if (provider === SQUID_ROUTER_PROVIDER) {
    return SQUID_ROUTER_PROVIDER_INTENT_SOURCE;
  }
  if (provider === PROVIDER_TREASURY_SAME_CHAIN_SWAP) {
    return PROVIDER_TREASURY_SAME_CHAIN_SWAP;
  }
  return 'hyperliquid_bridge2_rebalance';
}

function isCctpProvider(provider: string): boolean {
  return provider === CCTP_USDC_PROVIDER || provider === CCTP_BASE_ARBITRUM_USDC_PROVIDER;
}

function recoverableRebalanceErrorStatus(state: DurableRebalanceState): string {
  if (isRebalanceSubmissionInDoubt(state.status)) {
    return state.status.replace(/_pending$/, '_ambiguous');
  }
  if (state.provider === PROVIDER_TREASURY_SAME_CHAIN_SWAP) {
    if (state.transactionHash) {
      return 'submitted';
    }
    if (state.approvalTransactionHash) {
      return 'approval_submitted';
    }
    if (state.wrapTransactionHash) {
      return 'wrap_submitted';
    }
  }
  if (isCctpProvider(state.provider)) {
    if (state.finalizeTransactionHash) {
      return 'finalize_submitted';
    }
    if (state.burnTransactionHash) {
      return 'finalize_pending';
    }
    if (state.approvalTransactionHash) {
      return 'approval_submitted';
    }
  }
  return state.transactionHash ? 'submitted' : 'failed';
}

function cctpEvmUsdcNetwork(
  domain: number,
  gatewayNetwork: string,
  tokenAddress: string,
  tokenMessengerAddress: string = CCTP_V2_TOKEN_MESSENGER_ADDRESS,
  messageTransmitterAddress: string = CCTP_V2_MESSAGE_TRANSMITTER_ADDRESS,
): CctpEvmUsdcNetwork {
  return {
    chain: 'ethereum',
    domain,
    gatewayNetwork,
    messageTransmitterAddress,
    tokenAddress,
    tokenMessengerAddress,
  };
}

function cctpSolanaUsdcDestinationNetwork(): CctpSolanaUsdcDestinationNetwork {
  return {
    chain: 'solana',
    domain: CCTP_SOLANA_DOMAIN,
    gatewayNetwork: 'mainnet-beta',
    messageTransmitterAddress: CCTP_SOLANA_MESSAGE_TRANSMITTER_V2_PROGRAM,
    tokenMessengerAddress: CCTP_SOLANA_TOKEN_MESSENGER_MINTER_V2_PROGRAM,
    usdcMintAddress: SOLANA_MAINNET_BETA_USDC_MINT,
  };
}

function requireCctpEvmUsdcNetwork(rawNetwork: string, role: 'source' | 'destination'): CctpEvmUsdcNetwork {
  const network = rawNetwork.trim().toLowerCase();
  const config = CCTP_EVM_USDC_NETWORKS[network as keyof typeof CCTP_EVM_USDC_NETWORKS];
  if (!config) {
    throw new Error(`unsupported CCTP ${role} network: ${rawNetwork}`);
  }
  return config;
}

function requireCctpUsdcDestinationNetwork(rawNetwork: string): CctpUsdcDestinationNetwork {
  const network = rawNetwork.trim().toLowerCase();
  const evmConfig = CCTP_EVM_USDC_NETWORKS[network as keyof typeof CCTP_EVM_USDC_NETWORKS];
  if (evmConfig) {
    return evmConfig;
  }
  const solanaConfig =
    CCTP_SOLANA_USDC_DESTINATION_NETWORKS[network as keyof typeof CCTP_SOLANA_USDC_DESTINATION_NETWORKS];
  if (solanaConfig) {
    return solanaConfig;
  }
  throw new Error(`unsupported CCTP destination network: ${rawNetwork}`);
}

function buildCctpDestination(
  rawDestinationAddress: string,
  destinationNetwork: CctpUsdcDestinationNetwork,
): {
  destinationAddress: string;
  mintRecipient: string;
  solanaUsdcAta?: string;
} {
  if (destinationNetwork.chain === 'ethereum') {
    const destinationAddress = utils.getAddress(rawDestinationAddress);
    return {
      destinationAddress,
      mintRecipient: addressToBytes32(destinationAddress),
    };
  }
  const owner = new PublicKey(rawDestinationAddress);
  const usdcMint = new PublicKey(destinationNetwork.usdcMintAddress);
  const ata = getAssociatedTokenAddressSync(usdcMint, owner);
  return {
    destinationAddress: owner.toBase58(),
    mintRecipient: publicKeyToBytes32(ata),
    solanaUsdcAta: ata.toBase58(),
  };
}

function assertBuiltCctpRegistryValues(
  built: BuiltProviderOwnedRebalance,
): asserts built is BuiltProviderOwnedRebalance & {
  cctpDestinationDomain: number;
  cctpDestinationMessageTransmitterAddress: string;
  cctpDestinationTokenMessengerAddress: string;
  cctpSourceDomain: number;
  cctpSourceTokenMessengerAddress: string;
  destinationNetwork: string;
} {
  if (
    built.cctpSourceDomain === undefined ||
    built.cctpDestinationDomain === undefined ||
    !built.cctpSourceTokenMessengerAddress ||
    !built.cctpDestinationTokenMessengerAddress ||
    !built.cctpDestinationMessageTransmitterAddress ||
    !built.destinationNetwork
  ) {
    throw new Error('CCTP registry metadata missing from provider-owned build');
  }
}

function addressToBytes32(address: string): string {
  return utils.hexZeroPad(utils.getAddress(address), 32);
}

function publicKeyToBytes32(publicKey: PublicKey): string {
  return `0x${Buffer.from(publicKey.toBytes()).toString('hex')}`;
}

async function withRebalanceLock<T>(idempotencyKey: string, fn: () => Promise<T>): Promise<T> {
  const previous = rebalanceLocks.get(idempotencyKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  rebalanceLocks.set(
    idempotencyKey,
    previous.then(() => current),
  );
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (rebalanceLocks.get(idempotencyKey) === current) {
      rebalanceLocks.delete(idempotencyKey);
    }
  }
}

function addressesEqual(left: string, right: string): boolean {
  try {
    return utils.getAddress(left) === utils.getAddress(right);
  } catch {
    return false;
  }
}

function authorizationValueMatches(expected: unknown, provided: unknown): boolean {
  if (provided === undefined || provided === null || String(provided).trim() === '') {
    return false;
  }
  if (
    typeof expected === 'string' &&
    typeof provided === 'string' &&
    utils.isAddress(expected) &&
    utils.isAddress(provided)
  ) {
    return addressesEqual(expected, provided);
  }
  return String(expected).trim() === String(provided).trim();
}

function rejectRawTransactionPayloadFields(request: any, reply: any, done: (error?: Error) => void): void {
  const body = request.body as Record<string, unknown> | undefined;
  const rawField = RAW_TRANSACTION_PAYLOAD_FIELDS.find((field) =>
    Object.prototype.hasOwnProperty.call(body ?? {}, field),
  );
  if (rawField) {
    reply.status(400).send({
      error: 'Bad Request',
      message: `caller-supplied ${rawField} is not accepted for provider-owned rebalance execution`,
      statusCode: 400,
    });
    return;
  }
  done();
}
