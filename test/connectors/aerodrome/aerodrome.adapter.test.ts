import { BigNumber } from 'ethers';

import { Ethereum } from '../../../src/chains/ethereum/ethereum';
import {
  executeAerodromeAddLiquidity,
  executeAerodromeRemoveLiquidity,
  executeAerodromeSwap,
  quoteAerodrome,
} from '../../../src/connectors/aerodrome/aerodrome.adapter';

const quoteAerodromeForGateway = jest.fn();
const planAerodromeGatewaySwap = jest.fn();
const executeAerodromeGatewaySwapPlan = jest.fn();
const planAddLiquidity = jest.fn();
const planRemoveLiquidity = jest.fn();

jest.mock('../../../src/chains/ethereum/ethereum', () => ({
  Ethereum: {
    getInstance: jest.fn(),
  },
}));

jest.mock(
  'hummingbot-aerodrome-gateway-connector',
  () => ({
    Aerodrome: jest.fn().mockImplementation((provider) => ({ provider })),
  }),
  { virtual: true },
);

jest.mock(
  'hummingbot-aerodrome-gateway-connector/gateway-adapter',
  () => ({
    quoteAerodromeForGateway: (...args: unknown[]) => quoteAerodromeForGateway(...args),
    planAerodromeGatewaySwap: (...args: unknown[]) => planAerodromeGatewaySwap(...args),
    executeAerodromeGatewaySwapPlan: (...args: unknown[]) => executeAerodromeGatewaySwapPlan(...args),
  }),
  { virtual: true },
);

jest.mock(
  'hummingbot-aerodrome-gateway-connector/liquidity',
  () => ({
    AerodromeLiquidityPlanner: jest.fn().mockImplementation(() => ({
      planAddLiquidity: (...args: unknown[]) => planAddLiquidity(...args),
      planRemoveLiquidity: (...args: unknown[]) => planRemoveLiquidity(...args),
    })),
  }),
  { virtual: true },
);

