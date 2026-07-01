import { FastifyPluginAsync } from 'fastify';

import { ExecuteSwapRequestType, SwapExecuteResponseType, SwapExecuteResponse } from '../../../schemas/router-schema';
import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import { LiveActionAuthorization } from '../../../services/runtime-guard';
import { JupiterConfig } from '../jupiter.config';
import { JupiterExecuteSwapRequest } from '../schemas';

import { executeQuote } from './executeQuote';
import { quoteSwap } from './quoteSwap';

const MARLIN_PROVIDER_INTENT_HEADER = 'x-marlin-provider-intent';

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
): Promise<SwapExecuteResponseType> {
  // Step 1: Get a fresh quote using the quoteSwap function
  const quoteResult = await quoteSwap(network, baseToken, quoteToken, amount, side, slippagePct);

  // Step 2: Execute the quote immediately using executeQuote function
  const executeResult = await executeQuote(
    walletAddress,
    network,
    quoteResult.quoteId,
    priorityLevel ?? JupiterConfig.config.priorityLevel,
    maxLamports ?? JupiterConfig.config.maxLamports,
    liveActionAuthorization,
    internalProviderIntentSource,
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
        const liveActionAuthorization = marlinProviderIntentHeaderMatches(
          request.headers[MARLIN_PROVIDER_INTENT_HEADER],
        )
          ? bodyWithInternalFields.liveActionAuthorization
          : undefined;
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

function marlinProviderIntentHeaderMatches(value: unknown): boolean {
  const expected = (process.env.GATEWAY_PASSPHRASE ?? '').trim();
  if (!expected) {
    return false;
  }
  const provided = Array.isArray(value) ? value[0] : value;
  return typeof provided === 'string' && provided === expected;
}
