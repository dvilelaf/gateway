import { FastifyInstance } from 'fastify';

import '../../mocks/app-mocks';

jest.mock(
  'hummingbot-aerodrome-gateway-connector/gateway-adapter',
  () => {
    const error: any = new Error("Cannot find module 'hummingbot-aerodrome-gateway-connector/gateway-adapter'");
    error.code = 'MODULE_NOT_FOUND';
    throw error;
  },
  { virtual: true },
);

jest.mock(
  'hummingbot-aerodrome-gateway-connector/liquidity',
  () => {
    const error: any = new Error("Cannot find module 'hummingbot-aerodrome-gateway-connector/liquidity'");
    error.code = 'MODULE_NOT_FOUND';
    throw error;
  },
  { virtual: true },
);

import { gatewayApp } from '../../../src/app';

describe('Aerodrome Routes', () => {
  let fastify: FastifyInstance;

  beforeAll(async () => {
    fastify = gatewayApp;
    await fastify.ready();
  });

  afterAll(async () => {
    await fastify.close();
  });

  it('registers Aerodrome in connector discovery', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/config/connectors',
    });

    expect(response.statusCode).toBe(200);
    const data = JSON.parse(response.body);
    const aerodrome = data.connectors.find((connector: any) => connector.name === 'aerodrome');

    expect(aerodrome).toMatchObject({
      name: 'aerodrome',
      trading_types: ['router'],
      chain: 'ethereum',
      networks: ['base'],
    });
  });

  it('registers Aerodrome router routes even when the optional package is absent', async () => {
    const quote = await fastify.inject({
      method: 'GET',
      url: '/connectors/aerodrome/router/quote-swap?network=base&baseToken=WETH&quoteToken=USDC&amount=1&side=SELL',
    });
    const executeSwap = await fastify.inject({
      method: 'POST',
      url: '/connectors/aerodrome/router/execute-swap',
      payload: {
        network: 'base',
        walletAddress: '0x1111111111111111111111111111111111111111',
        baseToken: 'WETH',
        quoteToken: 'USDC',
        amount: 1,
        side: 'SELL',
      },
    });
    const executeQuote = await fastify.inject({
      method: 'POST',
      url: '/connectors/aerodrome/router/execute-quote',
      payload: {
        network: 'base',
        walletAddress: '0x1111111111111111111111111111111111111111',
        quoteId: 'quote-1',
      },
    });
    const addLiquidity = await fastify.inject({
      method: 'POST',
      url: '/connectors/aerodrome/router/add-liquidity',
      payload: {
        network: 'base',
        walletAddress: '0x1111111111111111111111111111111111111111',
        tokenA: 'WETH',
        tokenB: 'USDC',
        amountA: '0.01',
        amountB: '30',
        poolType: 'volatile',
      },
    });
    const removeLiquidity = await fastify.inject({
      method: 'POST',
      url: '/connectors/aerodrome/router/remove-liquidity',
      payload: {
        network: 'base',
        walletAddress: '0x1111111111111111111111111111111111111111',
        tokenA: 'WETH',
        tokenB: 'USDC',
        liquidity: '0.01',
        poolType: 'volatile',
      },
    });

    expect(quote.statusCode).not.toBe(404);
    expect(executeSwap.statusCode).not.toBe(404);
    expect(executeQuote.statusCode).not.toBe(404);
    expect(addLiquidity.statusCode).not.toBe(404);
    expect(removeLiquidity.statusCode).not.toBe(404);
  });

  it('fails quote closed with 503 when the optional package is absent', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/connectors/aerodrome/router/quote-swap?network=base&baseToken=WETH&quoteToken=USDC&amount=1&side=SELL',
    });

    expect(response.statusCode).toBe(503);
    const body = JSON.parse(response.body);
    expect(body.message).toContain('hummingbot-aerodrome-gateway-connector');
  });

  it('fails execution closed with 503 when the optional package is absent', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/connectors/aerodrome/router/execute-swap',
      payload: {
        network: 'base',
        walletAddress: '0x1111111111111111111111111111111111111111',
        baseToken: 'WETH',
        quoteToken: 'USDC',
        amount: 1,
        side: 'SELL',
      },
    });

    expect(response.statusCode).toBe(503);
    const body = JSON.parse(response.body);
    expect(body.message).toContain('hummingbot-aerodrome-gateway-connector');
  });

  it('fails liquidity routes closed with 503 when the optional package is absent', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/connectors/aerodrome/router/add-liquidity',
      payload: {
        network: 'base',
        walletAddress: '0x1111111111111111111111111111111111111111',
        tokenA: 'WETH',
        tokenB: 'USDC',
        amountA: '0.01',
        amountB: '30',
        poolType: 'volatile',
      },
    });

    expect(response.statusCode).toBe(503);
    const body = JSON.parse(response.body);
    expect(body.message).toContain('hummingbot-aerodrome-gateway-connector');
  });
});
