import { PublicKey, Connection } from '@solana/web3.js';

jest.mock('../../../src/services/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
  redactUrl: jest.fn((url: string) => url),
}));

jest.mock('../../../src/services/config-manager-v2', () => ({
  ConfigManagerV2: {
    getInstance: jest.fn(() => ({
      get: jest.fn((key: string) => {
        if (key === 'solana.defaultNetwork') return 'mainnet-beta';
        if (key === 'solana.defaultWallet') return 'test-wallet';
        if (key === 'solana.rpcProvider') return 'url';
        if (key === 'solana-mainnet-beta.nodeURL') return 'https://api.mainnet-beta.solana.com';
        if (key === 'solana-mainnet-beta.nativeCurrencySymbol') return 'SOL';
        if (key === 'solana-mainnet-beta.defaultComputeUnits') return 200000;
        if (key === 'solana-mainnet-beta.confirmRetryInterval') return 2;
        if (key === 'solana-mainnet-beta.confirmRetryCount') return 30;
        if (key === 'solana-mainnet-beta.minPriorityFeePerCU') return 0;
        return undefined;
      }),
    })),
  },
}));

jest.mock('../../../src/services/runtime-guard', () => ({
  assertMainnetMutationAllowed: jest.fn(),
  marlinGatewayProviderIntentTokenMatches: jest.fn(),
  marlinProviderIntentAuthorizationMatches: jest.fn(),
  LiveActionAuthorizationLevel: { OPERATOR: 'operator' },
}));

import { Solana } from '../../../src/chains/solana/solana';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const POOL_OWNER = '7WmMqNBcuSgsWjk2pEqz1qfwk88tzbT5e6fX1TnFPHtq';

function buildOwnerPubkey(): PublicKey {
  return new PublicKey(POOL_OWNER);
}

function buildMockTxResponse(overrides: {
  preBalances?: number[];
  postBalances?: number[];
  preTokenBalances?: any[];
  postTokenBalances?: any[];
  fee?: number;
  blockTime?: number;
}): any {
  const ownerPubkey = buildOwnerPubkey();
  return {
    meta: {
      fee: overrides.fee ?? 5000,
      preBalances: overrides.preBalances ?? [100_000_000_000, 0],
      postBalances: overrides.postBalances ?? [99_999_995_000, 0],
      preTokenBalances: overrides.preTokenBalances ?? [],
      postTokenBalances: overrides.postTokenBalances ?? [],
      err: null,
    },
    blockTime: overrides.blockTime ?? 1720800000,
    transaction: {
      message: {
        accountKeys: [{ pubkey: ownerPubkey }, { pubkey: new PublicKey('11111111111111111111111111111111') }],
      },
    },
  };
}

