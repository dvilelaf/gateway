import { Static } from '@sinclair/typebox';
import { FastifyPluginAsync } from 'fastify';

import { httpErrors } from '../../../services/error-handler';
import { logger } from '../../../services/logger';
import { executeAerodromeAddLiquidity } from '../aerodrome.adapter';
import { AerodromeAddLiquidityRequest, AerodromeLiquidityExecuteResponse } from '../schemas';

export const addLiquidityRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Body: Static<typeof AerodromeAddLiquidityRequest>;
    Reply: Static<typeof AerodromeLiquidityExecuteResponse>;
  }>(
    '/add-liquidity',
    {
      schema: {
        description: 'Add liquidity to an Aerodrome pool through Gateway-managed wallet execution',
        tags: ['/connector/aerodrome'],
        body: AerodromeAddLiquidityRequest,
        response: { 200: AerodromeLiquidityExecuteResponse },
      },
    },
    async (request) => {
      try {
        const { network = 'base' } = request.body;
        return (await executeAerodromeAddLiquidity(network, request.body)) as Static<
          typeof AerodromeLiquidityExecuteResponse
        >;
      } catch (e: any) {
        if (e.statusCode) throw e;
        logger.error('Error adding Aerodrome liquidity:', e);
        throw httpErrors.internalServerError(e.message || 'Internal server error');
      }
    },
  );
};

export default addLiquidityRoute;
