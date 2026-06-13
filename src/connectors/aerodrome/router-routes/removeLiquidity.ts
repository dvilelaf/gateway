import { Static } from '@sinclair/typebox';
import { FastifyPluginAsync } from 'fastify';

import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import { executeAerodromeRemoveLiquidity } from '../aerodrome.adapter';
import { AerodromeLiquidityExecuteResponse, AerodromeRemoveLiquidityRequest } from '../schemas';

export const removeLiquidityRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Body: Static<typeof AerodromeRemoveLiquidityRequest>;
    Reply: Static<typeof AerodromeLiquidityExecuteResponse>;
  }>(
    '/remove-liquidity',
    {
      schema: {
        description: 'Remove liquidity from an Aerodrome pool through Gateway-managed wallet execution',
        tags: ['/connector/aerodrome'],
        body: AerodromeRemoveLiquidityRequest,
        response: { 200: AerodromeLiquidityExecuteResponse },
      },
    },
    async (request) => {
      try {
        const { network = 'base' } = request.body;
        return (await executeAerodromeRemoveLiquidity(network, request.body)) as Static<
          typeof AerodromeLiquidityExecuteResponse
        >;
      } catch (e: any) {
        if (e.statusCode) throw e;
        logger.error('Error removing Aerodrome liquidity:', e);
        throw httpErrors.internalServerError(e.message || 'Internal server error');
      }
    },
  );
};

export default removeLiquidityRoute;
