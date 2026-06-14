import { BigNumber } from 'ethers';
import { FastifyInstance } from 'fastify';

import { Ethereum } from '../../../src/chains/ethereum/ethereum';
import { getEthereumBalances } from '../../../src/chains/ethereum/routes/balances';

function httpError(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

describe('Ethereum balances', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects explicitly requested tokens that are not in the token list', async () => {
    const ethereum = Object.create(Ethereum.prototype) as Ethereum;

    (ethereum as any).nativeTokenSymbol = 'ETH';
    (ethereum as any).isHardwareWallet = jest.fn().mockResolvedValue(true);
    (ethereum as any).getNativeBalanceByAddress = jest.fn().mockResolvedValue({
      value: BigNumber.from('0'),
      decimals: 18,
    });
    (ethereum as any).getToken = jest.fn().mockResolvedValue(null);

    await expect(ethereum.getBalances('0x0000000000000000000000000000000000000001', ['UNKNOWN'])).rejects.toThrow(
      'Token not recognized: UNKNOWN',
    );
  });

  it('reports explicitly unknown requested tokens as bad requests', async () => {
    jest.spyOn(Ethereum, 'getInstance').mockResolvedValue({
      getBalances: jest.fn().mockRejectedValue(new Error('Token not recognized: UNKNOWN')),
    } as any);

    const fastify = {
      httpErrors: {
        badRequest: (message: string) => httpError(message, 400),
        internalServerError: (message: string) => httpError(message, 500),
      },
    } as FastifyInstance;

    await expect(
      getEthereumBalances(fastify, 'base', '0x0000000000000000000000000000000000000001', ['UNKNOWN']),
    ).rejects.toMatchObject({
      message: 'Token not recognized: UNKNOWN',
      statusCode: 400,
    });
  });
});
