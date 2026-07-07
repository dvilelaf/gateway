import { Static, Type } from '@sinclair/typebox';
import { BigNumber, utils } from 'ethers';
import { FastifyPluginAsync } from 'fastify';

import { Ethereum } from '../chains/ethereum/ethereum';
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
const BASE_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CCTP_V2_TOKEN_MESSENGER_ADDRESS = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d';
const CCTP_ARBITRUM_DOMAIN = 3;
const CCTP_STANDARD_FINALITY_THRESHOLD = 2000;
const HYPERLIQUID_BRIDGE2_MIN_USDC = '5';
const HYPERLIQUID_BRIDGE2_GAS_LIMIT = 120000;
const CCTP_APPROVE_GAS_LIMIT = 90000;
const CCTP_BURN_GAS_LIMIT = 220000;
const USDC_DECIMALS = 6;
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
    provider: Type.Literal('cctp_base_arbitrum_usdc'),
    idempotencyKey: Type.String({ minLength: 1 }),
    mode: Type.Literal('mainnet'),
    sourceChain: Type.Literal('ethereum'),
    sourceNetwork: Type.Literal('base'),
    sourceAsset: Type.Literal('USDC'),
    destinationNetwork: Type.Literal('arbitrum'),
    destinationAsset: Type.Literal('USDC'),
    walletAddress: Type.String({ minLength: 1 }),
    destinationAddress: Type.String({ minLength: 1 }),
    amount: Type.String({ minLength: 1 }),
    liveActionAuthorization: Type.Optional(Type.Any()),
  },
  { additionalProperties: false },
);

const BridgeRebalanceRequestSchema = Type.Union([
  HyperliquidBridge2RebalanceRequestSchema,
  CctpBaseArbitrumRebalanceRequestSchema,
]);

const BridgeRebalanceExecutionStatusSchema = Type.Object({
  idempotencyKey: Type.String(),
  status: Type.String(),
  approvalTransactionHash: Type.Optional(Type.String()),
  transactionHash: Type.Optional(Type.String()),
  providerError: Type.Optional(Type.String()),
});

const BridgeRebalanceBuildResponseSchema = Type.Object({
  provider: Type.String(),
  idempotencyKey: Type.String(),
  sourceChain: Type.Literal('ethereum'),
  sourceNetwork: Type.String(),
  sourceAsset: Type.Literal('USDC'),
  destinationVenue: Type.Optional(Type.String()),
  destinationNetwork: Type.Optional(Type.String()),
  destinationAsset: Type.Literal('USDC'),
  walletAddress: Type.String(),
  destinationAddress: Type.String(),
  amount: Type.String(),
  txTarget: Type.String(),
  txCalldataHash: Type.String(),
  approvalTxTarget: Type.Optional(Type.String()),
  approvalCalldataHash: Type.Optional(Type.String()),
  minAmount: Type.String(),
});

type BridgeRebalanceRequest = Static<typeof BridgeRebalanceRequestSchema>;
type BridgeRebalanceStatus = Static<typeof BridgeRebalanceExecutionStatusSchema>;
type HyperliquidBridge2RebalanceRequest = Static<typeof HyperliquidBridge2RebalanceRequestSchema>;
type CctpBaseArbitrumRebalanceRequest = Static<typeof CctpBaseArbitrumRebalanceRequestSchema>;

const rebalanceStore = new Map<string, BridgeRebalanceStatus>();
const erc20Interface = new utils.Interface(['function transfer(address to, uint256 amount) returns (bool)']);
const erc20ApprovalInterface = new utils.Interface([
  'function approve(address spender, uint256 amount) returns (bool)',
]);
const cctpTokenMessengerInterface = new utils.Interface([
  'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)',
]);

