import { readFileSync } from 'fs';
import path from 'path';

import Fastify from 'fastify';

import walletRoutes, { MARLIN_RUNTIME_PROFILE_ENV, isMarlinRuntimeProfile } from '../../src/wallet/wallet.routes';

const ROOT = path.resolve(__dirname, '../..');

describe('Marlin wallet route profile', () => {
  const originalProfile = process.env[MARLIN_RUNTIME_PROFILE_ENV];

  afterEach(() => {
    if (originalProfile === undefined) {
      delete process.env[MARLIN_RUNTIME_PROFILE_ENV];
    } else {
      process.env[MARLIN_RUNTIME_PROFILE_ENV] = originalProfile;
    }
  });

  it('detects the Marlin runtime profile explicitly', () => {
    delete process.env[MARLIN_RUNTIME_PROFILE_ENV];
    expect(isMarlinRuntimeProfile()).toBe(false);

    process.env[MARLIN_RUNTIME_PROFILE_ENV] = 'marlin';
    expect(isMarlinRuntimeProfile()).toBe(true);
    expect(MARLIN_RUNTIME_PROFILE_ENV).toBe('MARLIN_RUNTIME_PROFILE');
  });

  it('registers only public listing and scoped default before returning in Marlin profile', () => {
    const source = readFileSync(path.join(ROOT, 'src/wallet/wallet.routes.ts'), 'utf8');
    const marlinBranch = source.slice(
      source.indexOf('await fastify.register(getWalletsRoute);'),
      source.indexOf('// Register operator wallet-admin routes outside Marlin runtime only.'),
    );

    expect(marlinBranch).toContain('await fastify.register(getWalletsRoute);');
    expect(marlinBranch).toContain('await fastify.register(setMarlinDefaultRoute);');
    expect(marlinBranch).toContain('if (isMarlinRuntimeProfile())');
    expect(marlinBranch).toContain('return;');
    for (const route of [
      'addWalletRoute',
      'createWalletRoute',
      'addHardwareWalletRoute',
      'removeWalletRoute',
      'setDefaultRoute',
      'showPrivateKeyRoute',
      'sendTransactionRoute',
      'signTypedDataRoute',
    ]) {
      expect(marlinBranch).not.toContain(route);
    }
  });

  it('requires Marlin profile and policy metadata for scoped default route', () => {
    const source = readFileSync(path.join(ROOT, 'src/wallet/routes/setMarlinDefault.ts'), 'utf8');

    expect(source).toContain('isMarlinRuntimeProfile()');
    expect(source).toContain('walletRef does not match Marlin policy');
    expect(source).toContain('getSafeWalletFilePath(chain, validatedAddress)');
    expect(source).toContain('writeMarlinDefaultWalletMetadata(chain');
  });

  it('exposes scoped Marlin default metadata in public wallet listing', () => {
    const source = readFileSync(path.join(ROOT, 'src/wallet/utils.ts'), 'utf8');

    expect(source).toContain('readMarlinDefaultWalletMetadata(safeChain)');
    expect(source).toContain('default_address: marlinDefault?.address');
    expect(source).toContain('walletRef: marlinDefault?.walletRef');
  });

  it('does not register wallet admin routes in Marlin profile', async () => {
    process.env[MARLIN_RUNTIME_PROFILE_ENV] = 'marlin';
    const app = Fastify();
    await app.register(walletRoutes, { prefix: '/wallet' });
    await app.ready();

    for (const request of [
      { method: 'POST', url: '/wallet/add' },
      { method: 'POST', url: '/wallet/create' },
      { method: 'POST', url: '/wallet/setDefault' },
      { method: 'POST', url: '/wallet/show-private-key' },
      { method: 'POST', url: '/wallet/send' },
      { method: 'POST', url: '/wallet/sign-typed-data' },
      { method: 'POST', url: '/wallet/sign' },
    ] as const) {
      const response = await app.inject(request);

      expect(response.statusCode).toBe(404);
    }

    const publicList = await app.inject({ method: 'GET', url: '/wallet/?showHardware=false' });
    expect(publicList.statusCode).toBe(200);
    await app.close();
  });

  it('validates scoped default requests before mutating wallet state', async () => {
    const app = Fastify();
    await app.register(walletRoutes, { prefix: '/wallet' });
    await app.ready();

    delete process.env[MARLIN_RUNTIME_PROFILE_ENV];
    let response = await app.inject({
      method: 'POST',
      url: '/wallet/marlin-default',
      payload: {
        chain: 'ethereum',
        network: 'ethereum-base',
        address: '0x0000000000000000000000000000000000000123',
        walletRef: 'base:mainnet:evm_gateway',
      },
    });
    expect(response.statusCode).toBe(403);

    process.env[MARLIN_RUNTIME_PROFILE_ENV] = 'marlin';
    response = await app.inject({
      method: 'POST',
      url: '/wallet/marlin-default',
      payload: {
        chain: 'ethereum',
        network: 'ethereum-base',
        address: 'not-an-address',
        walletRef: 'base:mainnet:evm_gateway',
      },
    });
    expect(response.statusCode).toBe(400);

    response = await app.inject({
      method: 'POST',
      url: '/wallet/marlin-default',
      payload: {
        chain: 'ethereum',
        network: 'ethereum-base',
        address: '0x0000000000000000000000000000000000000123',
        walletRef: 'operator-wallet',
      },
    });
    expect(response.statusCode).toBe(400);

    response = await app.inject({
      method: 'POST',
      url: '/wallet/marlin-default',
      payload: {
        chain: 'ethereum',
        network: 'ethereum-base',
        address: '0x0000000000000000000000000000000000000123',
        walletRef: 'base:mainnet:evm_gateway',
      },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
