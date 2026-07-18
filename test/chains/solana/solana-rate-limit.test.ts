import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Connection, PublicKey } from '@solana/web3.js';

jest.mock('../../../src/services/logger', () => ({
  logger: {
    error: jest.fn(),
  },
}));

import { createRateLimitAwareSolanaConnection } from '../../../src/rpc/rpc-connection-interceptor';

describe('Solana Rate Limit Interceptor', () => {
  let mockConnection: jest.Mocked<Connection>;
  let wrappedConnection: Connection;
  const testRpcUrl = 'https://api.mainnet-beta.solana.com';

  beforeEach(() => {
    // Create a mock Connection
    mockConnection = {
      getBalance: jest.fn(),
      getTokenAccountsByOwner: jest.fn(),
      getParsedTokenAccountsByOwner: jest.fn(),
      getSignatureStatuses: jest.fn(),
      getTransaction: jest.fn(),
      getBlockHeight: jest.fn(),
      sendRawTransaction: jest.fn(),
      getSignatureStatus: jest.fn(),
    } as any;

    wrappedConnection = createRateLimitAwareSolanaConnection(mockConnection, testRpcUrl);
  });

  describe('429 Error Detection', () => {
    it('should detect 429 error with statusCode property', async () => {
      const error429 = new Error('Too many requests');
      (error429 as any).statusCode = 429;

      mockConnection.getBalance.mockRejectedValue(error429);

      await expect(
        wrappedConnection.getBalance(new PublicKey('11111111111111111111111111111112')),
      ).rejects.toMatchObject({
        statusCode: 429,
        name: 'TooManyRequestsError',
        message: expect.stringContaining('Solana RPC rate limit exceeded'),
      });
    });

    it('should detect 429 error with code property', async () => {
      const error429 = new Error('Rate limit');
      (error429 as any).code = 429;

      mockConnection.getBalance.mockRejectedValue(error429);

      await expect(
        wrappedConnection.getBalance(new PublicKey('11111111111111111111111111111112')),
      ).rejects.toMatchObject({
        statusCode: 429,
        name: 'TooManyRequestsError',
      });
    });

    it('should detect 429 error in error message', async () => {
      const error429 = new Error('429 Too Many Requests: {"jsonrpc":"2.0","error":{"code": 429}}');

      mockConnection.getBalance.mockRejectedValue(error429);

      await expect(
        wrappedConnection.getBalance(new PublicKey('11111111111111111111111111111112')),
      ).rejects.toMatchObject({
        statusCode: 429,
        name: 'TooManyRequestsError',
      });
    });

    it('should detect "too many requests" in error message (case insensitive)', async () => {
      const error429 = new Error('Too Many Requests for a specific RPC call');

      mockConnection.getBalance.mockRejectedValue(error429);

      await expect(
        wrappedConnection.getBalance(new PublicKey('11111111111111111111111111111112')),
      ).rejects.toMatchObject({
        statusCode: 429,
        name: 'TooManyRequestsError',
      });
    });

    it('should detect 429 in JSON error response', async () => {
      const error429 = new Error(
        'RPC Error: {"jsonrpc":"2.0","error":{"code": 429, "message":"Too many requests for a specific RPC call"}}',
      );

      mockConnection.getBalance.mockRejectedValue(error429);

      await expect(
        wrappedConnection.getBalance(new PublicKey('11111111111111111111111111111112')),
      ).rejects.toMatchObject({
        statusCode: 429,
        name: 'TooManyRequestsError',
      });
    });
  });

  describe('Error Message Content', () => {
    it('should include RPC URL in error message', async () => {
      const error429 = new Error('Too many requests');
      (error429 as any).statusCode = 429;

      mockConnection.getBalance.mockRejectedValue(error429);

      await expect(
        wrappedConnection.getBalance(new PublicKey('11111111111111111111111111111112')),
      ).rejects.toMatchObject({
        message: expect.stringContaining(testRpcUrl),
      });
    });

    it('should include helpful error message with fix instructions', async () => {
      const error429 = new Error('Too many requests');
      (error429 as any).statusCode = 429;

      mockConnection.getBalance.mockRejectedValue(error429);

      await expect(
        wrappedConnection.getBalance(new PublicKey('11111111111111111111111111111112')),
      ).rejects.toMatchObject({
        statusCode: 429,
        message: expect.stringContaining('rate limit'),
      });
    });
  });

  describe('Non-429 Errors', () => {
    it('should pass through non-rate-limit errors unchanged', async () => {
      const networkError = new Error('Network connection failed');

      mockConnection.getBalance.mockRejectedValue(networkError);

      await expect(wrappedConnection.getBalance(new PublicKey('11111111111111111111111111111112'))).rejects.toThrow(
        'Network connection failed',
      );
    });

    it('should not modify successful responses', async () => {
      const balance = 1000000000; // 1 SOL in lamports
      mockConnection.getBalance.mockResolvedValue(balance);

      const result = await wrappedConnection.getBalance(new PublicKey('11111111111111111111111111111112'));

      expect(result).toBe(balance);
    });
  });

  describe('getTokenAccountsByOwner pacing', () => {
    const publicKey = new PublicKey('11111111111111111111111111111112');
    const legacyFilter = { programId: TOKEN_PROGRAM_ID };
    const token2022Filter = { programId: TOKEN_2022_PROGRAM_ID };
    const emptyResult = { context: { slot: 0 }, value: [] } as any;
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('spaces concurrent calls by at least 1000ms without delaying other methods', async () => {
      const tokenCallTimes: number[] = [];
      const balanceCallTimes: number[] = [];
      const legacyResult = { context: { slot: 1 }, value: [] } as any;
      const token2022Result = { context: { slot: 2 }, value: [] } as any;
      mockConnection.getTokenAccountsByOwner.mockImplementation(async () => {
        tokenCallTimes.push(Date.now());
        return tokenCallTimes.length === 1 ? legacyResult : token2022Result;
      });
      mockConnection.getBalance.mockImplementation(async () => {
        balanceCallTimes.push(Date.now());
        return 1000000000;
      });
      const firstTokenCall = wrappedConnection.getTokenAccountsByOwner(publicKey, legacyFilter);
      const secondTokenCall = wrappedConnection.getTokenAccountsByOwner(publicKey, token2022Filter);
      const unrelatedCall = wrappedConnection.getBalance(publicKey);
      await Promise.resolve();

      expect(tokenCallTimes).toHaveLength(1);
      expect(balanceCallTimes).toEqual([tokenCallTimes[0]]);
      await jest.advanceTimersByTimeAsync(999);
      expect(tokenCallTimes).toHaveLength(1);

      await jest.advanceTimersByTimeAsync(1);
      await Promise.all([firstTokenCall, secondTokenCall, unrelatedCall]);
      expect(tokenCallTimes).toHaveLength(2);
      expect(tokenCallTimes[1] - tokenCallTimes[0]).toBeGreaterThanOrEqual(1000);
      await expect(Promise.all([firstTokenCall, secondTokenCall])).resolves.toEqual([legacyResult, token2022Result]);
    });

    it('preserves non-429 rejection identity for a queued call', async () => {
      const networkError = new Error('Network connection failed');
      mockConnection.getTokenAccountsByOwner.mockResolvedValueOnce(emptyResult).mockRejectedValueOnce(networkError);
      const firstCall = wrappedConnection.getTokenAccountsByOwner(publicKey, legacyFilter);
      const secondCall = wrappedConnection.getTokenAccountsByOwner(publicKey, token2022Filter);
      const rejection = expect(secondCall).rejects.toBe(networkError);
      await jest.advanceTimersByTimeAsync(1000);
      await Promise.all([firstCall, rejection]);
    });

    it('paces from actual starts after delayed timers', async () => {
      const callTimes: number[] = [];
      mockConnection.getTokenAccountsByOwner.mockImplementation(async () => {
        callTimes.push(Date.now());
        return emptyResult;
      });

      const calls = [
        wrappedConnection.getTokenAccountsByOwner(publicKey, legacyFilter),
        wrappedConnection.getTokenAccountsByOwner(publicKey, token2022Filter),
        wrappedConnection.getTokenAccountsByOwner(publicKey, legacyFilter),
      ];
      await Promise.resolve();

      jest.setSystemTime(callTimes[0] + 3000);
      await jest.runOnlyPendingTimersAsync();
      expect(callTimes).toHaveLength(2);

      await jest.advanceTimersByTimeAsync(999);
      expect(callTimes).toHaveLength(2);
      await jest.advanceTimersByTimeAsync(1);
      await Promise.all(calls);
      expect(callTimes[2] - callTimes[1]).toBeGreaterThanOrEqual(1000);
    });

    it('does not share pacing between wrapped connections', async () => {
      const otherConnection = { getTokenAccountsByOwner: jest.fn().mockResolvedValue(emptyResult) } as any;
      const otherWrappedConnection = createRateLimitAwareSolanaConnection(otherConnection, testRpcUrl);
      mockConnection.getTokenAccountsByOwner.mockResolvedValue(emptyResult);

      const firstCall = wrappedConnection.getTokenAccountsByOwner(publicKey, legacyFilter);
      const queuedCall = wrappedConnection.getTokenAccountsByOwner(publicKey, token2022Filter);
      const independentCall = otherWrappedConnection.getTokenAccountsByOwner(publicKey, legacyFilter);
      await Promise.resolve();

      expect(mockConnection.getTokenAccountsByOwner).toHaveBeenCalledTimes(1);
      expect(otherConnection.getTokenAccountsByOwner).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(1000);
      await Promise.all([firstCall, queuedCall, independentCall]);
    });
  });

  describe('Different Connection Methods', () => {
    it('should intercept getParsedTokenAccountsByOwner', async () => {
      const error429 = new Error('Too many requests');
      (error429 as any).statusCode = 429;

      mockConnection.getParsedTokenAccountsByOwner.mockRejectedValue(error429);

      await expect(
        wrappedConnection.getParsedTokenAccountsByOwner(new PublicKey('11111111111111111111111111111112'), {
          programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
        }),
      ).rejects.toMatchObject({
        statusCode: 429,
      });
    });

    it('should intercept getSignatureStatuses', async () => {
      const error429 = new Error('Too many requests');
      (error429 as any).statusCode = 429;

      mockConnection.getSignatureStatuses.mockRejectedValue(error429);

      await expect(wrappedConnection.getSignatureStatuses(['signature123'])).rejects.toMatchObject({
        statusCode: 429,
      });
    });

    it('should intercept getTransaction', async () => {
      const error429 = new Error('Too many requests');
      (error429 as any).statusCode = 429;

      mockConnection.getTransaction.mockRejectedValue(error429);

      await expect(
        wrappedConnection.getTransaction('signature123', {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        }),
      ).rejects.toMatchObject({
        statusCode: 429,
      });
    });

    it('should intercept sendRawTransaction', async () => {
      const error429 = new Error('Too many requests');
      (error429 as any).statusCode = 429;

      mockConnection.sendRawTransaction.mockRejectedValue(error429);

      await expect(wrappedConnection.sendRawTransaction(Buffer.from([]))).rejects.toMatchObject({
        statusCode: 429,
      });
    });
  });

  describe('Property Access', () => {
    it('should allow access to non-function properties', () => {
      (mockConnection as any).commitment = 'confirmed';

      expect((wrappedConnection as any).commitment).toBe('confirmed');
    });

    it('should allow method binding', async () => {
      mockConnection.getBalance.mockResolvedValue(1000000000);

      const getBalance = wrappedConnection.getBalance.bind(wrappedConnection);
      const result = await getBalance(new PublicKey('11111111111111111111111111111112'));

      expect(result).toBe(1000000000);
    });
  });
});
