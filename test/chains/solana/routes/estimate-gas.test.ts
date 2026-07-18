import { FastifyInstance } from 'fastify';

import '../../../mocks/app-mocks';

import { gatewayApp } from '../../../../src/app';
import { Solana } from '../../../../src/chains/solana/solana';

jest.mock('../../../../src/chains/solana/solana');

const mockSolana = Solana as jest.Mocked<typeof Solana>;

describe('Solana Estimate Gas Route', () => {
  let fastify: FastifyInstance;

  beforeAll(async () => {
    fastify = gatewayApp;
    await fastify.ready();
  });

  afterAll(async () => {
    await fastify.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the generic configured priority fee estimate', async () => {
    const instance = {
      estimateGasPrice: jest.fn().mockResolvedValue(0.5),
      config: { defaultComputeUnits: 200000 },
      nativeTokenSymbol: 'SOL',
    };
    mockSolana.getInstance.mockResolvedValue(instance as any);

    const response = await fastify.inject({
      method: 'GET',
      url: '/chains/solana/estimate-gas?network=mainnet-beta',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      feePerComputeUnit: 0.5,
      denomination: 'lamports',
      computeUnits: 200000,
      feeAsset: 'SOL',
      fee: expect.any(Number),
      timestamp: expect.any(Number),
    });
    expect(instance.estimateGasPrice).toHaveBeenCalledTimes(1);
  });

  it('falls back to the configured minimum when estimation fails', async () => {
    const instance = {
      estimateGasPrice: jest.fn().mockRejectedValue(new Error('RPC node unavailable')),
      config: { minPriorityFeePerCU: 0.25, defaultComputeUnits: 200000 },
      nativeTokenSymbol: 'SOL',
    };
    mockSolana.getInstance.mockResolvedValue(instance as any);

    const response = await fastify.inject({
      method: 'GET',
      url: '/chains/solana/estimate-gas?network=devnet',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      feePerComputeUnit: 0.25,
      denomination: 'lamports',
      computeUnits: 200000,
      feeAsset: 'SOL',
      fee: expect.any(Number),
    });
    expect(mockSolana.getInstance).toHaveBeenCalledTimes(2);
  });

  it('uses the minimum fallback default when it is not configured', async () => {
    const instance = {
      estimateGasPrice: jest.fn().mockRejectedValue(new Error('RPC node unavailable')),
      config: { defaultComputeUnits: 200000 },
      nativeTokenSymbol: 'SOL',
    };
    mockSolana.getInstance.mockResolvedValue(instance as any);

    const response = await fastify.inject({
      method: 'GET',
      url: '/chains/solana/estimate-gas?network=mainnet-beta',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ feePerComputeUnit: 0.1 });
  });
});
