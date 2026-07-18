import { FastifyInstance } from 'fastify';

import '../../../mocks/app-mocks';

import { gatewayApp } from '../../../../src/app';
import { Ethereum } from '../../../../src/chains/ethereum/ethereum';
import { getEthereumStatus } from '../../../../src/chains/ethereum/routes/status';

jest.mock('../../../../src/chains/ethereum/ethereum');

const mockEthereum = Ethereum as jest.Mocked<typeof Ethereum>;

describe('Ethereum Status Route', () => {
  let fastify: FastifyInstance;
  const mockEthereumInstance = {
    rpcUrl: 'https://eth.llamarpc.com',
    nativeTokenSymbol: 'ETH',
    swapProvider: 'uniswap/router',
    provider: {
      getBlockNumber: jest.fn(),
    },
  };

  beforeAll(async () => {
    fastify = gatewayApp;
    await fastify.ready();
  });

  afterAll(async () => {
    await fastify.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockEthereum.getInstance.mockResolvedValue(mockEthereumInstance as any);
    mockEthereumInstance.provider.getBlockNumber.mockResolvedValue(23329000);
  });

  it('reports the configured nodeURL', async () => {
    await expect(getEthereumStatus('mainnet')).resolves.toEqual({
      chain: 'ethereum',
      network: 'mainnet',
      rpcUrl: 'https://eth.llamarpc.com',
      rpcProvider: 'url',
      currentBlockNumber: 23329000,
      nativeCurrency: 'ETH',
      swapProvider: 'uniswap/router',
    });
  });

  it('returns block zero when block polling times out', async () => {
    mockEthereumInstance.provider.getBlockNumber.mockImplementation(
      () => new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out')), 100)),
    );
    const mockWarn = jest.spyOn(require('../../../../src/services/logger').logger, 'warn').mockImplementation();

    await expect(getEthereumStatus('mainnet')).resolves.toMatchObject({
      rpcUrl: 'https://eth.llamarpc.com',
      currentBlockNumber: 0,
    });

    expect(mockWarn).toHaveBeenCalledWith('Failed to get block number: Request timed out');
    mockWarn.mockRestore();
  });

  it('reports the configured nodeURL through the HTTP route', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/chains/ethereum/status?network=mainnet',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      chain: 'ethereum',
      rpcUrl: 'https://eth.llamarpc.com',
      rpcProvider: 'url',
    });
  });

  it('uses the default network when the network is omitted', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/chains/ethereum/status',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      chain: 'ethereum',
      rpcUrl: 'https://eth.llamarpc.com',
      rpcProvider: 'url',
    });
  });

  it('returns the minimal error response when status initialization fails', async () => {
    mockEthereum.getInstance.mockRejectedValue(new Error('Connection failed'));
    const mockError = jest.spyOn(require('../../../../src/services/logger').logger, 'error').mockImplementation();

    const response = await fastify.inject({
      method: 'GET',
      url: '/chains/ethereum/status?network=mainnet',
    });

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toEqual({
      chain: 'ethereum',
      network: 'mainnet',
      rpcUrl: 'unavailable',
      rpcProvider: 'unavailable',
      currentBlockNumber: 0,
      nativeCurrency: 'ETH',
      swapProvider: '',
    });
    mockError.mockRestore();
  });
});
