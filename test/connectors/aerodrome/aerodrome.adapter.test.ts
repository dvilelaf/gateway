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
  });

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
    const sendTransaction = jest.fn().mockResolvedValue({ hash: '0xabc' });
    const ethereum = {
      provider: {},
      getWallet: jest.fn().mockResolvedValue({ sendTransaction }),
      prepareGasOptions: jest.fn().mockResolvedValue({ gasLimit: 321000 }),
      handleTransactionExecution: jest.fn().mockResolvedValue({
        transactionHash: '0xabc',
        status: 1,
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

    expect(ethereum.getWallet).toHaveBeenCalledWith('0x1111111111111111111111111111111111111111');
    expect(ethereum.prepareGasOptions).toHaveBeenCalledWith(undefined, 321000);
    expect(sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '0x2222222222222222222222222222222222222222',
        data: '0x1234',
        gasLimit: 321000,
      }),
    );
    expect(response).toMatchObject({
      signature: '0xabc',
      status: 'CONFIRMED',
    });
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
    expect(sendTransaction).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ to: '0xrouter', data: '0xadd', gasLimit: 321000 }),
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
    expect(response).toMatchObject({
      signature: '0xlpremove',
      status: 'CONFIRMED',
      transactions: [{ kind: 'lp_remove', signature: '0xlpremove', status: 'CONFIRMED' }],
    });
  });
});
