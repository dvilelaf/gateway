import { Static } from '@sinclair/typebox';
import { FastifyPluginAsync } from 'fastify';

import { getEthereumChainConfig } from '../../../chains/ethereum/ethereum.config';
import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import { AerodromeQuoteSwapRequest, AerodromeQuoteSwapResponse } from '../schemas';
import { quoteAerodrome } from '../aerodrome.adapter';

export const quoteSwapRoute: FastifyPluginAsync = async (fastify) => {
  const chainConfig = getEthereumChainConfig();

  fastify.get<{
    Querystring: Static<typeof AerodromeQuoteSwapRequest>;
    Reply: Static<typeof AerodromeQuoteSwapResponse>;
  }>(
    '/quote-swap',
    {
      schema: {
        description: 'Get an Aerodrome router swap quote by delegating to the optional Aerodrome connector package',
        tags: ['/connector/aerodrome'],
        querystring: AerodromeQuoteSwapRequest,
        response: { 200: AerodromeQuoteSwapResponse },
      },
    },
    async (request) => {
      try {
        const { network = 'base' } = request.query;
        return (await quoteAerodrome(network || chainConfig.defaultNetwork, request.query)) as Static<
          typeof AerodromeQuoteSwapResponse
        >;
      } catch (e: any) {
        if (e.statusCode) throw e;
        logger.error('Error getting Aerodrome quote:', e);
        throw httpErrors.internalServerError(e.message || 'Internal server error');
      }
    },
  );
};

export default quoteSwapRoute;