export const rebalanceRoutes: FastifyPluginAsync = async (fastify) => {
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
      rebalanceStore.set(request.body.idempotencyKey, {
        idempotencyKey: request.body.idempotencyKey,
        status: 'built',
      });
      return {
        amount: built.amount,
        destinationAddress: built.destinationAddress,
        destinationAsset: built.destinationAsset,
        destinationNetwork: built.destinationNetwork,
        destinationVenue: built.destinationVenue,
        idempotencyKey: built.idempotencyKey,
        minAmount: built.minAmount,
        provider: built.provider,
        approvalCalldataHash: built.approvalCalldataHash,
        approvalTxTarget: built.approvalTxTarget,
        sourceAsset: built.sourceAsset,
        sourceChain: built.sourceChain,
        sourceNetwork: built.sourceNetwork,
        txCalldataHash: built.txCalldataHash,
        txTarget: built.txTarget,
        walletAddress: built.walletAddress,
      };
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
        const existing = rebalanceStore.get(request.body.idempotencyKey);
        if (existing?.transactionHash || existing?.status === 'pending' || existing?.status === 'failed') {
          return {
            signature: existing.transactionHash ?? '',
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
            network: request.body.sourceNetwork,
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

        const built = await buildProviderOwnedRebalance(request.body);
        assertMainnetMutationAllowed({
          chain: 'ethereum',
          expectedConnectorId: providerTreasuryConnectorId(request.body.provider),
          expectedNotional: request.body.amount,
          expectedWalletAddress: request.body.walletAddress,
          internalProviderIntentSource: providerTreasuryIntentSource(request.body.provider),
          liveActionAuthorization,
          network: request.body.sourceNetwork,
          operation: 'ethereum_transaction',
        });
        rebalanceStore.set(request.body.idempotencyKey, {
          idempotencyKey: request.body.idempotencyKey,
          status: 'pending',
        });
        try {
          const execution = await executeProviderOwnedRebalance(built, liveActionAuthorization);
          const status = execution.status;
          rebalanceStore.set(request.body.idempotencyKey, {
            approvalTransactionHash: execution.approvalTransactionHash,
            idempotencyKey: request.body.idempotencyKey,
            status,
            transactionHash: execution.transactionHash,
          });
          return { signature: execution.transactionHash, status: execution.responseStatus };
        } catch (error: any) {
          rebalanceStore.set(request.body.idempotencyKey, {
            idempotencyKey: request.body.idempotencyKey,
            providerError: error?.message ?? String(error),
            status: 'failed',
          });
          throw error;
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
      rebalanceStore.get(request.params.idempotencyKey) ?? {
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
  destinationAsset: 'USDC';
  destinationNetwork?: string;
  destinationVenue?: string;
  idempotencyKey: string;
  minAmount: string;
  provider: 'hyperliquid_bridge2' | 'cctp_base_arbitrum_usdc';
  sourceAsset: 'USDC';
  sourceChain: 'ethereum';
  sourceNetwork: 'arbitrum' | 'base';
  tokenAddress: string;
  txCalldata: string;
  txCalldataHash: string;
  txTarget: string;
  walletAddress: string;
};

type ProviderOwnedRebalanceExecution = {
  approvalTransactionHash?: string;
  responseStatus: -1 | 0 | 1;
  status: string;
  transactionHash: string;
};

const rebalanceLocks = new Map<string, Promise<void>>();

export async function buildProviderOwnedRebalance(body: BridgeRebalanceRequest): Promise<BuiltProviderOwnedRebalance> {
  if (body.provider === 'cctp_base_arbitrum_usdc') {
    return buildCctpBaseArbitrumUsdcTransfer(body);
  }
  return buildHyperliquidBridge2Transfer(body);
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
    destinationAsset: 'USDC',
    destinationVenue: 'hyperliquid',
    idempotencyKey: body.idempotencyKey,
    minAmount: HYPERLIQUID_BRIDGE2_MIN_USDC,
    provider: 'hyperliquid_bridge2',
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
  const amountUnits = utils.parseUnits(body.amount, USDC_DECIMALS);
  if (amountUnits.lte(0)) {
    throw new Error('CCTP transfer amount must be positive');
  }
  const walletAddress = utils.getAddress(body.walletAddress);
  const destinationAddress = utils.getAddress(body.destinationAddress);
  const mintRecipient = addressToBytes32(destinationAddress);
  const destinationCaller = utils.hexZeroPad('0x', 32);
  const approvalTxCalldata = erc20ApprovalInterface.encodeFunctionData('approve', [
    CCTP_V2_TOKEN_MESSENGER_ADDRESS,
    amountUnits,
  ]);
  const txCalldata = cctpTokenMessengerInterface.encodeFunctionData('depositForBurn', [
    amountUnits,
    CCTP_ARBITRUM_DOMAIN,
    mintRecipient,
    BASE_USDC_ADDRESS,
    destinationCaller,
    BigNumber.from(0),
    CCTP_STANDARD_FINALITY_THRESHOLD,
  ]);
  return {
    amount: body.amount,
    approvalCalldataHash: utils.keccak256(approvalTxCalldata),
    approvalTxCalldata,
    approvalTxTarget: BASE_USDC_ADDRESS,
    destinationAddress,
    destinationAsset: 'USDC',
    destinationNetwork: 'arbitrum',
    idempotencyKey: body.idempotencyKey,
    minAmount: '0.000001',
    provider: 'cctp_base_arbitrum_usdc',
    sourceAsset: 'USDC',
    sourceChain: 'ethereum',
    sourceNetwork: 'base',
    tokenAddress: BASE_USDC_ADDRESS,
    txCalldata,
    txCalldataHash: utils.keccak256(txCalldata),
    txTarget: CCTP_V2_TOKEN_MESSENGER_ADDRESS,
    walletAddress,
  };
}

async function executeProviderOwnedRebalance(
  built: BuiltProviderOwnedRebalance,
  liveActionAuthorization: LiveActionAuthorization,
): Promise<ProviderOwnedRebalanceExecution> {
  if (built.provider === 'cctp_base_arbitrum_usdc') {
    return executeCctpBaseArbitrumUsdcTransfer(built, liveActionAuthorization);
  }
  return executeSingleTransactionRebalance(
    built,
    liveActionAuthorization,
    HYPERLIQUID_BRIDGE2_GAS_LIMIT,
    'hyperliquid_bridge2_rebalance',
  );
}

async function executeSingleTransactionRebalance(
  built: BuiltProviderOwnedRebalance,
  liveActionAuthorization: LiveActionAuthorization,
  gasLimit: number,
  providerIntentSource: string,
): Promise<ProviderOwnedRebalanceExecution> {
  const ethereum = await Ethereum.getInstance(built.sourceNetwork);
  const wallet = await ethereum.getWallet(built.walletAddress);
  const gasOptions = await ethereum.prepareGasOptions(
    undefined,
    gasLimit,
    liveActionAuthorization,
    providerIntentSource,
  );
  const txResponse = await wallet.sendTransaction({
    data: built.txCalldata,
    to: built.txTarget,
    value: BigNumber.from(0),
    ...gasOptions,
  });
  const receipt = await ethereum.handleTransactionExecution(txResponse);
  return {
    responseStatus: receipt?.status === 1 ? 1 : receipt?.status === 0 ? -1 : 0,
    status: receipt?.status === 1 ? 'confirmed' : receipt?.status === 0 ? 'failed' : 'submitted',
    transactionHash: txResponse.hash,
  };
}

async function executeCctpBaseArbitrumUsdcTransfer(
  built: BuiltProviderOwnedRebalance,
  liveActionAuthorization: LiveActionAuthorization,
): Promise<ProviderOwnedRebalanceExecution> {
  if (!built.approvalTxCalldata || !built.approvalTxTarget) {
    throw new Error('CCTP approval transaction missing from provider-owned build');
  }
  const ethereum = await Ethereum.getInstance('base');
  const wallet = await ethereum.getWallet(built.walletAddress);
  const approvalGasOptions = await ethereum.prepareGasOptions(
    undefined,
    CCTP_APPROVE_GAS_LIMIT,
    liveActionAuthorization,
    'cctp_base_arbitrum_usdc_rebalance',
  );
  const approvalTx = await wallet.sendTransaction({
    data: built.approvalTxCalldata,
    to: built.approvalTxTarget,
    value: BigNumber.from(0),
    ...approvalGasOptions,
  });
  const approvalReceipt = await ethereum.handleTransactionExecution(approvalTx);
  if (approvalReceipt?.status === 0) {
    throw new Error('CCTP USDC approval failed');
  }
  const burnGasOptions = await ethereum.prepareGasOptions(
    undefined,
    CCTP_BURN_GAS_LIMIT,
    liveActionAuthorization,
    'cctp_base_arbitrum_usdc_rebalance',
  );
  const burnTx = await wallet.sendTransaction({
    data: built.txCalldata,
    to: built.txTarget,
    value: BigNumber.from(0),
    ...burnGasOptions,
  });
  const burnReceipt = await ethereum.handleTransactionExecution(burnTx);
  return {
    approvalTransactionHash: approvalTx.hash,
    responseStatus: burnReceipt?.status === 1 ? 1 : burnReceipt?.status === 0 ? -1 : 0,
    status: burnReceipt?.status === 1 ? 'burn_confirmed' : burnReceipt?.status === 0 ? 'failed' : 'burn_submitted',
    transactionHash: burnTx.hash,
  };
}

function providerTreasuryConnectorId(provider: BridgeRebalanceRequest['provider']): string {
  return provider === 'cctp_base_arbitrum_usdc' ? 'treasury' : 'hyperliquid';
}

function providerTreasuryIntentSource(provider: BridgeRebalanceRequest['provider']): string {
  return provider === 'cctp_base_arbitrum_usdc' ? 'cctp_base_arbitrum_usdc_rebalance' : 'hyperliquid_bridge2_rebalance';
}

function addressToBytes32(address: string): string {
  return utils.hexZeroPad(utils.getAddress(address), 32);
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
