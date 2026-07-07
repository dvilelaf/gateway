import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';

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
const CCTP_V2_MESSAGE_TRANSMITTER_ADDRESS = '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64';
const CCTP_BASE_DOMAIN = 6;
const CCTP_ARBITRUM_DOMAIN = 3;
const CCTP_STANDARD_FINALITY_THRESHOLD = 2000;
const HYPERLIQUID_BRIDGE2_MIN_USDC = '5';
const HYPERLIQUID_BRIDGE2_GAS_LIMIT = 120000;
const CCTP_APPROVE_GAS_LIMIT = 90000;
const CCTP_BURN_GAS_LIMIT = 220000;
const CCTP_FINALIZE_GAS_LIMIT = 300000;
const CCTP_IRIS_MAINNET_URL = 'https://iris-api.circle.com';
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
  burnTransactionHash: Type.Optional(Type.String()),
  finalizeTransactionHash: Type.Optional(Type.String()),
  transactionHash: Type.Optional(Type.String()),
  providerStatus: Type.Optional(Type.String()),
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

const rebalanceStore = new Map<string, DurableRebalanceState>();
const erc20Interface = new utils.Interface(['function transfer(address to, uint256 amount) returns (bool)']);
const erc20ApprovalInterface = new utils.Interface([
  'function approve(address spender, uint256 amount) returns (bool)',
]);
const cctpTokenMessengerInterface = new utils.Interface([
  'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)',
]);
const cctpMessageTransmitterInterface = new utils.Interface([
  'function receiveMessage(bytes message, bytes attestation) returns (bool)',
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
      const state = await loadOrCreateRebalanceState(built, request.body);
      await saveRebalanceState({
        ...state,
        idempotencyKey: request.body.idempotencyKey,
        status: state.status,
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
        const built = await buildProviderOwnedRebalance(request.body);
        const existing = await loadOrCreateRebalanceState(built, request.body);
        const existingHash = bestKnownTransactionHash(existing);
        if (existing.status === 'confirmed' || existing.status === 'failed') {
          return {
            signature: existingHash,
            status: existing.status === 'confirmed' ? 1 : -1,
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
        assertCctpDestinationAuthorization(request.body, liveActionAuthorization);

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
          });
          return { signature: execution.transactionHash, status: execution.responseStatus };
        } catch (error: any) {
          const latest = (await readRebalanceState(request.body.idempotencyKey)) ?? existing;
          await saveRebalanceState({
            ...latest,
            idempotencyKey: request.body.idempotencyKey,
            providerError: redactProviderError(error),
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
      (await readRebalanceState(request.params.idempotencyKey)) ?? {
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
};

type DurableRebalanceState = BridgeRebalanceStatus & {
  amount: string;
  burnTransactionHash?: string;
  cctpAttestation?: string;
  cctpMessage?: string;
  cctpMessageHash?: string;
  destinationAddress: string;
  destinationAsset: string;
  destinationNetwork?: string;
  destinationVenue?: string;
  finalizeTransactionHash?: string;
  provider: BuiltProviderOwnedRebalance['provider'];
  requestFingerprint: string;
  sourceChain: string;
  sourceNetwork: string;
  walletAddress: string;
};

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
  state: DurableRebalanceState,
): Promise<ProviderOwnedRebalanceExecution> {
  if (built.provider === 'cctp_base_arbitrum_usdc') {
    return executeCctpBaseArbitrumUsdcTransfer(built, liveActionAuthorization, state);
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
  state: DurableRebalanceState,
): Promise<ProviderOwnedRebalanceExecution> {
  if (!built.approvalTxCalldata || !built.approvalTxTarget) {
    throw new Error('CCTP approval transaction missing from provider-owned build');
  }
  const ethereum = await Ethereum.getInstance('base');
  const wallet = await ethereum.getWallet(built.walletAddress);
  let approvalTransactionHash = state.approvalTransactionHash;
  if (!approvalTransactionHash) {
    await saveRebalanceState({ ...state, status: 'built' });
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
    if (approvalReceipt?.status !== 1) {
      throw new Error('CCTP USDC approval not confirmed');
    }
    approvalTransactionHash = approvalTx.hash;
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
    if (burnReceipt?.status !== 1) {
      return {
        approvalTransactionHash,
        burnTransactionHash: burnTx.hash,
        responseStatus: burnReceipt?.status === 0 ? -1 : 0,
        status: burnReceipt?.status === 0 ? 'failed' : 'burn_submitted',
        transactionHash: burnTx.hash,
      };
    }
    burnTransactionHash = burnTx.hash;
    state = {
      ...state,
      approvalTransactionHash,
      burnTransactionHash,
      status: 'burn_confirmed',
      transactionHash: burnTransactionHash,
    };
    await saveRebalanceState(state);
  }

  if (state.finalizeTransactionHash) {
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

  const attestation = await fetchCctpAttestation(state);
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

  const finalizeEthereum = await Ethereum.getInstance('arbitrum');
  assertMainnetMutationAllowed({
    chain: 'ethereum',
    expectedConnectorId: providerTreasuryConnectorId(built.provider),
    expectedNotional: built.amount,
    expectedWalletAddress: built.destinationAddress,
    internalProviderIntentSource: 'cctp_base_arbitrum_usdc_rebalance',
    liveActionAuthorization,
    network: 'arbitrum',
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
    'cctp_base_arbitrum_usdc_rebalance',
  );
  const finalizeTx = await finalizeWallet.sendTransaction({
    data: finalizeCalldata,
    to: CCTP_V2_MESSAGE_TRANSMITTER_ADDRESS,
    value: BigNumber.from(0),
    ...finalizeGasOptions,
  });
  const finalizeReceipt = await finalizeEthereum.handleTransactionExecution(finalizeTx);
  return {
    approvalTransactionHash,
    burnTransactionHash,
    cctpAttestation: state.cctpAttestation,
    cctpMessage: state.cctpMessage,
    cctpMessageHash: state.cctpMessageHash,
    finalizeTransactionHash: finalizeTx.hash,
    providerStatus: state.providerStatus,
    responseStatus: finalizeReceipt?.status === 1 ? 1 : finalizeReceipt?.status === 0 ? -1 : 0,
    status:
      finalizeReceipt?.status === 1 ? 'confirmed' : finalizeReceipt?.status === 0 ? 'failed' : 'finalize_submitted',
    transactionHash: finalizeTx.hash,
  };
}

async function fetchCctpAttestation(state: DurableRebalanceState): Promise<
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
      `/v2/messages/${CCTP_BASE_DOMAIN}`,
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
  validateCctpMessage(state, message);
  return {
    attestation: requireHex(message.attestation, 'CCTP attestation'),
    message: requireHex(message.message, 'CCTP message'),
    messageHash: utils.keccak256(requireHex(message.message, 'CCTP message')),
    providerStatus,
    status: 'ready',
  };
}

function validateCctpMessage(state: DurableRebalanceState, message: CircleCctpMessage): void {
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
  if (parsed.sourceDomain !== CCTP_BASE_DOMAIN || String(decoded?.sourceDomain) !== String(CCTP_BASE_DOMAIN)) {
    throw new Error('CCTP source domain mismatch');
  }
  if (
    parsed.destinationDomain !== CCTP_ARBITRUM_DOMAIN ||
    String(decoded?.destinationDomain) !== String(CCTP_ARBITRUM_DOMAIN)
  ) {
    throw new Error('CCTP destination domain mismatch');
  }
  if (
    !addressesEqual(bytes32ToAddress(parsed.sender), CCTP_V2_TOKEN_MESSENGER_ADDRESS) ||
    !addressesEqual(bytes32ToAddress(String(decoded?.sender ?? '')), CCTP_V2_TOKEN_MESSENGER_ADDRESS)
  ) {
    throw new Error('CCTP sender mismatch');
  }
  if (
    !addressesEqual(bytes32ToAddress(parsed.recipient), CCTP_V2_TOKEN_MESSENGER_ADDRESS) ||
    !addressesEqual(bytes32ToAddress(String(decoded?.recipient ?? '')), CCTP_V2_TOKEN_MESSENGER_ADDRESS)
  ) {
    throw new Error('CCTP recipient mismatch');
  }
  if (!isZeroBytes32OrAddress(parsed.destinationCaller) || !isZeroBytes32OrAddress(decoded?.destinationCaller)) {
    throw new Error('CCTP destination caller must allow provider-owned finalize');
  }
  if (
    !addressesEqual(bytes32ToAddress(parsed.burnToken), BASE_USDC_ADDRESS) ||
    !addressesEqual(bytes32ToAddress(String(body?.burnToken ?? '')), BASE_USDC_ADDRESS)
  ) {
    throw new Error('CCTP burn token mismatch');
  }
  if (
    !addressesEqual(bytes32ToAddress(parsed.mintRecipient), state.destinationAddress) ||
    !addressesEqual(bytes32ToAddress(String(body?.mintRecipient ?? '')), state.destinationAddress)
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

function assertCctpDestinationAuthorization(
  body: BridgeRebalanceRequest,
  authorization: LiveActionAuthorization,
): void {
  if (body.provider !== 'cctp_base_arbitrum_usdc') {
    return;
  }
  const fields = authorization as Record<string, unknown>;
  if (
    !authorizationValueMatches(body.destinationNetwork, fields.destination_network) ||
    !authorizationValueMatches(body.destinationAddress, fields.destination_address)
  ) {
    throw new Error('CCTP provider treasury authorization does not match destination');
  }
}

async function loadOrCreateRebalanceState(
  built: BuiltProviderOwnedRebalance,
  body: BridgeRebalanceRequest,
): Promise<DurableRebalanceState> {
  const requestFingerprint = rebalanceRequestFingerprint(built);
  const existing = await readRebalanceState(body.idempotencyKey);
  if (existing) {
    if (existing.requestFingerprint !== requestFingerprint) {
      throw new Error('idempotency key already used for a different rebalance request');
    }
    return existing;
  }
  const state: DurableRebalanceState = {
    amount: built.amount,
    destinationAddress: built.destinationAddress,
    destinationAsset: built.destinationAsset,
    destinationNetwork: built.destinationNetwork,
    destinationVenue: built.destinationVenue,
    idempotencyKey: body.idempotencyKey,
    provider: built.provider,
    requestFingerprint,
    sourceChain: built.sourceChain,
    sourceNetwork: built.sourceNetwork,
    status: 'built',
    walletAddress: built.walletAddress,
  };
  await saveRebalanceState(state);
  return state;
}

async function readRebalanceState(idempotencyKey: string): Promise<DurableRebalanceState | undefined> {
  const memoryState = rebalanceStore.get(idempotencyKey);
  if (memoryState) {
    return memoryState;
  }
  const filePath = rebalanceStatePath(idempotencyKey);
  if (!existsSync(filePath)) {
    return undefined;
  }
  const state = JSON.parse(readFileSync(filePath, 'utf8')) as DurableRebalanceState;
  rebalanceStore.set(idempotencyKey, state);
  return state;
}

async function saveRebalanceState(state: DurableRebalanceState): Promise<void> {
  const dir = rebalanceStateDir();
  mkdirSync(dir, { recursive: true });
  const filePath = rebalanceStatePath(state.idempotencyKey);
  const tmpPath = `${filePath}.tmp`;
  const persisted = removeUndefinedFields(state);
  writeFileSync(tmpPath, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmpPath, filePath);
  rebalanceStore.set(state.idempotencyKey, persisted);
}

function rebalanceStateDir(): string {
  return path.resolve(process.cwd(), 'conf/marlin/rebalances');
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

function rebalanceRequestFingerprint(built: BuiltProviderOwnedRebalance): string {
  return utils.keccak256(
    utils.toUtf8Bytes(
      JSON.stringify({
        amount: built.amount,
        destinationAddress: built.destinationAddress,
        destinationAsset: built.destinationAsset,
        destinationNetwork: built.destinationNetwork,
        destinationVenue: built.destinationVenue,
        provider: built.provider,
        sourceChain: built.sourceChain,
        sourceNetwork: built.sourceNetwork,
        walletAddress: built.walletAddress,
      }),
    ),
  );
}

function bestKnownTransactionHash(state: DurableRebalanceState): string {
  return (
    state.finalizeTransactionHash ??
    state.burnTransactionHash ??
    state.approvalTransactionHash ??
    state.transactionHash ??
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
    .slice(0, 300);
}

function requireHex(value: unknown, label: string): string {
  if (typeof value !== 'string' || !utils.isHexString(value)) {
    throw new Error(`${label} missing or invalid`);
  }
  return value;
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
