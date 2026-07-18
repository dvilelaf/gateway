import { FastifyInstance } from 'fastify';

import '../../../mocks/app-mocks';

import { gatewayApp } from '../../../../src/app';
import { getSolanaStatus } from '../../../../src/chains/solana/routes/status';
import { Solana } from '../../../../src/chains/solana/solana';

jest.mock('../../../../src/chains/solana/solana');

const mockSolana = Solana as jest.Mocked<typeof Solana>;

describe('Solana Status Route', () => {
  let fastify: FastifyInstance;
  const mockSolanaInstance = {
    config: {
      nodeURL: 'https://api.mainnet-beta.solana.com',
      nativeCurrencySymbol: 'SOL',
      swapProvider: 'jupiter/router',
    },
    getCurrentBlockNumber: jest.fn(),
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
    mockSolanaInstance.config.nodeURL = 'https://api.mainnet-beta.solana.com';
    mockSolana.getInstance.mockResolvedValue(mockSolanaInstance as any);
    mockSolanaInstance.getCurrentBlockNumber.mockResolvedValue(365795000);
  });

  it('reports the configured nodeURL for Solana status', async () => {
    await expect(getSolanaStatus(fastify, 'mainnet-beta')).resolves.toEqual({
      chain: 'solana',
      network: 'mainnet-beta',
      rpcUrl: 'https://api.mainnet-beta.solana.com',
      rpcProvider: 'url',
      currentBlockNumber: 365795000,
      nativeCurrency: 'SOL',
      swapProvider: 'jupiter/router',
    });
  });

  it('reports the configured nodeURL through the HTTP route', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/chains/solana/status?network=mainnet-beta',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      chain: 'solana',
      rpcUrl: 'https://api.mainnet-beta.solana.com',
      rpcProvider: 'url',
    });
  });

  it('reports the configured nodeURL for devnet', async () => {
    mockSolanaInstance.config.nodeURL = 'https://api.devnet.solana.com';

    await expect(getSolanaStatus(fastify, 'devnet')).resolves.toMatchObject({
      network: 'devnet',
      rpcUrl: 'https://api.devnet.solana.com',
      rpcProvider: 'url',
    });
  });

  it('uses the default network when the network is omitted', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/chains/solana/status',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      chain: 'solana',
      rpcUrl: 'https://api.mainnet-beta.solana.com',
      rpcProvider: 'url',
    });
  });
});
