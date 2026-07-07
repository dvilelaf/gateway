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
const HYPERLIQUID_BRIDGE2_MIN_USDC = '5';
const HYPERLIQUID_BRIDGE2_GAS_LIMIT = 120000;
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

const BridgeRebalanceRequestSchema = Type.Object(
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

const BridgeRebalanceExecutionStatusSchema = Type.Object({
  idempotencyKey: Type.String(),
  status: Type.String(),
  transactionHash: Type.Optional(Type.String()),
  providerError: Type.Optional(Type.String()),
});

const BridgeRebalanceBuildResponseSchema = Type.Object({
  provider: Type.Literal('hyperliquid_bridge2'),
  idempotencyKey: Type.String(),
  sourceChain: Type.Literal('ethereum'),
  sourceNetwork: Type.Literal('arbitrum'),
  sourceAsset: Type.Literal('USDC'),
  destinationVenue: Type.Literal('hyperliquid'),
  destinationAsset: Type.Literal('USDC'),
  walletAddress: Type.String(),
  destinationAddress: Type.String(),
  amount: Type.String(),
  txTarget: Type.String(),
  txCalldataHash: Type.String(),
  minAmount: Type.String(),
});

type BridgeRebalanceRequest = Static<typeof BridgeRebalanceRequestSchema>;
type BridgeRebalanceStatus = Static<typeof BridgeRebalanceExecutionStatusSchema>;

const rebalanceStore = new Map<string, BridgeRebalanceStatus>();
const erc20Interface = new utils.Interface(['function transfer(address to, uint256 amount) returns (bool)']);

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
      const built = await buildHyperliquidBridge2Transfer(request.body);
      rebalanceStore.set(request.body.idempotencyKey, {
        idempotencyKey: request.body.idempotencyKey,
        status: 'built',
      });
      return {
        amount: built.amount,
        destinationAddress: built.destinationAddress,
        destinationAsset: built.destinationAsset,
        destinationVenue: built.destinationVenue,
        idempotencyKey: built.idempotencyKey,
        minAmount: built.minAmount,
        provider: built.provider,
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
    async (request) => {
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
          connector_id: 'hyperliquid',
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

      const built = await buildHyperliquidBridge2Transfer(request.body);
      assertMainnetMutationAllowed({
        chain: 'ethereum',
        expectedConnectorId: 'hyperliquid',
        expectedNotional: request.body.amount,
        expectedWalletAddress: request.body.walletAddress,
        internalProviderIntentSource: 'hyperliquid_bridge2_rebalance',
        liveActionAuthorization,
        network: request.body.sourceNetwork,
        operation: 'ethereum_transaction',
      });
      rebalanceStore.set(request.body.idempotencyKey, {
        idempotencyKey: request.body.idempotencyKey,
        status: 'pending',
      });
      try {
        const ethereum = await Ethereum.getInstance(request.body.sourceNetwork);
        const wallet = await ethereum.getWallet(built.walletAddress);
        const gasOptions = await ethereum.prepareGasOptions(
          undefined,
          HYPERLIQUID_BRIDGE2_GAS_LIMIT,
          liveActionAuthorization,
          'hyperliquid_bridge2_rebalance',
        );
        const txResponse = await wallet.sendTransaction({
          data: built.txCalldata,
          to: built.tokenAddress,
          value: BigNumber.from(0),
          ...gasOptions,
        });
        const receipt = await ethereum.handleTransactionExecution(txResponse);
        const status = receipt?.status === 1 ? 'confirmed' : receipt?.status === 0 ? 'failed' : 'submitted';
        rebalanceStore.set(request.body.idempotencyKey, {
          idempotencyKey: request.body.idempotencyKey,
          status,
          transactionHash: txResponse.hash,
        });
        return { signature: txResponse.hash, status: receipt?.status === 1 ? 1 : receipt?.status === 0 ? -1 : 0 };
      } catch (error: any) {
        rebalanceStore.set(request.body.idempotencyKey, {
          idempotencyKey: request.body.idempotencyKey,
          providerError: error?.message ?? String(error),
          status: 'failed',
        });
        throw error;
      }
    },
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

export async function buildHyperliquidBridge2Transfer(body: BridgeRebalanceRequest): Promise<{
  amount: string;
  destinationAddress: string;
  destinationAsset: 'USDC';
  destinationVenue: 'hyperliquid';
  idempotencyKey: string;
  minAmount: string;
  provider: 'hyperliquid_bridge2';
  sourceAsset: 'USDC';
  sourceChain: 'ethereum';
  sourceNetwork: 'arbitrum';
  tokenAddress: string;
  txCalldata: string;
  txCalldataHash: string;
  txTarget: string;
  walletAddress: string;
}> {
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
