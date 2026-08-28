import type {
  BrokerAccount,
  BrokerObservedOrder,
  BrokerPosition,
  BrokerReadProvider,
  BrokerTransaction,
} from "./types";

const accounts: BrokerAccount[] = [
  {
    id: "mock-matt-csp",
    label: "Manual CSP demo",
    accountValue: 52_640,
    cash: 31_280,
  },
];

export class MockBrokerReadProvider implements BrokerReadProvider {
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

  async getTransactions(accountId: string): Promise<BrokerTransaction[]> {
    return [
      {
        id: "mock-premium-corZ",
        accountId,
        symbol: "CORZ",
        amount: 26,
        occurredAt: new Date("2026-08-21T14:10:00Z"),
        description: "Demo premium received for CORZ cash-secured put.",
      },
    ];
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
