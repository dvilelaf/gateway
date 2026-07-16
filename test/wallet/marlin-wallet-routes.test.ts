import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { BigNumber, constants, Wallet } from 'ethers';
import Fastify from 'fastify';

import { Ethereum } from '../../src/chains/ethereum/ethereum';
import { ConfigManagerV2 } from '../../src/services/config-manager-v2';
import { MARLIN_RUNTIME_PROFILE_ENV, isMarlinRuntimeProfile } from '../../src/services/marlin-runtime';
import * as marlinDefaultWalletRoutes from '../../src/wallet/routes/setMarlinDefault';
import walletRoutes from '../../src/wallet/wallet.routes';

jest.mock('../../src/services/logger', () => ({
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
  redactUrl: (url: string) => url,
}));

const ROOT = path.resolve(__dirname, '../..');
const MARLIN_MNEMONIC_ENV = 'MARLIN_MNEMONIC';
const MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN_ENV = 'MARLIN_GATEWAY_PROVIDER_INTENT_TOKEN';
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const COW_WALLET_ADDRESS = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const COW_TOKEN_ADDRESS = '0x0000000000000000000000000000000000000001';
const COW_OTHER_TOKEN_ADDRESS = '0x0000000000000000000000000000000000000002';
const COW_VAULT_RELAYER = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110';
const COW_AMOUNT_ATOMIC = '1000000';
const COW_TX_HASH = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ZERO_TX_HASH = `0x${'0'.repeat(64)}`;
const { deriveMarlinDefaultWalletMaterial, marlinWalletPolicyFor, normalizedMnemonicFromEnv } =
  marlinDefaultWalletRoutes;

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

  it('registers only public listing, scoped default, and Marlin CoW wallet routes', () => {
    const source = readFileSync(path.join(ROOT, 'src/wallet/wallet.routes.ts'), 'utf8');

    expect(source).toContain('getWalletsRoute');
    expect(source).toContain('setMarlinDefaultRoute');
    expect(source).toContain('marlinCowSignTypedDataRoute');
    expect(source).toContain('marlinCowApproveRoute');
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

    const scopedCowApprover = await app.inject({
      method: 'POST',
      url: '/wallet/marlin-cow/approve',
      headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
      payload: marlinCowApprovalPayload(),
    });
    expect(scopedCowApprover.statusCode).toBe(400);

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
    const getInstance = jest.spyOn(Ethereum, 'getInstance').mockResolvedValue({
      chainId: 8453,
      getWallet: jest.fn().mockResolvedValue(Wallet.fromMnemonic(TEST_MNEMONIC, "m/44'/60'/0'/0/0")),
    } as unknown as Ethereum);
    const configManager = jest.spyOn(ConfigManagerV2, 'getInstance').mockReturnValue({
      set: jest.fn(),
    } as unknown as ConfigManagerV2);
    try {
      await app.register(walletRoutes, { prefix: '/wallet' });
      await app.ready();
      const address = COW_WALLET_ADDRESS;
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
      configManager.mockRestore();
      getInstance.mockRestore();
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

  it('rejects CoW approval requests with mismatched scope, wallet, token, spender, amount, or runtime auth', async () => {
    await withMarlinWalletTestApp(async (app) => {
      const basePayload = marlinCowApprovalPayload();
      const baseAuthorization = basePayload.liveActionAuthorization as Record<string, unknown>;
      const ensureWallet = jest
        .spyOn(marlinDefaultWalletRoutes, 'ensureMarlinWalletExists')
        .mockImplementation(async ({ address }) => {
          if (address !== COW_WALLET_ADDRESS) {
            throw new Error('wallet address does not match MARLIN_MNEMONIC-derived policy address');
          }
          return { storageChain: 'ethereum', validatedAddress: COW_WALLET_ADDRESS };
        });
      const getInstance = jest.spyOn(Ethereum, 'getInstance').mockResolvedValue({} as Ethereum);
      try {
        const rejectedCases = [
          { name: 'chain', payload: { ...basePayload, chain: 'solana' } },
          { name: 'network', payload: { ...basePayload, network: 'mainnet' } },
          { name: 'walletRef', payload: { ...basePayload, walletRef: 'operator-wallet' } },
          { name: 'wallet', payload: { ...basePayload, address: '0x0000000000000000000000000000000000000123' } },
          { name: 'token', payload: { ...basePayload, tokenAddress: COW_OTHER_TOKEN_ADDRESS } },
          {
            name: 'spender',
            payload: { ...basePayload, spender: '0x0000000000000000000000000000000000000003' },
          },
          { name: 'amount', payload: { ...basePayload, amountAtomic: '1000001' } },
          {
            name: 'authorization',
            payload: {
              ...basePayload,
              liveActionAuthorization: {
                ...baseAuthorization,
                action: 'gateway_swap',
              },
            },
          },
          {
            name: 'authorization wallet',
            payload: {
              ...basePayload,
              liveActionAuthorization: {
                ...baseAuthorization,
                wallet_address: '0x0000000000000000000000000000000000000004',
              },
            },
          },
          {
            name: 'authorization token',
            payload: {
              ...basePayload,
              liveActionAuthorization: { ...baseAuthorization, token_address: COW_OTHER_TOKEN_ADDRESS },
            },
          },
          {
            name: 'authorization spender',
            payload: {
              ...basePayload,
              liveActionAuthorization: {
                ...baseAuthorization,
                spender_address: '0x0000000000000000000000000000000000000005',
              },
            },
          },
          {
            name: 'authorization amount',
            payload: {
              ...basePayload,
              liveActionAuthorization: { ...baseAuthorization, amount_atomic: '1000001' },
            },
          },
          { name: 'zero amount', payload: { ...basePayload, amountAtomic: '0' } },
          {
            name: 'amount above uint256',
            payload: { ...basePayload, amountAtomic: constants.MaxUint256.add(1).toString() },
          },
        ];

        for (const rejectedCase of rejectedCases) {
          const response = await app.inject({
            method: 'POST',
            url: '/wallet/marlin-cow/approve',
            headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
            payload: rejectedCase.payload,
          });
          expect(response.statusCode).toBeGreaterThanOrEqual(400);
          expect(response.statusCode).toBeLessThan(500);
        }

        const wrongProviderToken = await app.inject({
          method: 'POST',
          url: '/wallet/marlin-cow/approve',
          headers: { 'x-marlin-gateway-provider-intent-token': 'wrong-token' },
          payload: basePayload,
        });
        expect(wrongProviderToken.statusCode).toBe(403);

        const missingHeader = await app.inject({
          method: 'POST',
          url: '/wallet/marlin-cow/approve',
          payload: basePayload,
        });
        expect(missingHeader.statusCode).toBe(403);

        process.env[MARLIN_RUNTIME_PROFILE_ENV] = 'paper';
        const wrongProfile = await app.inject({
          method: 'POST',
          url: '/wallet/marlin-cow/approve',
          headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
          payload: basePayload,
        });
        expect(wrongProfile.statusCode).toBe(403);
        expect(ensureWallet).not.toHaveBeenCalled();
      } finally {
        getInstance.mockRestore();
        ensureWallet.mockRestore();
      }
    });
  });

  it('approves the exact CoW amount once and returns the receipt fee and bound data', async () => {
    await withMarlinWalletTestApp(async (app) => {
      const wallet = { address: COW_WALLET_ADDRESS };
      const provider = { getNetwork: jest.fn().mockResolvedValue({ chainId: 8453 }) };
      const readContract = { allowance: jest.fn().mockResolvedValue(BigNumber.from('1')) };
      const signedContract = { allowance: jest.fn(), approve: jest.fn() };
      const transaction = { hash: COW_TX_HASH, nonce: 7 };
      const receipt = {
        transactionHash: COW_TX_HASH,
        status: 1,
        gasUsed: BigNumber.from(21000),
        effectiveGasPrice: BigNumber.from('1000000000'),
      };
      const ethereum = {
        chainId: 8453,
        provider,
        getContract: jest.fn((_tokenAddress: string, signerOrProvider?: unknown) =>
          signerOrProvider === provider || signerOrProvider === undefined ? readContract : signedContract,
        ),
        getWallet: jest.fn().mockResolvedValue(wallet),
        approveERC20: jest.fn().mockResolvedValue(transaction),
        handleTransactionExecution: jest.fn().mockResolvedValue(receipt),
      };
      const ensureWallet = jest.spyOn(marlinDefaultWalletRoutes, 'ensureMarlinWalletExists');
      const getInstance = jest.spyOn(Ethereum, 'getInstance').mockResolvedValue(ethereum as unknown as Ethereum);
      try {
        const payload = marlinCowApprovalPayload();
        const response = await app.inject({
          method: 'POST',
          url: '/wallet/marlin-cow/approve',
          headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
          payload,
        });

        expect(response.statusCode).toBe(200);
        expect(getInstance).toHaveBeenCalledWith('base');
        expect(response.json()).toEqual({
          signature: COW_TX_HASH,
          status: 1,
          data: {
            tokenAddress: COW_TOKEN_ADDRESS,
            spender: COW_VAULT_RELAYER,
            amountAtomic: COW_AMOUNT_ATOMIC,
            nonce: 7,
            fee: '0.000021',
          },
        });
        expect(readContract.allowance).toHaveBeenCalledWith(COW_WALLET_ADDRESS, COW_VAULT_RELAYER);
        expect(provider.getNetwork).toHaveBeenCalledTimes(1);
        expect(ensureWallet).toHaveBeenCalledTimes(1);
        expect(ensureWallet).toHaveBeenCalledWith({
          address: COW_WALLET_ADDRESS,
          chain: 'ethereum',
          network: 'base',
          walletRef: 'base:mainnet:evm_gateway',
        });
        expect(ethereum.getWallet).toHaveBeenCalledWith(COW_WALLET_ADDRESS);
        expect(ensureWallet.mock.invocationCallOrder[0]).toBeLessThan(ethereum.getWallet.mock.invocationCallOrder[0]);
        expect(ethereum.getContract).toHaveBeenNthCalledWith(1, COW_TOKEN_ADDRESS, provider);
        expect(ethereum.getContract).toHaveBeenNthCalledWith(2, COW_TOKEN_ADDRESS, wallet);
        expect(ethereum.approveERC20).toHaveBeenCalledTimes(1);
        const approveCall = ethereum.approveERC20.mock.calls[0];
        expect(approveCall[0]).toBe(signedContract);
        expect(approveCall[1]).toBe(wallet);
        expect(approveCall[2]).toBe(COW_VAULT_RELAYER);
        expect(approveCall[3].toString()).toBe(COW_AMOUNT_ATOMIC);
        expect(approveCall[4]).toEqual(payload.liveActionAuthorization);
        expect(approveCall[5]).toBe('cowswap_approve');
        expect(approveCall[6]).toEqual({
          expectedAmountAtomic: COW_AMOUNT_ATOMIC,
          expectedConnectorId: 'cowswap',
          expectedSpenderAddress: COW_VAULT_RELAYER,
          expectedTokenAddress: COW_TOKEN_ADDRESS,
          expectedWalletAddress: COW_WALLET_ADDRESS,
        });
        expect(ethereum.handleTransactionExecution).toHaveBeenCalledWith(transaction);
      } finally {
        getInstance.mockRestore();
        ensureWallet.mockRestore();
      }
    });
  });

  it.each([
    ['Ethereum instance chain', 1, 8453],
    ['provider network', 8453, 1],
  ])('fails closed for a non-Base chain identity (%s)', async (_name, ethereumChainId, providerChainId) => {
    await withMarlinWalletTestApp(async (app) => {
      const provider = { getNetwork: jest.fn().mockResolvedValue({ chainId: providerChainId }) };
      const readContract = { allowance: jest.fn().mockResolvedValue(BigNumber.from('1')) };
      const ethereum = {
        chainId: ethereumChainId,
        provider,
        getContract: jest.fn().mockReturnValue(readContract),
        getWallet: jest.fn(),
        approveERC20: jest.fn(),
      };
      const getInstance = jest.spyOn(Ethereum, 'getInstance').mockResolvedValue(ethereum as unknown as Ethereum);
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/wallet/marlin-cow/approve',
          headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
          payload: marlinCowApprovalPayload(),
        });

        expect(response.statusCode).toBe(500);
        expect(getInstance).toHaveBeenCalledWith('base');
        expect(provider.getNetwork).toHaveBeenCalledTimes(1);
        expect(readContract.allowance).not.toHaveBeenCalled();
        expect(ethereum.getWallet).not.toHaveBeenCalled();
        expect(ethereum.approveERC20).not.toHaveBeenCalled();
      } finally {
        getInstance.mockRestore();
      }
    });
  });

  it.each([
    ['missing receipt', null],
    ['unsuccessful receipt', { status: 0 }],
  ])('fails when the CoW approval receipt is %s without resubmitting', async (_name, receipt) => {
    await withMarlinWalletTestApp(async (app) => {
      const wallet = { address: COW_WALLET_ADDRESS };
      const provider = { getNetwork: jest.fn().mockResolvedValue({ chainId: 8453 }) };
      const readContract = { allowance: jest.fn().mockResolvedValue(BigNumber.from('1')) };
      const transaction = { hash: COW_TX_HASH, nonce: 7 };
      const ethereum = {
        chainId: 8453,
        provider,
        getContract: jest.fn().mockReturnValue(readContract),
        getWallet: jest.fn().mockResolvedValue(wallet),
        approveERC20: jest.fn().mockResolvedValue(transaction),
        handleTransactionExecution: jest.fn().mockResolvedValue(receipt),
      };
      const getInstance = jest.spyOn(Ethereum, 'getInstance').mockResolvedValue(ethereum as unknown as Ethereum);
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/wallet/marlin-cow/approve',
          headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
          payload: marlinCowApprovalPayload(),
        });

        expect(response.statusCode).toBe(500);
        expect(ethereum.approveERC20).toHaveBeenCalledTimes(1);
        expect(ethereum.handleTransactionExecution).toHaveBeenCalledTimes(1);
      } finally {
        getInstance.mockRestore();
      }
    });
  });

  it('returns terminal success without mutation when the CoW allowance is already sufficient', async () => {
    await withMarlinWalletTestApp(async (app) => {
      const provider = { getNetwork: jest.fn().mockResolvedValue({ chainId: 8453 }) };
      const readContract = { allowance: jest.fn().mockResolvedValue(BigNumber.from(COW_AMOUNT_ATOMIC)) };
      const ethereum = {
        chainId: 8453,
        provider,
        getContract: jest.fn().mockReturnValue(readContract),
        getWallet: jest.fn(),
        approveERC20: jest.fn(),
        handleTransactionExecution: jest.fn(),
      };
      const ensureWallet = jest.spyOn(marlinDefaultWalletRoutes, 'ensureMarlinWalletExists');
      const getInstance = jest.spyOn(Ethereum, 'getInstance').mockResolvedValue(ethereum as unknown as Ethereum);
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/wallet/marlin-cow/approve',
          headers: { 'x-marlin-gateway-provider-intent-token': 'gateway-token' },
          payload: marlinCowApprovalPayload(),
        });

        expect(response.statusCode).toBe(200);
        expect(provider.getNetwork).toHaveBeenCalledTimes(1);
        expect(ensureWallet).not.toHaveBeenCalled();
        expect(response.json()).toEqual({
          signature: ZERO_TX_HASH,
          status: 1,
          data: {
            tokenAddress: COW_TOKEN_ADDRESS,
            spender: COW_VAULT_RELAYER,
            amountAtomic: COW_AMOUNT_ATOMIC,
            nonce: 0,
            fee: '0',
          },
        });
        expect(ethereum.getWallet).not.toHaveBeenCalled();
        expect(ethereum.approveERC20).not.toHaveBeenCalled();
        expect(ethereum.handleTransactionExecution).not.toHaveBeenCalled();
      } finally {
        getInstance.mockRestore();
        ensureWallet.mockRestore();
      }
    });
  });
});

function marlinCowApprovalPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    chain: 'ethereum',
    network: 'base',
    address: COW_WALLET_ADDRESS,
    walletRef: 'base:mainnet:evm_gateway',
    tokenAddress: COW_TOKEN_ADDRESS,
    spender: COW_VAULT_RELAYER,
    amountAtomic: COW_AMOUNT_ATOMIC,
    liveActionAuthorization: {
      action: 'cowswap_approve',
      connector_id: 'cowswap',
      network: 'base',
      scope: 'provider_intent',
      source: 'marlin',
      wallet_address: COW_WALLET_ADDRESS,
      token_address: COW_TOKEN_ADDRESS,
      spender_address: COW_VAULT_RELAYER,
      amount_atomic: COW_AMOUNT_ATOMIC,
    },
    ...overrides,
  };
}

async function withMarlinWalletTestApp(callback: (app: any) => Promise<void>): Promise<void> {
  const originalCwd = process.cwd();
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'marlin-cow-approval-'));
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
    await callback(app);
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
}
