import { BigNumber, utils } from 'ethers';

import { IQuoterV2ABI } from '#src/connectors/uniswap/uniswap.contracts';

// Mock the full chain so the import of Uniswap doesn't trigger config init
jest.mock('#src/chains/ethereum/ethereum');
jest.mock('#src/connectors/uniswap/uniswap.config', () => ({
  UniswapConfig: {
    config: { availableNetworks: [], maximumHops: 4, slippagePct: 1 },
  },
}));
jest.mock('#src/services/logger', () => ({
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

const { Uniswap } = jest.requireActual<typeof import('#src/connectors/uniswap/uniswap')>(
  '#src/connectors/uniswap/uniswap',
);

describe('Uniswap V3 QuoterV2 quoteExactOutputSingle', () => {
  const canonicalSelector = '0xbd21704a';

  it('encodes the canonical tuple selector for quoteExactOutputSingle', () => {
    const iface = new utils.Interface(IQuoterV2ABI);
    const tokenIn = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
    const tokenOut = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    const encoded = iface.encodeFunctionData('quoteExactOutputSingle', [
      {
        tokenIn,
        tokenOut,
        amountOut: BigNumber.from('10000000000'),
        fee: 500,
        sqrtPriceLimitX96: 0,
      },
    ]);
    expect(encoded.slice(0, 10)).toBe(canonicalSelector);

    const canonicalSignature = 'quoteExactOutputSingle((address,address,uint256,uint24,uint160))';
    const computedSelector = utils.keccak256(utils.toUtf8Bytes(canonicalSignature)).slice(0, 10);
    expect(computedSelector).toBe(canonicalSelector);
  });

  it('encodes tuple parameter with correct field order and types', () => {
    const iface = new utils.Interface(IQuoterV2ABI);
    const tokenIn = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
    const tokenOut = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    const amountOut = BigNumber.from('10000000000');
    const fee = 3000;

    const encoded = iface.encodeFunctionData('quoteExactOutputSingle', [
      { tokenIn, tokenOut, amountOut, fee, sqrtPriceLimitX96: 0 },
    ]);
    const params = iface.decodeFunctionData('quoteExactOutputSingle', encoded)[0];

    expect(params.tokenIn).toBe(tokenIn);
    expect(params.tokenOut).toBe(tokenOut);
    expect(params.fee).toBe(fee);
    expect(params.amountOut.toString()).toBe(amountOut.toString());
    expect(params.sqrtPriceLimitX96.toString()).toBe('0');
    expect(encoded.slice(0, 10)).toBe(canonicalSelector);
  });

  it('calls callStatic.quoteExactOutputSingle with canonical tuple and returns raw amountIn', async () => {
    const mockAmountIn = BigNumber.from('1500000000000000000');
    const mockQuoter = {
      callStatic: {
        quoteExactOutputSingle: jest
          .fn()
          .mockResolvedValueOnce([mockAmountIn, BigNumber.from('0'), 0, BigNumber.from(0)]),
      },
    };

    const tokenIn = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
    const tokenOut = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    const fee = 500;
    const amountOut = BigNumber.from('10000000000');

    const result = await Uniswap.prototype.quoteExactOutputSingle.call(
      { v3Quoter: mockQuoter },
      tokenIn,
      tokenOut,
      fee,
      amountOut,
    );

    expect(result).toBe(mockAmountIn);
    expect(mockQuoter.callStatic.quoteExactOutputSingle).toHaveBeenCalledWith({
      tokenIn,
      tokenOut,
      amountOut,
      fee,
      sqrtPriceLimitX96: 0,
    });
  });

  it('rejects zero amountIn returned by the Quoter', async () => {
    const mockQuoter = {
      callStatic: {
        quoteExactOutputSingle: jest
          .fn()
          .mockResolvedValueOnce([BigNumber.from(0), BigNumber.from(0), 0, BigNumber.from(0)]),
      },
    };

    const tokenIn = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
    const tokenOut = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    const fee = 500;
    const amountOut = BigNumber.from('10000000000');

    await expect(
      Uniswap.prototype.quoteExactOutputSingle.call({ v3Quoter: mockQuoter }, tokenIn, tokenOut, fee, amountOut),
    ).rejects.toThrow('Uniswap V3 exact-output quote returned zero input');
  });

  it('propagates provider error from callStatic.quoteExactOutputSingle', async () => {
    const mockQuoter = {
      callStatic: {
        quoteExactOutputSingle: jest.fn().mockRejectedValueOnce(new Error('execution reverted: STF')),
      },
    };

    const tokenIn = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
    const tokenOut = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    const fee = 500;
    const amountOut = BigNumber.from('10000000000');

    await expect(
      Uniswap.prototype.quoteExactOutputSingle.call({ v3Quoter: mockQuoter }, tokenIn, tokenOut, fee, amountOut),
    ).rejects.toThrow('execution reverted: STF');
  });
});
