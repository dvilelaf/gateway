import sensible from '@fastify/sensible';
import { FastifyPluginAsync } from 'fastify';

import { aerodromeRouterRoutes } from './router-routes';

const aerodromeRouterRoutesWrapper: FastifyPluginAsync = async (fastify) => {
  await fastify.register(sensible);

  await fastify.register(async (instance) => {
    instance.addHook('onRoute', (routeOptions) => {
      if (routeOptions.schema && routeOptions.schema.tags) {
        routeOptions.schema.tags = ['/connector/aerodrome'];
      }
    });

    await instance.register(aerodromeRouterRoutes);
  });
};

export const aerodromeRoutes = {
  router: aerodromeRouterRoutesWrapper,
};

export default aerodromeRoutes;
