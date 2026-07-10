import sensible from '@fastify/sensible';
import { FastifyPluginAsync } from 'fastify';

import { getWalletsRoute } from './routes/getWallets';
import { marlinCowSignTypedDataRoute } from './routes/marlinCowSignTypedData';
import { setMarlinDefaultRoute } from './routes/setMarlinDefault';

export const walletRoutes: FastifyPluginAsync = async (fastify) => {
  // Register sensible for httpErrors used by retained routes
  await fastify.register(sensible);

  await fastify.register(getWalletsRoute);
  await fastify.register(setMarlinDefaultRoute);
  await fastify.register(marlinCowSignTypedDataRoute);
};

export default walletRoutes;
