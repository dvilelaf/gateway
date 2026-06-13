import { Static } from '@sinclair/typebox';
import { FastifyPluginAsync } from 'fastify';

import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import { executeAerodromeSwap } from '../aerodrome.adapter';
import { AerodromeExecuteSwapRequest, AerodromeSwapExecuteResponse } from '../schemas';

export const executeSwapRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Body: Static<typeof AerodromeExecuteSwapRequest>;
    Reply: Static<typeof AerodromeSwapExecuteResponse>;
  }>(
    '/execute-swap',
    {
      schema: {
        description: 'Plan and execute an Aerodrome swap through an injected Gateway wallet executor',
        tags: ['/connector/aerodrome'],
        body: AerodromeExecuteSwapRequest,
        response: { 200: AerodromeSwapExecuteResponse },
      },
    },
    async (request) => {
      try {
        const { network = 'base' } = request.body;
        return (await executeAerodromeSwap(network, request.body)) as Static<typeof AerodromeSwapExecuteResponse>;
      } catch (e: any) {
        if (e.statusCode) throw e;
        logger.error('Error executing Aerodrome swap:', e);
        throw httpErrors.internalServerError(e.message || 'Internal server error');
      }
    },
  );
};

export default executeSwapRoute;
