import '../../../mocks/app-mocks';

import { executeQuote } from '../../../../src/connectors/jupiter/router-routes/executeQuote';
import { executeSwap } from '../../../../src/connectors/jupiter/router-routes/executeSwap';
import { quoteSwap } from '../../../../src/connectors/jupiter/router-routes/quoteSwap';
import { LiveActionAuthorization } from '../../../../src/services/runtime-guard';

jest.mock('../../../../src/connectors/jupiter/router-routes/executeQuote', () => ({ executeQuote: jest.fn() }));
jest.mock('../../../../src/connectors/jupiter/router-routes/quoteSwap', () => ({ quoteSwap: jest.fn() }));

const authorization: LiveActionAuthorization = { notional: '10' };
const guardContext = {
  expectedConnectorId: 'jupiter',
  expectedNotional: 1,
  expectedSlippageBps: 100,
  expectedWalletAddress: 'wallet',
};
const buyQuote = (otherAmountThreshold: unknown, swapMode: unknown = 'ExactOut', inputTokenDecimals: unknown = 6) => ({
  quoteId: 'quote-id',
  amountIn: 10,
  amountOut: 1,
  maxAmountIn: 10,
  inputTokenDecimals,
  quoteResponse: { otherAmountThreshold, swapMode },
});

describe('Jupiter executeSwap authorized BUY', () => {
  beforeEach(() => jest.clearAllMocks());

  it('accepts an exact-output raw threshold at the authorized atomic cap', async () => {
    const quote = buyQuote('10000000');
    (quoteSwap as jest.Mock).mockResolvedValue(quote);
    (executeQuote as jest.Mock).mockResolvedValue({ status: 1, data: quote });

    const result = await executeSwap(
      'wallet',
      'mainnet-beta',
      'SOL',
      'USDC',
      1,
      'BUY',
      1,
      'medium',
      1000,
      authorization,
      'jupiter_execute_swap',
      guardContext,
    );

    expect(result.data).toMatchObject({ amountOut: 1, amountIn: 10 });
    expect(quote.amountOut).toBe(1);
    expect(quote.amountIn).toBeLessThanOrEqual(quote.maxAmountIn);
    expect(quote.maxAmountIn).toBeLessThanOrEqual(10);
    expect(executeQuote).toHaveBeenCalledWith(
      'wallet',
      'mainnet-beta',
      'quote-id',
      'medium',
      1000,
      authorization,
      'jupiter_execute_swap',
      { ...guardContext, expectedNotional: authorization.notional },
    );
  });

  it('floors a high-precision authorization cap to atomic units', async () => {
    const preciseAuthorization: LiveActionAuthorization = { notional: '0.000001999999999999999999999999999999' };
    const quote = buyQuote('1');
    (quoteSwap as jest.Mock).mockResolvedValue(quote);
    (executeQuote as jest.Mock).mockResolvedValue({ status: 1, data: quote });

    await executeSwap(
      'wallet',
      'mainnet-beta',
      'SOL',
      'USDC',
      1,
      'BUY',
      1,
      'medium',
      1000,
      preciseAuthorization,
      'jupiter_execute_swap',
      guardContext,
    );

    expect(executeQuote).toHaveBeenCalledWith(
      'wallet',
      'mainnet-beta',
      'quote-id',
      'medium',
      1000,
      preciseAuthorization,
      'jupiter_execute_swap',
      { ...guardContext, expectedNotional: preciseAuthorization.notional },
    );
  });

  it.each([
    ['one atomic unit over cap despite equal display max', '10', '10000001', 'ExactOut', 6],
    ['one atomic unit over floored high-precision cap', '0.000001999999999999999999999999999999', '2', 'ExactOut', 6],
    ['zero cap', '0', '1', 'ExactOut', 6],
    ['negative cap', '-1', '1', 'ExactOut', 6],
    ['nonnumeric cap', 'invalid', '1', 'ExactOut', 6],
    ['nonfinite cap', 'Infinity', '1', 'ExactOut', 6],
    ['zero raw threshold', '10', '0', 'ExactOut', 6],
    ['negative raw threshold', '10', '-1', 'ExactOut', 6],
    ['fractional raw threshold', '10', '1.5', 'ExactOut', 6],
    ['nonnumeric raw threshold', '10', 'invalid', 'ExactOut', 6],
    ['nonfinite raw threshold', '10', 'Infinity', 'ExactOut', 6],
    ['wrong swap mode', '10', '1', 'ExactIn', 6],
    ['negative decimals', '10', '1', 'ExactOut', -1],
    ['fractional decimals', '10', '1', 'ExactOut', 1.5],
    ['nonfinite decimals', '10', '1', 'ExactOut', Infinity],
    ['nonnumeric decimals', '10', '1', 'ExactOut', '6'],
    ['decimals above supported bound', '10', '1', 'ExactOut', 19],
  ])('rejects %s', async (_label, notional, rawThreshold, swapMode, inputTokenDecimals) => {
    const rejectedAuthorization: LiveActionAuthorization = { notional };
    const quote = buyQuote(rawThreshold, swapMode, inputTokenDecimals);
    (quoteSwap as jest.Mock).mockResolvedValue(quote);

    await expect(
      executeSwap('wallet', 'mainnet-beta', 'SOL', 'USDC', 1, 'BUY', 1, undefined, undefined, rejectedAuthorization),
    ).rejects.toThrow('Jupiter exact-output quote exceeds authorized notional');
    expect(executeQuote).not.toHaveBeenCalled();
  });

  it('keeps SELL expectedNotional bound to the original amount', async () => {
    const quote = { quoteId: 'sell-quote', amountIn: 2, amountOut: 20, maxAmountIn: 2 };
    (quoteSwap as jest.Mock).mockResolvedValue(quote);
    (executeQuote as jest.Mock).mockResolvedValue({ status: 1, data: quote });

    await executeSwap(
      'wallet',
      'mainnet-beta',
      'SOL',
      'USDC',
      2,
      'SELL',
      1,
      'medium',
      1000,
      authorization,
      'jupiter_execute_swap',
      { ...guardContext, expectedNotional: 2 },
    );

    expect(executeQuote).toHaveBeenCalledWith(
      'wallet',
      'mainnet-beta',
      'sell-quote',
      'medium',
      1000,
      authorization,
      'jupiter_execute_swap',
      { ...guardContext, expectedNotional: 2 },
    );
  });
});
