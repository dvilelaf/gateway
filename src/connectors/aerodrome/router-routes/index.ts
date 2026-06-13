import { FastifyPluginAsync } from 'fastify';

import addLiquidityRoute from './addLiquidity';
import executeSwapRoute from './executeSwap';
import quoteSwapRoute from './quoteSwap';
import removeLiquidityRoute from './removeLiquidity';

export const aerodromeRouterRoutes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(quoteSwapRoute);
  await fastify.register(executeSwapRoute);
  await fastify.register(addLiquidityRoute);
  await fastify.register(removeLiquidityRoute);
};

export default aerodromeRouterRoutes;
