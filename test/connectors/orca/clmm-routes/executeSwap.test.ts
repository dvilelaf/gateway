import { Keypair } from '@solana/web3.js';

import { Solana } from '../../../../src/chains/solana/solana';
import { Orca } from '../../../../src/connectors/orca/orca';
import { PoolService } from '../../../../src/services/pool-service';
import { MOCK_SOL_TOKEN, MOCK_USDC_TOKEN } from '../../../mocks/orca/orca-data.mock';
import { fastifyWithTypeProvider } from '../../../utils/testUtils';

jest.mock('../../../../src/chains/solana/solana');
jest.mock('../../../../src/connectors/orca/orca');
jest.mock('../../../../src/services/pool-service');
jest.mock('@orca-so/whirlpools-sdk', () => ({
  buildWhirlpoolClient: jest.fn(),
  swapQuoteByInputToken: jest.fn(),
  swapQuoteByOutputToken: jest.fn(),
  ORCA_WHIRLPOOL_PROGRAM_ID: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  PDAUtil: {
    getOracle: jest.fn().mockReturnValue({ publicKey: 'oracle-pubkey' }),
  },
  WhirlpoolIx: {
    swapV2Ix: jest.fn().mockReturnValue({
      instructions: [],
      cleanupInstructions: [],
      signers: [],
    }),
  },
  TokenExtensionUtil: {
    getExtraAccountMetasForTransferHook: jest.fn().mockResolvedValue([]),
  },
  IGNORE_CACHE: true,
}));
jest.mock('@orca-so/common-sdk', () => ({
  Percentage: {
    fromDecimal: jest.fn().mockReturnValue(1),
  },
  TransactionBuilder: jest.fn().mockImplementation(() => ({
    addInstruction: jest.fn(),
    build: jest.fn().mockResolvedValue({ transaction: {} }),
  })),
}));
jest.mock('../../../../src/connectors/orca/orca.utils', () => ({
  handleWsolAta: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@solana/spl-token', () => ({
  getAssociatedTokenAddressSync: jest.fn().mockReturnValue('mock-ata-address'),
  NATIVE_MINT: 'So11111111111111111111111111111111111111112',
  createAssociatedTokenAccountIdempotentInstruction: jest.fn(),
  createSyncNativeInstruction: jest.fn(),
}));

const buildApp = async () => {
  const server = fastifyWithTypeProvider();
  await server.register(require('@fastify/sensible'));
  const { executeSwapRoute } = await import('../../../../src/connectors/orca/clmm-routes/executeSwap');
  await server.register(executeSwapRoute);
  return server;
};

const mockPoolAddress = 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE';
const mockWalletAddress = 'BPgNwGDBiRuaAKuRQLpXC9rCiw5FfJDDdTunDEmtN6VF';
const mockWallet = Keypair.generate();

const mockBaseTokenInfo = {
  symbol: 'SOL',
  address: 'So11111111111111111111111111111111111111112',
  decimals: 9,
};

const mockQuoteTokenInfo = {
  symbol: 'USDC',
  address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  decimals: 6,
};

const mockWhirlpoolData = {
  tokenMintA: mockBaseTokenInfo.address,
  tokenMintB: mockQuoteTokenInfo.address,
  tokenVaultA: 'vaultA',
  tokenVaultB: 'vaultB',
};

const mockMintInfo = {
  decimals: 9,
  tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
};

// Shared helper: build a base mockSolana with overridable methods
const buildMockSolana = (overrides: Record<string, any> = {}) => ({
  getToken: jest.fn().mockImplementation((symbol: string) => {
    if (symbol === 'SOL' || symbol === mockBaseTokenInfo.address) return mockBaseTokenInfo;
    if (symbol === 'USDC' || symbol === mockQuoteTokenInfo.address) return mockQuoteTokenInfo;
    return null;
  }),
  getWallet: jest.fn().mockResolvedValue(mockWallet),
  simulateWithErrorHandling: jest.fn().mockResolvedValue(undefined),
  sendAndConfirmTransaction: jest.fn().mockResolvedValue({
    signature: 'test-signature',
  }),
  extractBalanceChangesAndFee: jest.fn().mockResolvedValue({
    balanceChanges: [1.0, -198.75],
    fee: 0.00001,
    executedAt: '2026-07-13T12:00:00.000Z',
  }),
  ...overrides,
});

