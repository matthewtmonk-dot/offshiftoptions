export type BrokerAccount = {
  id: string;
  label: string;
  accountValue: number;
  cash: number;
};

export type BrokerPosition = {
  accountId: string;
  symbol: string;
  quantity: number;
  marketValue: number;
};

export type BrokerTransaction = {
  id: string;
  accountId: string;
  symbol?: string;
  amount: number;
  occurredAt: Date;
  description: string;
};

export type BrokerObservedOrder = {
  id: string;
  accountId: string;
  symbol?: string;
  status: string;
  enteredAt: Date;
};

export interface BrokerReadProvider {
  getAccounts(): Promise<BrokerAccount[]>;
  getAccount(accountId: string): Promise<BrokerAccount | null>;
  getPositions(accountId: string): Promise<BrokerPosition[]>;
  getTransactions(accountId: string, from: Date, to: Date): Promise<BrokerTransaction[]>;
  getOrders(accountId: string, from: Date, to: Date): Promise<BrokerObservedOrder[]>;
}