describe('extractBalanceChangesAndFee', () => {
  let solana: Solana;

  beforeEach(async () => {
    (Solana as any)._instances = {};
    solana = await Solana.getInstance('mainnet-beta');
    (solana as any).rpcProviderService = undefined;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('SPL deltas with BigInt raw amounts (strict mode)', () => {
    it('computes exact raw deltas for large pool vault: WSOL -655 at 9 decimals, USDC +50 at 6 decimals', async () => {
      const ownerPubkey = buildOwnerPubkey();
      const ownerStr = ownerPubkey.toBase58();
      const decoyOwner = '11111111111111111111111111111111';

      const preTokenBalances = [
        {
          accountIndex: 1,
          mint: WSOL_MINT,
          owner: decoyOwner,
          uiTokenAmount: { amount: '1000', decimals: 9, uiAmount: 0.000001, uiAmountString: '0.000001' },
        },
        {
          accountIndex: 0,
          mint: WSOL_MINT,
          owner: ownerStr,
          uiTokenAmount: {
            amount: '9876543210000',
            decimals: 9,
            uiAmount: 9876.54321,
            uiAmountString: '9876.54321',
          },
        },
        {
          accountIndex: 0,
          mint: USDC_MINT,
          owner: ownerStr,
          uiTokenAmount: {
            amount: '500000000000',
            decimals: 6,
            uiAmount: 500000.0,
            uiAmountString: '500000.0',
          },
        },
      ];

      const postTokenBalances = [
        {
          accountIndex: 1,
          mint: WSOL_MINT,
          owner: decoyOwner,
          uiTokenAmount: { amount: '9000', decimals: 9, uiAmount: 0.000009, uiAmountString: '0.000009' },
        },
        {
          accountIndex: 0,
          mint: WSOL_MINT,
          owner: ownerStr,
          uiTokenAmount: {
            amount: '9876543209345',
            decimals: 9,
            uiAmount: 9876.543209345,
            uiAmountString: '9876.543209345',
          },
        },
        {
          accountIndex: 0,
          mint: USDC_MINT,
          owner: ownerStr,
          uiTokenAmount: {
            amount: '500000000050',
            decimals: 6,
            uiAmount: 500000.00005,
            uiAmountString: '500000.00005',
          },
        },
      ];

      jest.spyOn(solana as any, '_fetchTransactionWithRetry').mockResolvedValue(
        buildMockTxResponse({
          preTokenBalances,
          postTokenBalances,
        }),
      );

      const result = await solana.extractBalanceChangesAndFee('test-sig', ownerStr, [WSOL_MINT, USDC_MINT], {
        nativeMintAsSpl: true,
        strictTokenBalances: true,
      });

      expect(result.balanceChanges).toHaveLength(2);

      // WSOL delta: -655 raw at 9 decimals = -655 / 10^9 = -0.000000655
      expect(result.balanceChanges[0]).toBe(-0.000000655);

      // USDC delta: +50 raw at 6 decimals = 50 / 10^6 = 0.00005
      expect(result.balanceChanges[1]).toBe(0.00005);

      // Prove this is NOT what floating uiAmount would produce (cancellation error):
      const floatingDeltaWSOL =
        (postTokenBalances[0].uiTokenAmount.uiAmount ?? 0) - (preTokenBalances[0].uiTokenAmount.uiAmount ?? 0);
      expect(floatingDeltaWSOL).not.toBe(-0.000000655);

      expect(result.executedAt).toBe('2024-07-12T16:00:00.000Z');
    });

    it('validates decimals match between pre and post records', async () => {
      const ownerPubkey = buildOwnerPubkey();
      const ownerStr = ownerPubkey.toBase58();

      jest.spyOn(solana as any, '_fetchTransactionWithRetry').mockResolvedValue(
        buildMockTxResponse({
          preTokenBalances: [
            {
              accountIndex: 0,
              mint: WSOL_MINT,
              owner: ownerStr,
              uiTokenAmount: { amount: '1000', decimals: 9, uiAmount: 0.000001, uiAmountString: '0.000001' },
            },
          ],
          postTokenBalances: [
            {
              accountIndex: 0,
              mint: WSOL_MINT,
              owner: ownerStr,
              uiTokenAmount: { amount: '500', decimals: 6, uiAmount: 0.0005, uiAmountString: '0.0005' },
            },
          ],
        }),
      );

      await expect(
        solana.extractBalanceChangesAndFee('test-sig', ownerStr, [WSOL_MINT], {
          nativeMintAsSpl: true,
          strictTokenBalances: true,
        }),
      ).rejects.toThrow(/decimals mismatch/);
    });
  });

  describe('nativeMintAsSpl default (false) — lamports behavior', () => {
    it('uses lamport balance for NATIVE_MINT when nativeMintAsSpl is not set', async () => {
      const ownerPubkey = buildOwnerPubkey();
      const ownerStr = ownerPubkey.toBase58();

      jest.spyOn(solana as any, '_fetchTransactionWithRetry').mockResolvedValue(
        buildMockTxResponse({
          preBalances: [200_000_000_000, 0],
          postBalances: [199_999_995_000, 0],
          preTokenBalances: [],
          postTokenBalances: [],
        }),
      );

      const result = await solana.extractBalanceChangesAndFee('test-sig', ownerStr, [WSOL_MINT]);

      // Lamport change: 199_999_995_000 - 200_000_000_000 = -5000 lamports
      // In SOL: -5000 * 10^-9 = -0.000005
      expect(result.balanceChanges[0]).toBe(-0.000005);
    });

    it('uses lamport balance for NATIVE_MINT when nativeMintAsSpl is explicitly false', async () => {
      const ownerPubkey = buildOwnerPubkey();
      const ownerStr = ownerPubkey.toBase58();

      jest.spyOn(solana as any, '_fetchTransactionWithRetry').mockResolvedValue(
        buildMockTxResponse({
          preBalances: [100_000_000_000, 0],
          postBalances: [99_999_995_000, 0],
          preTokenBalances: [],
          postTokenBalances: [],
        }),
      );

      const result = await solana.extractBalanceChangesAndFee('test-sig', ownerStr, [WSOL_MINT], {
        nativeMintAsSpl: false,
      });

      expect(result.balanceChanges[0]).toBe(-0.000005);
    });
  });

  describe('strictTokenBalances missing records', () => {
    it('throws when pre record is missing in strict mode', async () => {
      const ownerPubkey = buildOwnerPubkey();
      const ownerStr = ownerPubkey.toBase58();

      jest.spyOn(solana as any, '_fetchTransactionWithRetry').mockResolvedValue(
        buildMockTxResponse({
          preTokenBalances: [],
          postTokenBalances: [
            {
              accountIndex: 0,
              mint: WSOL_MINT,
              owner: ownerStr,
              uiTokenAmount: { amount: '500', decimals: 9, uiAmount: 0.0000005, uiAmountString: '0.0000005' },
            },
          ],
        }),
      );

      await expect(
        solana.extractBalanceChangesAndFee('test-sig', ownerStr, [WSOL_MINT], {
          nativeMintAsSpl: true,
          strictTokenBalances: true,
        }),
      ).rejects.toThrow(/missing pre\/post record/);
    });

    it('throws when post record is missing in strict mode', async () => {
      const ownerPubkey = buildOwnerPubkey();
      const ownerStr = ownerPubkey.toBase58();

      jest.spyOn(solana as any, '_fetchTransactionWithRetry').mockResolvedValue(
        buildMockTxResponse({
          preTokenBalances: [
            {
              accountIndex: 0,
              mint: WSOL_MINT,
              owner: ownerStr,
              uiTokenAmount: { amount: '1000', decimals: 9, uiAmount: 0.000001, uiAmountString: '0.000001' },
            },
          ],
          postTokenBalances: [],
        }),
      );

      await expect(
        solana.extractBalanceChangesAndFee('test-sig', ownerStr, [WSOL_MINT], {
          nativeMintAsSpl: true,
          strictTokenBalances: true,
        }),
      ).rejects.toThrow(/missing pre\/post record/);
    });
  });

  describe('default strictTokenBalances (false) — old missing-as-zero behavior', () => {
    it('preserves uiAmount subtraction for existing SPL balances', async () => {
      const ownerStr = buildOwnerPubkey().toBase58();
      const preTokenBalances = [
        {
          accountIndex: 0,
          mint: USDC_MINT,
          owner: ownerStr,
          uiTokenAmount: { amount: '1500000', decimals: 6, uiAmount: 1.5, uiAmountString: '1.5' },
        },
      ];
      const postTokenBalances = [
        {
          accountIndex: 0,
          mint: USDC_MINT,
          owner: ownerStr,
          uiTokenAmount: { amount: '1750000', decimals: 6, uiAmount: 1.75, uiAmountString: '1.75' },
        },
      ];

      jest
        .spyOn(solana as any, '_fetchTransactionWithRetry')
        .mockResolvedValue(buildMockTxResponse({ preTokenBalances, postTokenBalances }));

      const result = await solana.extractBalanceChangesAndFee('test-sig', ownerStr, [USDC_MINT]);

      expect(result.balanceChanges).toEqual([0.25]);
    });

    it('returns zero delta when pre/post records are missing (legacy behavior)', async () => {
      const ownerPubkey = buildOwnerPubkey();
      const ownerStr = ownerPubkey.toBase58();

      jest.spyOn(solana as any, '_fetchTransactionWithRetry').mockResolvedValue(
        buildMockTxResponse({
          preTokenBalances: [],
          postTokenBalances: [],
        }),
      );

      const result = await solana.extractBalanceChangesAndFee('test-sig', ownerStr, [WSOL_MINT, USDC_MINT], {
        nativeMintAsSpl: true,
      });

      expect(result.balanceChanges).toEqual([0, 0]);
    });

    it('returns non-strict delta when strictTokenBalances is explicitly false', async () => {
      const ownerPubkey = buildOwnerPubkey();
      const ownerStr = ownerPubkey.toBase58();

      jest.spyOn(solana as any, '_fetchTransactionWithRetry').mockResolvedValue(
        buildMockTxResponse({
          preTokenBalances: [],
          postTokenBalances: [],
        }),
      );

      const result = await solana.extractBalanceChangesAndFee('test-sig', ownerStr, [WSOL_MINT], {
        nativeMintAsSpl: true,
        strictTokenBalances: false,
      });

      expect(result.balanceChanges).toEqual([0]);
    });
  });

  describe('fee result', () => {
    it('returns the transaction fee from meta', async () => {
      const ownerPubkey = buildOwnerPubkey();
      const ownerStr = ownerPubkey.toBase58();

      jest.spyOn(solana as any, '_fetchTransactionWithRetry').mockResolvedValue(
        buildMockTxResponse({
          fee: 10000,
          preBalances: [100_000_000_000, 0],
          postBalances: [99_999_990_000, 0],
        }),
      );

      const result = await solana.extractBalanceChangesAndFee('test-sig', ownerStr, [WSOL_MINT]);

      // 10000 lamports = 0.00001 SOL
      expect(result.fee).toBe(0.00001);
    });
  });
});