// Shared Orca / whirlpool mock setup (called once in beforeAll)
const buildMockOrcaDeps = () => {
  const mockWhirlpool = {
    getData: jest.fn().mockReturnValue(mockWhirlpoolData),
    refreshData: jest.fn().mockResolvedValue(undefined),
    getTokenAInfo: jest.fn().mockReturnValue({ address: mockBaseTokenInfo.address }),
    getTokenBInfo: jest.fn().mockReturnValue({ address: mockQuoteTokenInfo.address }),
    getTokenVaultAInfo: jest.fn().mockReturnValue({ address: 'vaultA' }),
    getTokenVaultBInfo: jest.fn().mockReturnValue({ address: 'vaultB' }),
  };

  const mockFetcher = {
    getMintInfo: jest.fn().mockResolvedValue(mockMintInfo),
  };

  const mockClient = {
    getPool: jest.fn().mockResolvedValue(mockWhirlpool),
    getFetcher: jest.fn().mockReturnValue(mockFetcher),
    getContext: jest.fn().mockReturnValue({
      connection: {},
      wallet: { publicKey: mockWallet.publicKey },
      program: {},
    }),
  };

  const mockOrca = {
    getWhirlpoolClientForWallet: jest.fn().mockResolvedValue(mockClient),
  };

  return { mockWhirlpool, mockFetcher, mockClient, mockOrca };
};

