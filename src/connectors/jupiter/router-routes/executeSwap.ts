import { Decimal } from 'decimal.js';
import { FastifyPluginAsync } from 'fastify';

import { ExecuteSwapRequestType, SwapExecuteResponseType, SwapExecuteResponse } from '../../../schemas/router-schema';
import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import {
  LiveActionAuthorization,
  MainnetMutationGuardInput,
  marlinGatewayProviderIntentTokenMatches,
  marlinProviderIntentAuthorizationMatches,
} from '../../../services/runtime-guard';
import { JupiterConfig } from '../jupiter.config';
import { JupiterExecuteSwapRequest } from '../schemas';

import { executeQuote } from './executeQuote';
import { quoteSwap } from './quoteSwap';

const MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN_HEADER = 'x-marlin-gateway-provider-intent-token';

async function executeSwap(
  walletAddress: string,
  network: string,
  baseToken: string,
  quoteToken: string,
  amount: number,
  side: 'BUY' | 'SELL',
  slippagePct: number = JupiterConfig.config.slippagePct,
  priorityLevel?: string,
  maxLamports?: number,
  liveActionAuthorization?: LiveActionAuthorization,
  internalProviderIntentSource?: string,
  guardContext: Pick<
    MainnetMutationGuardInput,
    'expectedConnectorId' | 'expectedNotional' | 'expectedSlippageBps' | 'expectedWalletAddress'
  > = {},
): Promise<SwapExecuteResponseType> {
  // Step 1: Get a fresh quote using the quoteSwap function
  const quoteResult = await quoteSwap(network, baseToken, quoteToken, amount, side, slippagePct);
  if (side === 'BUY' && liveActionAuthorization) {
    const inputTokenDecimals = quoteResult.inputTokenDecimals;
    if (
      quoteResult.quoteResponse.swapMode !== 'ExactOut' ||
      !Number.isFinite(inputTokenDecimals) ||
      !Number.isInteger(inputTokenDecimals) ||
      inputTokenDecimals < 0 ||
      inputTokenDecimals > 18
    ) {
      throw httpErrors.forbidden('Jupiter exact-output quote exceeds authorized notional');
    }
    let authorizedNotional: Decimal;
    try {
      authorizedNotional = new Decimal(String(liveActionAuthorization.notional));
    } catch {
      throw httpErrors.forbidden('Jupiter exact-output quote exceeds authorized notional');
    }
    const rawThresholdText = String(quoteResult.quoteResponse.otherAmountThreshold);
    if (!authorizedNotional.isFinite() || !authorizedNotional.gt(0) || !/^\d+$/.test(rawThresholdText)) {
      throw httpErrors.forbidden('Jupiter exact-output quote exceeds authorized notional');
    }
    const authorizedAtomic = BigInt(
      authorizedNotional.toFixed(inputTokenDecimals, Decimal.ROUND_FLOOR).replace('.', ''),
    );
    const rawThreshold = BigInt(rawThresholdText);
    if (rawThreshold <= 0n || rawThreshold > authorizedAtomic) {
      throw httpErrors.forbidden('Jupiter exact-output quote exceeds authorized notional');
    }
    guardContext = { ...guardContext, expectedNotional: liveActionAuthorization.notional };
  }

  // Step 2: Execute the quote immediately using executeQuote function
  const executeResult = await executeQuote(
    walletAddress,
    network,
    quoteResult.quoteId,
    priorityLevel ?? JupiterConfig.config.priorityLevel,
    maxLamports ?? JupiterConfig.config.maxLamports,
    liveActionAuthorization,
    internalProviderIntentSource,
    guardContext,
  );

  return executeResult;
}

export { executeSwap };

export const executeSwapRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Body: ExecuteSwapRequestType;
    Reply: SwapExecuteResponseType;
  }>(
    '/execute-swap',
    {
      schema: {
        description: 'Quote and execute a token swap on Jupiter in one step',
        tags: ['/connector/jupiter'],
        body: JupiterExecuteSwapRequest,
        response: { 200: SwapExecuteResponse },
      },
    },
    async (request) => {
      try {
        const { walletAddress, network, baseToken, quoteToken, amount, side, slippagePct, priorityLevel, maxLamports } =
          request.body as typeof JupiterExecuteSwapRequest._type;
        const bodyWithInternalFields = request.body as typeof JupiterExecuteSwapRequest._type & {
          liveActionAuthorization?: LiveActionAuthorization;
        };
        const tokenAuthorized = marlinGatewayProviderIntentTokenMatches(
          request.headers[MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN_HEADER],
        );
        const authorizationPresent = bodyWithInternalFields.liveActionAuthorization !== undefined;
        const authorizationShapeMatches = marlinProviderIntentAuthorizationMatches(
          bodyWithInternalFields.liveActionAuthorization,
          {
            action: 'gateway_swap',
            connector_id: 'jupiter',
            network,
            scope: 'provider_intent',
            source: 'marlin',
          },
        );
        const liveActionAuthorization =
          tokenAuthorized && authorizationShapeMatches ? bodyWithInternalFields.liveActionAuthorization : undefined;
        if ((tokenAuthorized || authorizationPresent) && liveActionAuthorization === undefined) {
          throw httpErrors.forbidden(
            'Marlin Jupiter provider intent authorization rejected: ' +
              `token_authorized=${tokenAuthorized}; ` +
              `authorization_present=${authorizationPresent}; ` +
              `authorization_shape_matches=${authorizationShapeMatches}`,
          );
        }
        const internalProviderIntentSource = liveActionAuthorization ? 'jupiter_execute_swap' : undefined;

        return await executeSwap(
          walletAddress,
          network,
          baseToken,
          quoteToken,
          amount,
          side as 'BUY' | 'SELL',
          slippagePct,
          priorityLevel,
          maxLamports,
          liveActionAuthorization,
          internalProviderIntentSource,
          {
            expectedConnectorId: 'jupiter',
            expectedNotional: side === 'BUY' ? (liveActionAuthorization?.notional ?? amount) : amount,
            expectedSlippageBps: (slippagePct ?? JupiterConfig.config.slippagePct) * 100,
            expectedWalletAddress: walletAddress,
          },
        );
      } catch (e) {
        if (e.statusCode) throw e;
        logger.error('Error executing swap:', e);
        throw httpErrors.internalServerError(e.message || 'Internal server error');
      }
    },
  );
};

export default executeSwapRoute;
