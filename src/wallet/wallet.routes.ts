import sensible from '@fastify/sensible';
import { FastifyPluginAsync } from 'fastify';

import { MARLIN_RUNTIME_PROFILE_ENV, isMarlinRuntimeProfile } from '../services/marlin-runtime';

import { addHardwareWalletRoute } from './routes/addHardwareWallet';
import { addWalletRoute } from './routes/addWallet';
import { createWalletRoute } from './routes/createWallet';
import { getWalletsRoute } from './routes/getWallets';
import { removeWalletRoute } from './routes/removeWallet';
import { sendTransactionRoute } from './routes/sendTransaction';
import { setDefaultRoute } from './routes/setDefault';
import { setMarlinDefaultRoute } from './routes/setMarlinDefault';
import { showPrivateKeyRoute } from './routes/showPrivateKey';
import { signTypedDataRoute } from './routes/signTypedData';

export { MARLIN_RUNTIME_PROFILE_ENV, isMarlinRuntimeProfile };

export const walletRoutes: FastifyPluginAsync = async (fastify) => {
  // Register fastify-sensible for httpErrors
  await fastify.register(sensible);

  // Marlin runtime may read public wallet identity and set only the
  // mnemonic-derived default wallet needed by provider execution.
  await fastify.register(getWalletsRoute);
  await fastify.register(setMarlinDefaultRoute);
  if (isMarlinRuntimeProfile()) {
    return;
  }

  // Register operator wallet-admin routes outside Marlin runtime only.
  await fastify.register(addWalletRoute);
  await fastify.register(createWalletRoute);
  await fastify.register(addHardwareWalletRoute);
  await fastify.register(removeWalletRoute);
  await fastify.register(setDefaultRoute);
  await fastify.register(showPrivateKeyRoute);
  await fastify.register(sendTransactionRoute);
  await fastify.register(signTypedDataRoute);
};

export default walletRoutes;