describe('POST /execute-swap', () => {
  let app: any;

  beforeAll(async () => {
    app = await buildApp();

    const { mockOrca } = buildMockOrcaDeps();
    (Orca.getInstance as jest.Mock).mockResolvedValue(mockOrca);

    // Mock swap quote functions
    const { swapQuoteByInputToken, swapQuoteByOutputToken } = require('@orca-so/whirlpools-sdk');
    const mockQuote = {
      estimatedAmountIn: BigInt(1000000000),
      estimatedAmountOut: BigInt(200000000),
    };
    (swapQuoteByInputToken as jest.Mock).mockResolvedValue(mockQuote);
    (swapQuoteByOutputToken as jest.Mock).mockResolvedValue(mockQuote);
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('SELL direction (SOL -> USDC) using pool vault deltas', () => {
    const SELL_PAYLOAD = {
      baseToken: 'SOL',
      quoteToken: 'USDC',
      amount: 1.0,
      side: 'SELL',
      poolAddress: mockPoolAddress,
    };

    const poolInputDelta = 1.0;
    const poolOutputDelta = -198.75;
    const fee = 0.00001;
    const executedAt = '2026-07-13T12:00:00.000Z';

    it('should return exact executedAt, settled amounts, and signed balance changes from pool vault', async () => {
      const mockSolana = buildMockSolana({
        extractBalanceChangesAndFee: jest.fn().mockResolvedValue({
          balanceChanges: [poolInputDelta, poolOutputDelta],
          fee,
          executedAt,
        }),
      });
      (Solana.getInstance as jest.Mock).mockResolvedValue(mockSolana);

      const response = await app.inject({
        method: 'POST',
        url: '/execute-swap',
        payload: SELL_PAYLOAD,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      // Exact timestamp
      expect(body.executedAt).toBe(executedAt);

      // SELL: input=base(SOL), output=quote(USDC)
      // User: inputChange = -poolInputDelta = -1.0, outputChange = -poolOutputDelta = 198.75
      // amountIn = 1.0, amountOut = 198.75
      // baseTokenBalanceChange = inputChange = -1.0 (user sells base)
      // quoteTokenBalanceChange = outputChange = 198.75 (user receives quote)
      expect(body.data.tokenIn).toBe('SOL');
      expect(body.data.tokenOut).toBe('USDC');
      expect(body.data.amountIn).toBe(1.0);
      expect(body.data.amountOut).toBe(198.75);
      expect(body.data.baseTokenBalanceChange).toBe(-1.0);
      expect(body.data.quoteTokenBalanceChange).toBe(198.75);
      expect(body.data.fee).toBe(fee);
      expect(body.data.feeAsset).toBe('SOL');

      // Verify extraction called with pool address, nativeMintAsSpl, and strictTokenBalances options
      expect(mockSolana.extractBalanceChangesAndFee).toHaveBeenCalledTimes(1);
      expect(mockSolana.extractBalanceChangesAndFee).toHaveBeenCalledWith(
        'test-signature',
        mockPoolAddress,
        [mockBaseTokenInfo.address, mockQuoteTokenInfo.address],
        { nativeMintAsSpl: true, strictTokenBalances: true },
      );
    });
  });

  describe('BUY direction (quote -> base, i.e. USDC -> SOL) using pool vault deltas', () => {
    const BUY_PAYLOAD = {
      baseToken: 'SOL',
      quoteToken: 'USDC',
      amount: 0.1,
      side: 'BUY',
      poolAddress: mockPoolAddress,
    };

    const poolInputDelta = 20.5; // pool receives 20.5 USDC
    const poolOutputDelta = -0.0985; // pool gives 0.0985 WSOL/SOL
    const fee = 0.00001;
    const executedAt = '2026-07-13T12:00:05.000Z';

    it('should return correct settled amounts for BUY direction', async () => {
      const mockSolana = buildMockSolana({
        extractBalanceChangesAndFee: jest.fn().mockResolvedValue({
          balanceChanges: [poolInputDelta, poolOutputDelta],
          fee,
          executedAt,
        }),
      });
      (Solana.getInstance as jest.Mock).mockResolvedValue(mockSolana);

      const response = await app.inject({
        method: 'POST',
        url: '/execute-swap',
        payload: BUY_PAYLOAD,
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      // Exact timestamp
      expect(body.executedAt).toBe(executedAt);

      // BUY: input=quote(USDC), output=base(SOL)
      // User: inputChange = -poolInputDelta = -20.5, outputChange = -poolOutputDelta = 0.0985
      // amountIn = 20.5, amountOut = 0.0985
      // baseTokenBalanceChange = outputChange = 0.0985 (user receives base)
      // quoteTokenBalanceChange = inputChange = -20.5 (user pays quote)
      expect(body.data.tokenIn).toBe('USDC');
      expect(body.data.tokenOut).toBe('SOL');
      expect(body.data.amountIn).toBe(20.5);
      expect(body.data.amountOut).toBe(0.0985);
      expect(body.data.baseTokenBalanceChange).toBe(0.0985);
      expect(body.data.quoteTokenBalanceChange).toBe(-20.5);
      expect(body.data.fee).toBe(fee);
      expect(body.data.feeAsset).toBe('SOL');

      // Verify extraction called with pool address, nativeMintAsSpl, and strictTokenBalances options
      // For BUY: input=USDC, output=SOL
      expect(mockSolana.extractBalanceChangesAndFee).toHaveBeenCalledTimes(1);
      expect(mockSolana.extractBalanceChangesAndFee).toHaveBeenCalledWith(
        'test-signature',
        mockPoolAddress,
        [mockQuoteTokenInfo.address, mockBaseTokenInfo.address],
        { nativeMintAsSpl: true, strictTokenBalances: true },
      );
    });
  });

  describe('invalid pool vault delta validation', () => {
    it('should return 500 when pool input delta is zero', async () => {
      const mockSolana = buildMockSolana({
        extractBalanceChangesAndFee: jest.fn().mockResolvedValue({
          balanceChanges: [0, -198.75],
          fee: 0.00001,
          executedAt: '2026-07-13T12:00:00.000Z',
        }),
      });
      (Solana.getInstance as jest.Mock).mockResolvedValue(mockSolana);

      const response = await app.inject({
        method: 'POST',
        url: '/execute-swap',
        payload: {
          baseToken: 'SOL',
          quoteToken: 'USDC',
          amount: 1.0,
          side: 'SELL',
          poolAddress: mockPoolAddress,
        },
      });

      expect(response.statusCode).toBe(500);
      expect(mockSolana.extractBalanceChangesAndFee).toHaveBeenCalledTimes(1);
    });

    it('should return 500 when pool output delta is zero', async () => {
      const mockSolana = buildMockSolana({
        extractBalanceChangesAndFee: jest.fn().mockResolvedValue({
          balanceChanges: [1.0, 0],
          fee: 0.00001,
          executedAt: '2026-07-13T12:00:00.000Z',
        }),
      });
      (Solana.getInstance as jest.Mock).mockResolvedValue(mockSolana);

      const response = await app.inject({
        method: 'POST',
        url: '/execute-swap',
        payload: {
          baseToken: 'SOL',
          quoteToken: 'USDC',
          amount: 1.0,
          side: 'SELL',
          poolAddress: mockPoolAddress,
        },
      });

      expect(response.statusCode).toBe(500);
      expect(mockSolana.extractBalanceChangesAndFee).toHaveBeenCalledTimes(1);
    });

    it('should return 500 when pool deltas are reversed (negative input, positive output)', async () => {
      const mockSolana = buildMockSolana({
        extractBalanceChangesAndFee: jest.fn().mockResolvedValue({
          balanceChanges: [-1.0, 198.75],
          fee: 0.00001,
          executedAt: '2026-07-13T12:00:00.000Z',
        }),
      });
      (Solana.getInstance as jest.Mock).mockResolvedValue(mockSolana);

      const response = await app.inject({
        method: 'POST',
        url: '/execute-swap',
        payload: {
          baseToken: 'SOL',
          quoteToken: 'USDC',
          amount: 1.0,
          side: 'SELL',
          poolAddress: mockPoolAddress,
        },
      });

      expect(response.statusCode).toBe(500);
      expect(mockSolana.extractBalanceChangesAndFee).toHaveBeenCalledTimes(1);
    });
  });

  describe('fee validation', () => {
    it('should return 500 when fee is zero', async () => {
      const mockSolana = buildMockSolana({
        extractBalanceChangesAndFee: jest.fn().mockResolvedValue({
          balanceChanges: [1.0, -198.75],
          fee: 0,
          executedAt: '2026-07-13T12:00:00.000Z',
        }),
      });
      (Solana.getInstance as jest.Mock).mockResolvedValue(mockSolana);

      const response = await app.inject({
        method: 'POST',
        url: '/execute-swap',
        payload: {
          baseToken: 'SOL',
          quoteToken: 'USDC',
          amount: 1.0,
          side: 'SELL',
          poolAddress: mockPoolAddress,
        },
      });

      expect(response.statusCode).toBe(500);
    });

    it('should return 500 when fee is NaN', async () => {
      const mockSolana = buildMockSolana({
        extractBalanceChangesAndFee: jest.fn().mockResolvedValue({
          balanceChanges: [1.0, -198.75],
          fee: NaN,
          executedAt: '2026-07-13T12:00:00.000Z',
        }),
      });
      (Solana.getInstance as jest.Mock).mockResolvedValue(mockSolana);

      const response = await app.inject({
        method: 'POST',
        url: '/execute-swap',
        payload: {
          baseToken: 'SOL',
          quoteToken: 'USDC',
          amount: 1.0,
          side: 'SELL',
          poolAddress: mockPoolAddress,
        },
      });

      expect(response.statusCode).toBe(500);
    });

    it('should return 500 when fee is negative', async () => {
      const mockSolana = buildMockSolana({
        extractBalanceChangesAndFee: jest.fn().mockResolvedValue({
          balanceChanges: [1.0, -198.75],
          fee: -0.00001,
          executedAt: '2026-07-13T12:00:00.000Z',
        }),
      });
      (Solana.getInstance as jest.Mock).mockResolvedValue(mockSolana);

      const response = await app.inject({
        method: 'POST',
        url: '/execute-swap',
        payload: {
          baseToken: 'SOL',
          quoteToken: 'USDC',
          amount: 1.0,
          side: 'SELL',
          poolAddress: mockPoolAddress,
        },
      });

      expect(response.statusCode).toBe(500);
    });
  });

  describe('extractBalanceChangesAndFee failure propagation', () => {
    it('should return 500 when receipt is missing (transaction not found)', async () => {
      const mockSolana = buildMockSolana({
        extractBalanceChangesAndFee: jest
          .fn()
          .mockRejectedValue(new Error('Transaction test-signature not found after retries')),
      });
      (Solana.getInstance as jest.Mock).mockResolvedValue(mockSolana);

      const response = await app.inject({
        method: 'POST',
        url: '/execute-swap',
        payload: {
          baseToken: 'SOL',
          quoteToken: 'USDC',
          amount: 1.0,
          side: 'SELL',
          poolAddress: mockPoolAddress,
        },
      });

      expect(response.statusCode).toBe(500);
      expect(mockSolana.extractBalanceChangesAndFee).toHaveBeenCalledTimes(1);
    });

    it('should return 500 when blockTime is missing', async () => {
      const mockSolana = buildMockSolana({
        extractBalanceChangesAndFee: jest
          .fn()
          .mockRejectedValue(new Error('Confirmed transaction test-signature is missing a valid block time')),
      });
      (Solana.getInstance as jest.Mock).mockResolvedValue(mockSolana);

      const response = await app.inject({
        method: 'POST',
        url: '/execute-swap',
        payload: {
          baseToken: 'SOL',
          quoteToken: 'USDC',
          amount: 1.0,
          side: 'SELL',
          poolAddress: mockPoolAddress,
        },
      });

      expect(response.statusCode).toBe(500);
      expect(mockSolana.extractBalanceChangesAndFee).toHaveBeenCalledTimes(1);
    });
  });

  describe('without poolAddress (pool lookup)', () => {
    it('should return 404 when pool not found', async () => {
      const mockSolana = {
        getToken: jest.fn().mockResolvedValueOnce(MOCK_SOL_TOKEN).mockResolvedValueOnce(MOCK_USDC_TOKEN),
      };
      (Solana.getInstance as jest.Mock).mockResolvedValue(mockSolana);

      const mockPoolService = {
        getPool: jest.fn().mockResolvedValue(null),
      };
      (PoolService.getInstance as jest.Mock).mockReturnValue(mockPoolService);

      const response = await app.inject({
        method: 'POST',
        url: '/execute-swap',
        payload: {
          network: 'mainnet-beta',
          walletAddress: mockWalletAddress,
          baseToken: 'SOL',
          quoteToken: 'USDC',
          amount: 1.0,
          side: 'SELL',
        },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('validation', () => {
    it('should return 400 when baseToken is missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/execute-swap',
        payload: {
          network: 'mainnet-beta',
          walletAddress: mockWalletAddress,
          quoteToken: 'USDC',
          amount: 1.0,
          side: 'SELL',
          poolAddress: mockPoolAddress,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return 400 when amount is missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/execute-swap',
        payload: {
          network: 'mainnet-beta',
          walletAddress: mockWalletAddress,
          baseToken: 'SOL',
          quoteToken: 'USDC',
          side: 'SELL',
          poolAddress: mockPoolAddress,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return error when side is missing (default not applied)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/execute-swap',
        payload: {
          network: 'mainnet-beta',
          walletAddress: mockWalletAddress,
          baseToken: 'SOL',
          quoteToken: 'USDC',
          amount: 1.0,
          poolAddress: mockPoolAddress,
        },
      });

      expect([400, 500]).toContain(response.statusCode);
    });

    it('should return error for invalid token', async () => {
      const mockSolana = {
        getToken: jest.fn().mockResolvedValue(null),
        getWallet: jest.fn().mockResolvedValue(mockWallet),
      };
      (Solana.getInstance as jest.Mock).mockResolvedValue(mockSolana);

      const response = await app.inject({
        method: 'POST',
        url: '/execute-swap',
        payload: {
          network: 'mainnet-beta',
          walletAddress: mockWalletAddress,
          baseToken: 'INVALID',
          quoteToken: 'USDC',
          amount: 1.0,
          side: 'SELL',
          poolAddress: mockPoolAddress,
        },
      });

      expect([400, 500]).toContain(response.statusCode);
    });
  });

  describe('error handling', () => {
    it('should handle errors gracefully', async () => {
      const mockSolana = {
        getToken: jest.fn().mockImplementation((symbol: string) => {
          if (symbol === 'SOL') return mockBaseTokenInfo;
          if (symbol === 'USDC') return mockQuoteTokenInfo;
          return null;
        }),
        getWallet: jest.fn().mockResolvedValue(mockWallet),
        simulateWithErrorHandling: jest.fn().mockRejectedValue(new Error('Simulation failed')),
      };
      (Solana.getInstance as jest.Mock).mockResolvedValue(mockSolana);

      const response = await app.inject({
        method: 'POST',
        url: '/execute-swap',
        payload: {
          network: 'mainnet-beta',
          walletAddress: mockWalletAddress,
          baseToken: 'SOL',
          quoteToken: 'USDC',
          amount: 1.0,
          side: 'SELL',
          poolAddress: mockPoolAddress,
        },
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
    });
  });
});
