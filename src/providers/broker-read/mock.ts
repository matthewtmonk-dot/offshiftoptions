import type {
  BrokerAccount,
  BrokerObservedOrder,
  BrokerPosition,
  BrokerReadProvider,
  BrokerTransaction,
  BrokerTransactionsResult,
} from "./types";

const accounts: BrokerAccount[] = [
  {
    id: "mock-matt-csp",
    label: "Manual CSP demo",
    accountValue: 52_640,
    cash: 31_280,
  },
];

export class DemoBrokerReadProvider implements BrokerReadProvider {
  async getAccounts() {
    return accounts;
  }

  async getAccount(accountId: string) {
    return accounts.find((account) => account.id === accountId) ?? null;
  }

  async getPositions(accountId: string): Promise<BrokerPosition[]> {
    return [
      {
        accountId,
        symbol: "CORZ 2026-09-18 P16.5",
        quantity: -1,
        marketValue: -5,
      },
    ];
  }

  async getTransactions(accountId: string): Promise<BrokerTransactionsResult> {
    const transactions: BrokerTransaction[] = [
      {
        id: "mock-premium-corZ",
        accountId,
        symbol: "CORZ",
        amount: 26,
        occurredAt: new Date("2026-08-21T14:10:00Z"),
        description: "Demo premium received for CORZ cash-secured put.",
      },
    ];

    return {
      transactions,
      categories: {
        TRADE: { status: "OK", count: transactions.length },
        RECEIVE_AND_DELIVER: { status: "OK", count: 0 },
        DIVIDEND_OR_INTEREST: { status: "OK", count: 0 },
      },
    };
  }

  async getOrders(accountId: string): Promise<BrokerObservedOrder[]> {
    return [
      {
        id: "mock-observed-order-corZ",
        accountId,
        symbol: "CORZ",
        status: "FILLED",
        enteredAt: new Date("2026-08-21T14:10:00Z"),
      },
    ];
  }
}

export class MockBrokerReadProvider extends DemoBrokerReadProvider {}
