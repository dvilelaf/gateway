import '../../../mocks/app-mocks';

import { Ethereum } from '../../../../src/chains/ethereum/ethereum';
import { pollEthereumTransaction } from '../../../../src/chains/ethereum/routes/poll';

jest.mock('../../../../src/chains/ethereum/ethereum');

const mockEthereum = Ethereum as jest.Mocked<typeof Ethereum>;
const transaction = {
  gasPrice: null,
  gasLimit: { toString: () => '21000' },
  value: { toString: () => '0' },
};
const mockInstance = {
  getCurrentBlockNumber: jest.fn(),
  getTransaction: jest.fn(),
  getTransactionReceipt: jest.fn(),
  provider: { getBlock: jest.fn() },
};

describe('Ethereum poll route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEthereum.getInstance.mockResolvedValue(mockInstance as any);
    mockInstance.getCurrentBlockNumber.mockResolvedValue(100);
  });

  it('returns the confirmed block timestamp in Unix seconds', async () => {
    mockInstance.getTransaction.mockResolvedValue(transaction);
    mockInstance.getTransactionReceipt.mockResolvedValue({ blockNumber: 42, status: 1, logs: [] });
    mockInstance.provider.getBlock.mockResolvedValue({ timestamp: 1_700_000_123 });

    await expect(pollEthereumTransaction({} as any, 'mainnet', '0xhash')).resolves.toMatchObject({
      txBlock: 42,
      txStatus: 1,
      blockTimestamp: 1_700_000_123,
    });
    expect(mockInstance.provider.getBlock).toHaveBeenCalledWith(42);
  });

  it('returns null for pending and not-found transactions', async () => {
    jest.useFakeTimers();
    try {
      for (const [txData, txStatus] of [
        [transaction, 0],
        [null, -1],
      ] as const) {
        mockInstance.getTransaction.mockResolvedValue(txData);
        mockInstance.getTransactionReceipt.mockResolvedValue(null);
        const result = pollEthereumTransaction({} as any, 'mainnet', '0xhash');
        await jest.runAllTimersAsync();
        await expect(result).resolves.toMatchObject({ txStatus, blockTimestamp: null });
      }
    } finally {
      jest.useRealTimers();
    }
  });
});
