import { Static } from '@sinclair/typebox';
import { FastifyPluginAsync } from 'fastify';

import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import { executeAerodromeQuote } from '../aerodrome.adapter';
import { AerodromeExecuteQuoteRequest, AerodromeSwapExecuteResponse } from '../schemas';

export const executeQuoteRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Body: Static<typeof AerodromeExecuteQuoteRequest>;
    Reply: Static<typeof AerodromeSwapExecuteResponse>;
  }>(
    '/execute-quote',
    {
      schema: {
        description: 'Execute a cached Aerodrome quote through an injected Gateway wallet executor',
        tags: ['/connector/aerodrome'],
        body: AerodromeExecuteQuoteRequest,
        response: { 200: AerodromeSwapExecuteResponse },
      },
    },
    async (request) => {
      try {
        const { network = 'base', quoteId, walletAddress } = request.body;
        return (await executeAerodromeQuote(network, quoteId, walletAddress)) as Static<
          typeof AerodromeSwapExecuteResponse
        >;
      } catch (e: any) {
        if (e.statusCode) throw e;
        logger.error('Error executing Aerodrome quote:', e);
        throw httpErrors.internalServerError(e.message || 'Internal server error');
      }
    },
  );
};

export default executeQuoteRoute;
