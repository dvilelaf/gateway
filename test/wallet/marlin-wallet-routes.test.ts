import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import Fastify from 'fastify';

import { MARLIN_RUNTIME_PROFILE_ENV, isMarlinRuntimeProfile } from '../../src/services/marlin-runtime';
import {
  deriveMarlinDefaultWalletMaterial,
  marlinWalletPolicyFor,
  normalizedMnemonicFromEnv,
} from '../../src/wallet/routes/setMarlinDefault';
import walletRoutes from '../../src/wallet/wallet.routes';

const ROOT = path.resolve(__dirname, '../..');
const MARLIN_MNEMONIC_ENV = 'MARLIN_MNEMONIC';
const MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN_ENV = 'MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN';
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('Marlin wallet route profile', () => {
  const originalProfile = process.env[MARLIN_RUNTIME_PROFILE_ENV];
  const originalMnemonic = process.env[MARLIN_MNEMONIC_ENV];
  const originalGatewayProviderIntentToken = process.env[MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN_ENV];

  afterEach(() => {
    if (originalProfile === undefined) {
      delete process.env[MARLIN_RUNTIME_PROFILE_ENV];
    } else {
      process.env[MARLIN_RUNTIME_PROFILE_ENV] = originalProfile;
    }
    if (originalMnemonic === undefined) {
      delete process.env[MARLIN_MNEMONIC_ENV];
    } else {
      process.env[MARLIN_MNEMONIC_ENV] = originalMnemonic;
    }
    if (originalGatewayProviderIntentToken === undefined) {
      delete process.env[MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN_ENV];
    } else {
      process.env[MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN_ENV] = originalGatewayProviderIntentToken;
    }
  });

  it('detects the Marlin runtime profile explicitly', () => {
    delete process.env[MARLIN_RUNTIME_PROFILE_ENV];
    expect(isMarlinRuntimeProfile()).toBe(false);

    process.env[MARLIN_RUNTIME_PROFILE_ENV] = 'marlin';
    expect(isMarlinRuntimeProfile()).toBe(true);
    expect(MARLIN_RUNTIME_PROFILE_ENV).toBe('MARLIN_RUNTIME_PROFILE');
  });

  it('registers only public listing, scoped default, and Marlin CoW typed-data signing', () => {
    const source = readFileSync(path.join(ROOT, 'src/wallet/wallet.routes.ts'), 'utf8');

    expect(source).toContain('getWalletsRoute');
    expect(source).toContain('setMarlinDefaultRoute');
    expect(source).toContain('marlinCowSignTypedDataRoute');
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
      expect(source).not.toContain(route);
    }
  });

  it('rejects wallet authority config paths in Marlin runtime', () => {
    const source = readFileSync(path.join(ROOT, 'src/config/routes/updateConfig.ts'), 'utf8');

    expect(source).toContain('isMarlinRuntimeProfile()');
    expect(source).toContain("'defaultwallet'");
    expect(source.indexOf('isMarlinRuntimeProfile()')).toBeLessThan(source.indexOf('updateConfig(fastify'));
  });

  it('requires Marlin profile and policy metadata for scoped default route', () => {
    const source = readFileSync(path.join(ROOT, 'src/wallet/routes/setMarlinDefault.ts'), 'utf8');

    expect(source).toContain('isMarlinRuntimeProfile()');
    expect(source).toContain('walletRef does not match Marlin policy');
    expect(source).toContain('deriveMarlinDefaultWalletMaterial(normalizedMnemonicFromEnv(), policy)');
    expect(source).toContain('writeMarlinDefaultWalletMetadata(reconciled.storageChain');
    expect(source).not.toContain('if (await fse.pathExists(path))');
  });

  it('derives Marlin wallet material from the canonical mnemonic policies', () => {
    const evm = deriveMarlinDefaultWalletMaterial(TEST_MNEMONIC, {
      derivationPath: "m/44'/60'/0'/0/0",
      family: 'evm',
      storageChain: 'ethereum',
      walletRef: 'base:mainnet:evm_gateway',
    });
    const solana = deriveMarlinDefaultWalletMaterial(TEST_MNEMONIC, {
      derivationPath: "m/44'/501'/0'/0'",
      family: 'solana',
      storageChain: 'solana',
      walletRef: 'solana:mainnet-beta:solana_gateway',
    });

    expect(evm.address).toBe('0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
    expect(evm.storageChain).toBe('ethereum');
    expect(evm.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(solana.address).toBe('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk');
    expect(solana.storageChain).toBe('solana');
    expect(solana.privateKey.length).toBeGreaterThan(80);
  });

  it('normalizes quoted mnemonic env values before Base and Solana derivation', () => {
    const basePolicy = marlinWalletPolicyFor('base', 'mainnet')!;
    const solanaPolicy = marlinWalletPolicyFor('solana', 'mainnet-beta')!;
    const addressesFor = (envValue: string) => {
      process.env[MARLIN_MNEMONIC_ENV] = envValue;
      const mnemonic = normalizedMnemonicFromEnv();
      return [
        deriveMarlinDefaultWalletMaterial(mnemonic, basePolicy).address,
        deriveMarlinDefaultWalletMaterial(mnemonic, solanaPolicy).address,
      ];
    };

    const unquoted = addressesFor(TEST_MNEMONIC);
    expect(addressesFor(`"${TEST_MNEMONIC}"`)).toEqual(unquoted);
    expect(addressesFor(`'${TEST_MNEMONIC}'`)).toEqual(unquoted);
  });

  it('still rejects empty and invalid mnemonic env values', () => {
    process.env[MARLIN_MNEMONIC_ENV] = '  ';
    expect(() => normalizedMnemonicFromEnv()).toThrow('MARLIN_MNEMONIC is required');

    process.env[MARLIN_MNEMONIC_ENV] = '"not a valid mnemonic"';
    expect(() =>
      deriveMarlinDefaultWalletMaterial(normalizedMnemonicFromEnv(), marlinWalletPolicyFor('base', 'mainnet')!),
    ).toThrow();
  });

  it('exposes scoped Marlin default metadata in public wallet listing', () => {
    const source = readFileSync(path.join(ROOT, 'src/wallet/utils.ts'), 'utf8');

    expect(source).toContain('readMarlinDefaultWalletMetadata(safeChain)');
    expect(source).toContain('default_address: marlinDefault?.address');
    expect(source).toContain('walletRef: marlinDefault?.walletRef');
  });

  it('does not register wallet admin routes', async () => {
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

    process.env[MARLIN_RUNTIME_PROFILE_ENV] = 'marlin';
    process.env[MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN_ENV] = 'gateway-token';
    const scopedCowSigner = await app.inject({
      method: 'POST',
      url: '/wallet/marlin-cow/sign-typed-data',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      payload: {
        chain: 'ethereum',
        network: 'base',
        address: '0x0000000000000000000000000000000000000123',
        walletRef: 'operator-wallet',
        domain: {
          chainId: 8453,
          verifyingContract: '0x9008d19f58aabd9ed0d60971565aa8510560ab41',
        },
        types: {
          Order: [{ name: 'sellToken', type: 'address' }],
        },
        value: { sellToken: '0x4200000000000000000000000000000000000006' },
        liveActionAuthorization: {
          action: 'cowswap_sign_typed_data',
          connector_id: 'cowswap',
          network: 'base',
          payload_hash: '77b6ab11dcd3b978588d9f82727f7adbcf60ff4efc05d6d48ecd301baa4e060a',
          scope: 'provider_intent',
          signing_type: 'Order',
          source: 'marlin',
          wallet_address: '0x0000000000000000000000000000000000000123',
        },
      },
    });
    expect(scopedCowSigner.statusCode).toBe(400);

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

    process.env[MARLIN_MNEMONIC_ENV] = TEST_MNEMONIC;
    response = await app.inject({
      method: 'POST',
      url: '/wallet/marlin-default',
      payload: {
        chain: 'ethereum',
        network: 'base',
        address: '0x0000000000000000000000000000000000000123',
        walletRef: 'base:mainnet:evm_gateway',
      },
    });
    expect(response.statusCode).toBe(403);

    response = await app.inject({
      method: 'POST',
      url: '/wallet/marlin-default',
      payload: {
        chain: 'base',
        network: 'mainnet',
        address: '0x0000000000000000000000000000000000000123',
        walletRef: 'base:mainnet:evm_gateway',
      },
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it('materializes the derived wallet and binds the complete CoW payload', async () => {
    const originalCwd = process.cwd();
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'marlin-wallet-'));
    const originalPassphrase = process.env.GATEWAY_PASSPHRASE;
    process.chdir(tempRoot);
    process.env[MARLIN_RUNTIME_PROFILE_ENV] = 'marlin';
    process.env[MARLIN_MNEMONIC_ENV] = TEST_MNEMONIC;
    process.env[MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN_ENV] = 'gateway-token';
    process.env.GATEWAY_PASSPHRASE = 'test-wallet-key';

    const app = Fastify();
    try {
      await app.register(walletRoutes, { prefix: '/wallet' });
      await app.ready();
      const address = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
      const walletRef = 'base:mainnet:evm_gateway';
      const reconciled = await app.inject({
        method: 'POST',
        url: '/wallet/marlin-default',
        payload: { chain: 'base', network: 'mainnet', address, walletRef },
      });
      expect(reconciled.statusCode).toBe(200);
      expect(readFileSync(path.join(tempRoot, 'conf/wallets/ethereum/marlin-default.json'), 'utf8')).toContain(
        walletRef,
      );

      const publicList = await app.inject({ method: 'GET', url: '/wallet/?showHardware=false' });
      expect(publicList.statusCode).toBe(200);
      expect(publicList.payload).toContain(address);

      const payload = {
        chain: 'ethereum',
        network: 'base',
        address,
        walletRef,
        domain: {
          chainId: 8453,
          verifyingContract: '0x9008d19f58aabd9ed0d60971565aa8510560ab41',
        },
        types: { Order: [{ name: 'sellToken', type: 'address' }] },
        value: { sellToken: '0x4200000000000000000000000000000000000006' },
        liveActionAuthorization: {
          action: 'cowswap_sign_typed_data',
          connector_id: 'cowswap',
          network: 'base',
          payload_hash: '0fd18604d5c222af5d6a536878245a4e5de19a168dd8c2cd4e1c1418d28ab591',
          scope: 'provider_intent',
          signing_type: 'Order',
          source: 'marlin',
          wallet_address: address,
        },
      };
      const headers = { 'x-marlin-gateway-provider-intent-token': 'gateway-token' };
      const signed = await app.inject({
        method: 'POST',
        url: '/wallet/marlin-cow/sign-typed-data',
        headers,
        payload,
      });
      expect(signed.statusCode).toBe(200);

      for (const mutation of [
        { domain: { ...payload.domain, name: 'tampered' } },
        { types: { Order: [{ name: 'buyToken', type: 'address' }] } },
        { value: { sellToken: '0x0000000000000000000000000000000000000001' } },
      ]) {
        const rejected = await app.inject({
          method: 'POST',
          url: '/wallet/marlin-cow/sign-typed-data',
          headers,
          payload: { ...payload, ...mutation },
        });
        expect(rejected.statusCode).toBe(403);
      }
    } finally {
      await app.close();
      process.chdir(originalCwd);
      rmSync(tempRoot, { recursive: true, force: true });
      if (originalPassphrase === undefined) {
        delete process.env.GATEWAY_PASSPHRASE;
      } else {
        process.env.GATEWAY_PASSPHRASE = originalPassphrase;
      }
    }
  });
});
