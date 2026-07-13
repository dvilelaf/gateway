import { BigNumber, utils } from 'ethers';

import { IQuoterV2ABI } from '#src/connectors/uniswap/uniswap.contracts';

describe('Uniswap V3 QuoterV2 quoteExactInputSingle tuple ABI', () => {
  const canonicalSelector = '0xc6a5026a';

  it('encodes the canonical tuple selector for quoteExactInputSingle', () => {
    const iface = new utils.Interface(IQuoterV2ABI);
    const tokenIn = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
    const tokenOut = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
    const encoded = iface.encodeFunctionData('quoteExactInputSingle', [
      {
        tokenIn,
        tokenOut,
        amountIn: BigNumber.from('1250000000000000000'),
        fee: 500,
        sqrtPriceLimitX96: 0,
      },
    ]);
    expect(encoded.slice(0, 10)).toBe(canonicalSelector);

    const canonicalSignature = 'quoteExactInputSingle((address,address,uint256,uint24,uint160))';
    const computedSelector = utils.keccak256(utils.toUtf8Bytes(canonicalSignature)).slice(0, 10);
    expect(computedSelector).toBe(canonicalSelector);
  });

  it('encodes a tuple parameter with the correct field order and types', () => {
    const iface = new utils.Interface(IQuoterV2ABI);
    const tokenIn = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
    const tokenOut = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
    const amountIn = BigNumber.from('1250000000000000000');
    const fee = 500;

    const encoded = iface.encodeFunctionData('quoteExactInputSingle', [
      { tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0 },
    ]);
    const params = iface.decodeFunctionData('quoteExactInputSingle', encoded)[0];

    expect(params.tokenIn).toBe(tokenIn);
    expect(params.tokenOut).toBe(tokenOut);
    expect(params.fee).toBe(fee);
    expect(params.amountIn.toString()).toBe(amountIn.toString());
    expect(params.sqrtPriceLimitX96.toString()).toBe('0');
    expect(encoded.slice(0, 10)).toBe(canonicalSelector);
  });
});