describe('Aerodrome Gateway adapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.AERODROME_GATEWAY_TIMEOUT_MS;
    executorReceiptRef = undefined;
  });

  let executorReceiptRef: { current: unknown } | undefined;

  function setupBlockLookup(getBlock: jest.Mock, expectedHash: string): void {
    executorReceiptRef = { current: undefined };
    (Ethereum.getInstance as jest.Mock).mockResolvedValue({
      provider: { getBlock },
      getWallet: jest.fn().mockResolvedValue({
        sendTransaction: jest.fn().mockResolvedValue({ hash: expectedHash }),
      }),
      prepareGasOptions: jest.fn().mockResolvedValue({ gasLimit: 321000 }),
      handleTransactionExecution: jest.fn().mockResolvedValue({
        transactionHash: expectedHash,
        status: 1,
        blockNumber: 999,
        gasUsed: BigNumber.from(200000),
        effectiveGasPrice: BigNumber.from(1_500_000_000),
        logs: [{ address: '0xtoken', topics: ['0xtopic'], data: '0xdata' }],
      }),
    });
    planAerodromeGatewaySwap.mockResolvedValue({
      swap: {
        to: '0x2222222222222222222222222222222222222222',
        from: '0x1111111111111111111111111111111111111111',
        data: '0x1234',
        value: '0',
        gasEstimate: '321000',
      },
    });
    executeAerodromeGatewaySwapPlan.mockImplementation(async (plan, executor) => {
      const tx = await executor.executeTransaction(plan.swap);
      executorReceiptRef!.current = tx.receipt;
      return {
        signature: tx.signature,
        status: tx.status,
        transactions: [{ kind: 'swap', signature: tx.signature, status: tx.status }],
      };
    });
  }

  it('fails closed when quote planning times out', async () => {
    process.env.AERODROME_GATEWAY_TIMEOUT_MS = '5';
    (Ethereum.getInstance as jest.Mock).mockResolvedValue({
      provider: {},
      getToken: jest.fn(async (symbol: string) => ({
        symbol,
        address: symbol === 'WETH' ? '0x4200000000000000000000000000000000000006' : '0xusdc',
        decimals: symbol === 'USDC' ? 6 : 18,
      })),
    });
    quoteAerodromeForGateway.mockReturnValue(new Promise(() => undefined));

    await expect(
      quoteAerodrome('base', {
        baseToken: 'WETH',
        quoteToken: 'USDC',
        amount: 1,
        side: 'SELL',
      }),
    ).rejects.toMatchObject({
      statusCode: 504,
      message: 'Aerodrome quote timed out after 5ms',
    });
  });

  it('executes planned transactions through the Gateway Ethereum wallet', async () => {
    const liveActionAuthorization = { version: 'live-action-authorization-v1' };
    const sendTransaction = jest.fn().mockResolvedValue({ hash: '0xabc' });
    let executorReceipt: unknown;
    const ethereum = {
      provider: {
        getBlock: jest.fn().mockResolvedValue({ timestamp: 1_700_000_000 }),
        send: jest.fn().mockResolvedValue({ l1Fee: '0x64' }),
      },
      getWallet: jest.fn().mockResolvedValue({ sendTransaction }),
      prepareGasOptions: jest.fn().mockResolvedValue({ gasLimit: 321000 }),
      handleTransactionExecution: jest.fn().mockResolvedValue({
        transactionHash: '0xabc',
        status: 1,
        blockNumber: 123,
        gasUsed: BigNumber.from(200000),
        effectiveGasPrice: BigNumber.from(1_500_000_000),
        logs: [{ address: '0xtoken', topics: ['0xtopic'], data: '0xdata' }],
      }),
    };
    (Ethereum.getInstance as jest.Mock).mockResolvedValue(ethereum);
    planAerodromeGatewaySwap.mockResolvedValue({
      swap: {
        to: '0x2222222222222222222222222222222222222222',
        from: '0x1111111111111111111111111111111111111111',
        data: '0x1234',
        value: '0',
        gasEstimate: '321000',
      },
    });
    executeAerodromeGatewaySwapPlan.mockImplementation(async (plan, executor) => {
      const tx = await executor.executeTransaction(plan.swap);
      executorReceipt = tx.receipt;
      return {
        signature: tx.signature,
        status: 1,
        executedAt: '2023-11-14T22:13:20.000Z',
        transactions: [{ kind: 'swap', signature: tx.signature, status: tx.status }],
        data: {
          tokenIn: 'WETH',
          tokenOut: 'USDC',
          amountIn: '1',
          amountOut: '3000',
          fee: '0.0003',
          feeAsset: 'ETH',
        },
      };
    });

    const response = await executeAerodromeSwap(
      'base',
      {
        baseToken: 'WETH',
        quoteToken: 'USDC',
        amount: 1,
        side: 'SELL',
        walletAddress: '0x1111111111111111111111111111111111111111',
      },
      liveActionAuthorization,
      'aerodrome_execute_swap',
    );

    expect(ethereum.getWallet).toHaveBeenCalledWith('0x1111111111111111111111111111111111111111');
    expect(ethereum.prepareGasOptions).toHaveBeenCalledWith(
      undefined,
      321000,
      liveActionAuthorization,
      'aerodrome_execute_swap',
      {
        expectedConnectorId: 'aerodrome',
        expectedNotional: 1,
        expectedSlippageBps: undefined,
        expectedWalletAddress: '0x1111111111111111111111111111111111111111',
      },
    );
    expect(sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '0x2222222222222222222222222222222222222222',
        data: '0x1234',
        gasLimit: 321000,
      }),
    );
    expect(response).toMatchObject({
      signature: '0xabc',
      status: 1,
      executedAt: '2023-11-14T22:13:20.000Z',
      data: { tokenIn: 'WETH', tokenOut: 'USDC', feeAsset: 'ETH' },
    });
    expect(executorReceipt).toEqual({
      status: 1,
      gasUsed: '200000',
      effectiveGasPrice: '1500000000',
      l1Fee: '0x64',
      blockTimestamp: 1_700_000_000,
      logs: [{ address: '0xtoken', topics: ['0xtopic'], data: '0xdata' }],
    });
  });

  it('keeps pending swaps submitted without receipt evidence', async () => {
    const getBlock = jest.fn();
    let executorReceipt: unknown;
    (Ethereum.getInstance as jest.Mock).mockResolvedValue({
      provider: { getBlock },
      getWallet: jest.fn().mockResolvedValue({
        sendTransaction: jest.fn().mockResolvedValue({ hash: '0xpending' }),
      }),
      prepareGasOptions: jest.fn().mockResolvedValue({ gasLimit: 321000 }),
      handleTransactionExecution: jest.fn().mockResolvedValue(null),
    });
    planAerodromeGatewaySwap.mockResolvedValue({
      swap: {
        to: '0x2222222222222222222222222222222222222222',
        from: '0x1111111111111111111111111111111111111111',
        data: '0x1234',
        value: '0',
        gasEstimate: '321000',
      },
    });
    executeAerodromeGatewaySwapPlan.mockImplementation(async (plan, executor) => {
      const tx = await executor.executeTransaction(plan.swap);
      executorReceipt = tx.receipt;
      return {
        signature: tx.signature,
        status: tx.status,
        transactions: [{ kind: 'swap', signature: tx.signature, status: tx.status }],
      };
    });

    const response = await executeAerodromeSwap('base', {
      baseToken: 'WETH',
      quoteToken: 'USDC',
      amount: 1,
      side: 'SELL',
      walletAddress: '0x1111111111111111111111111111111111111111',
    });

    expect(response).toMatchObject({ signature: '0xpending', status: 'SUBMITTED' });
    expect(executorReceipt).toBeUndefined();
    expect(getBlock).not.toHaveBeenCalled();
  });

  it('preserves FAILED status when reverted receipt has a failed block lookup (swap not broadcast)', async () => {
    const sendTransaction = jest.fn().mockResolvedValueOnce({ hash: '0xapproval_fail' });
    (Ethereum.getInstance as jest.Mock).mockResolvedValue({
      provider: { getBlock: jest.fn().mockRejectedValue(new Error('block lookup failed')) },
      getWallet: jest.fn().mockResolvedValue({ sendTransaction }),
      prepareGasOptions: jest.fn().mockResolvedValue({ gasLimit: 321000 }),
      handleTransactionExecution: jest.fn().mockResolvedValue({
        transactionHash: '0xapproval_fail',
        status: 0,
        blockNumber: 888,
        gasUsed: BigNumber.from(200000),
        effectiveGasPrice: BigNumber.from(1_500_000_000),
        logs: [{ address: '0xtoken', topics: ['0xtopic'], data: '0xdata' }],
      }),
    });
    planAerodromeGatewaySwap.mockResolvedValue({
      approval: {
        to: '0xtoken',
        from: '0x1111111111111111111111111111111111111111',
        data: '0xapprove',
        value: '0',
        gasEstimate: '250000',
      },
      swap: {
        to: '0x2222222222222222222222222222222222222222',
        from: '0x1111111111111111111111111111111111111111',
        data: '0x1234',
        value: '0',
        gasEstimate: '321000',
      },
    });
    executeAerodromeGatewaySwapPlan.mockImplementation(async (plan, executor) => {
      const approvalTx = await executor.executeTransaction(plan.approval);
      if (approvalTx.status === 'FAILED') {
        return {
          signature: approvalTx.signature,
          status: 'FAILED',
          transactions: [{ kind: 'approval', signature: approvalTx.signature, status: approvalTx.status }],
        };
      }
      const swapTx = await executor.executeTransaction(plan.swap);
      return {
        signature: swapTx.signature,
        status: swapTx.status,
        transactions: [
          { kind: 'approval', signature: approvalTx.signature, status: approvalTx.status },
          { kind: 'swap', signature: swapTx.signature, status: swapTx.status },
        ],
      };
    });

    const response = await executeAerodromeSwap('base', {
      baseToken: 'WETH',
      quoteToken: 'USDC',
      amount: 1,
      side: 'SELL',
      walletAddress: '0x1111111111111111111111111111111111111111',
    });

    expect(response).toMatchObject({ signature: '0xapproval_fail', status: 'FAILED' });
    expect(sendTransaction).toHaveBeenCalledTimes(1);
    expect(response as Record<string, unknown>).not.toHaveProperty('receipt');
    expect(response as Record<string, unknown>).not.toHaveProperty('data');
    expect(response as Record<string, unknown>).not.toHaveProperty('executedAt');
  });

  it('returns SUBMITTED with hash when block lookup fails (timeout/network error)', async () => {
    jest.useFakeTimers();
    try {
      setupBlockLookup(jest.fn().mockRejectedValue(new Error('network error')), '0xblockerror');
      const response = await executeAerodromeSwap('base', {
        baseToken: 'WETH',
        quoteToken: 'USDC',
        amount: 1,
        side: 'SELL',
        walletAddress: '0x1111111111111111111111111111111111111111',
      });
      expect(jest.getTimerCount()).toBe(0);
      expect(response).toMatchObject({ signature: '0xblockerror', status: 'SUBMITTED' });
      expect(executorReceiptRef!.current).toBeUndefined();
      expect(response as Record<string, unknown>).not.toHaveProperty('receipt');
      expect(response as Record<string, unknown>).not.toHaveProperty('data');
      expect(response as Record<string, unknown>).not.toHaveProperty('executedAt');
    } finally {
      jest.useRealTimers();
    }
  });

  it('returns SUBMITTED with hash when block lookup returns null', async () => {
    setupBlockLookup(jest.fn().mockResolvedValue(null), '0xnullblock');
    const response = await executeAerodromeSwap('base', {
      baseToken: 'WETH',
      quoteToken: 'USDC',
      amount: 1,
      side: 'SELL',
      walletAddress: '0x1111111111111111111111111111111111111111',
    });
    expect(response).toMatchObject({ signature: '0xnullblock', status: 'SUBMITTED' });
    expect(executorReceiptRef!.current).toBeUndefined();
    expect(response as Record<string, unknown>).not.toHaveProperty('receipt');
    expect(response as Record<string, unknown>).not.toHaveProperty('data');
    expect(response as Record<string, unknown>).not.toHaveProperty('executedAt');
  });

  it('returns SUBMITTED with hash when block has no timestamp', async () => {
    setupBlockLookup(jest.fn().mockResolvedValue({}), '0xnotimestamp');
    const response = await executeAerodromeSwap('base', {
      baseToken: 'WETH',
      quoteToken: 'USDC',
      amount: 1,
      side: 'SELL',
      walletAddress: '0x1111111111111111111111111111111111111111',
    });
    expect(response).toMatchObject({ signature: '0xnotimestamp', status: 'SUBMITTED' });
    expect(executorReceiptRef!.current).toBeUndefined();
    expect(response as Record<string, unknown>).not.toHaveProperty('receipt');
    expect(response as Record<string, unknown>).not.toHaveProperty('data');
    expect(response as Record<string, unknown>).not.toHaveProperty('executedAt');
  });

  it('returns SUBMITTED when getBlock never resolves (timeout after BLOCK_LOOKUP_TIMEOUT_MS)', async () => {
    jest.useFakeTimers();
    try {
      setupBlockLookup(jest.fn().mockReturnValue(new Promise(() => undefined)), '0xhanging');
      const responsePromise = executeAerodromeSwap('base', {
        baseToken: 'WETH',
        quoteToken: 'USDC',
        amount: 1,
        side: 'SELL',
        walletAddress: '0x1111111111111111111111111111111111111111',
      });
      await jest.advanceTimersByTimeAsync(0);
      expect(jest.getTimerCount()).toBe(1);
      await jest.advanceTimersByTimeAsync(5000);
      expect(jest.getTimerCount()).toBe(0);
      const response = await responsePromise;
      expect(response).toMatchObject({ signature: '0xhanging', status: 'SUBMITTED' });
      expect(executorReceiptRef!.current).toBeUndefined();
      expect(response as Record<string, unknown>).not.toHaveProperty('receipt');
      expect(response as Record<string, unknown>).not.toHaveProperty('data');
      expect(response as Record<string, unknown>).not.toHaveProperty('executedAt');
    } finally {
      jest.useRealTimers();
    }
  });

  it('clears block lookup timer when getBlock resolves before the deadline', async () => {
    jest.useFakeTimers();
    try {
      setupBlockLookup(
        jest
          .fn()
          .mockImplementation(
            () => new Promise((resolve) => setTimeout(() => resolve({ timestamp: 1_700_000_000 }), 200)),
          ),
        '0xearlyresolve',
      );
      const responsePromise = executeAerodromeSwap('base', {
        baseToken: 'WETH',
        quoteToken: 'USDC',
        amount: 1,
        side: 'SELL',
        walletAddress: '0x1111111111111111111111111111111111111111',
      });
      await jest.advanceTimersByTimeAsync(0);
      expect(jest.getTimerCount()).toBe(2);
      await jest.advanceTimersByTimeAsync(200);
      expect(jest.getTimerCount()).toBe(0);
      const response = await responsePromise;
      expect(response).toMatchObject({ signature: '0xearlyresolve', status: 'CONFIRMED' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('fails closed when the planned sender wallet is unavailable', async () => {
    const ethereum = {
      provider: {},
      getWallet: jest.fn().mockRejectedValue(new Error('Wallet not found')),
    };
    (Ethereum.getInstance as jest.Mock).mockResolvedValue(ethereum);
    planAerodromeGatewaySwap.mockResolvedValue({
      swap: {
        to: '0x2222222222222222222222222222222222222222',
        from: '0x1111111111111111111111111111111111111111',
        data: '0x1234',
        value: '0',
        gasEstimate: '321000',
      },
    });

    await expect(
      executeAerodromeSwap('base', {
        baseToken: 'WETH',
        quoteToken: 'USDC',
        amount: 1,
        side: 'SELL',
        walletAddress: '0x1111111111111111111111111111111111111111',
      }),
    ).rejects.toThrow('planned sender wallet');
  });

  it('executes add-liquidity approvals and liquidity transaction sequentially', async () => {
    const sendTransaction = jest
      .fn()
      .mockResolvedValueOnce({ hash: '0xapproval' })
      .mockResolvedValueOnce({ hash: '0xlpadd' });
    const ethereum = {
      provider: {},
      getToken: jest.fn(async (symbol: string) => ({
        symbol,
        address: symbol === 'WETH' ? '0x4200000000000000000000000000000000000006' : '0xusdc',
        decimals: symbol === 'USDC' ? 6 : 18,
      })),
      getWallet: jest.fn().mockResolvedValue({ sendTransaction }),
      prepareGasOptions: jest.fn(async (_gasPrice, gasLimit) => ({ gasLimit })),
      handleTransactionExecution: jest
        .fn()
        .mockResolvedValueOnce({ transactionHash: '0xapproval', status: 1 })
        .mockResolvedValueOnce({ transactionHash: '0xlpadd', status: 1 }),
    };
    (Ethereum.getInstance as jest.Mock).mockResolvedValue(ethereum);
    planAddLiquidity.mockResolvedValue({
      quote: { poolAddress: '0xpool' },
      approvals: [
        {
          to: '0xusdc',
          from: '0x1111111111111111111111111111111111111111',
          data: '0xapprove',
          value: '0',
          gasEstimate: '250000',
        },
      ],
      transaction: {
        to: '0xrouter',
        from: '0x1111111111111111111111111111111111111111',
        data: '0xadd',
        value: '0',
        gasEstimate: '321000',
      },
    });

    const response = await executeAerodromeAddLiquidity('base', {
      tokenA: 'WETH',
      tokenB: 'USDC',
      amountA: '0.01',
      amountB: '30',
      poolType: 'volatile',
      walletAddress: '0x1111111111111111111111111111111111111111',
      slippagePct: 0.5,
    });

    expect(planAddLiquidity).toHaveBeenCalledWith(
      expect.objectContaining({
        amountA: '0.01',
        amountB: '30',
        slippageBps: 50,
      }),
    );
    expect(sendTransaction).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ to: '0xusdc', data: '0xapprove', gasLimit: 250000 }),
    );
    expect(ethereum.prepareGasOptions).toHaveBeenNthCalledWith(
      1,
      undefined,
      250000,
      undefined,
      undefined,
      expect.objectContaining({ expectedConnectorId: 'aerodrome' }),
    );
    expect(sendTransaction).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ to: '0xrouter', data: '0xadd', gasLimit: 321000 }),
    );
    expect(ethereum.prepareGasOptions).toHaveBeenNthCalledWith(
      2,
      undefined,
      321000,
      undefined,
      undefined,
      expect.objectContaining({ expectedConnectorId: 'aerodrome' }),
    );
    expect(response).toMatchObject({
      signature: '0xlpadd',
      status: 'CONFIRMED',
      transactions: [
        { kind: 'approval', signature: '0xapproval', status: 'CONFIRMED' },
        { kind: 'lp_add', signature: '0xlpadd', status: 'CONFIRMED' },
      ],
    });
  });

  it('executes remove-liquidity transaction through the Gateway wallet', async () => {
    const sendTransaction = jest.fn().mockResolvedValue({ hash: '0xlpremove' });
    const ethereum = {
      provider: {},
      getToken: jest.fn(async (symbol: string) => ({
        symbol,
        address: symbol === 'WETH' ? '0x4200000000000000000000000000000000000006' : '0xusdc',
        decimals: symbol === 'USDC' ? 6 : 18,
      })),
      getWallet: jest.fn().mockResolvedValue({ sendTransaction }),
      prepareGasOptions: jest.fn(async (_gasPrice, gasLimit) => ({ gasLimit })),
      handleTransactionExecution: jest.fn().mockResolvedValue({ transactionHash: '0xlpremove', status: 1 }),
    };
    (Ethereum.getInstance as jest.Mock).mockResolvedValue(ethereum);
    planRemoveLiquidity.mockResolvedValue({
      quote: { poolAddress: '0xpool' },
      approvals: [],
      transaction: {
        to: '0xrouter',
        from: '0x1111111111111111111111111111111111111111',
        data: '0xremove',
        value: '0',
        gasEstimate: '300000',
      },
    });

    const response = await executeAerodromeRemoveLiquidity('base', {
      tokenA: 'WETH',
      tokenB: 'USDC',
      liquidity: '0.01',
      poolType: 'volatile',
      walletAddress: '0x1111111111111111111111111111111111111111',
    });

    expect(planRemoveLiquidity).toHaveBeenCalledWith(
      expect.objectContaining({
        liquidity: '0.01',
      }),
    );
    expect(ethereum.prepareGasOptions).toHaveBeenCalledWith(
      undefined,
      300000,
      undefined,
      undefined,
      expect.objectContaining({ expectedConnectorId: 'aerodrome' }),
    );
    expect(response).toMatchObject({
      signature: '0xlpremove',
      status: 'CONFIRMED',
      transactions: [{ kind: 'lp_remove', signature: '0xlpremove', status: 'CONFIRMED' }],
    });
  });
});
