"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Badge, Panel } from "@/components/ui";
import { shortDateTime } from "@/lib/format";
import { runSchwabTransactionsDiagnosticAction } from "../../actions";
import type {
  OrdersDiagnosticResult,
  TransactionTypeTestResult,
  TransactionWindowResult,
  TransferItemShapesDiagnosticResult,
} from "@/lib/schwab-transactions-diagnostic";
import type { SchwabTransactionsDiagnosticResult } from "@/lib/schwab-transactions-diagnostic";

type PanelState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "done"; result: SchwabTransactionsDiagnosticResult }
  | { status: "unexpected-error" };

export function DiagnosticPanel() {
  const [state, setState] = useState<PanelState>({ status: "idle" });
  const pending = state.status === "pending";

  async function run() {
    if (pending) {
      return;
    }
    setState({ status: "pending" });
    try {
      const result = await runSchwabTransactionsDiagnosticAction();
      setState({ status: "done", result });
    } catch {
      setState({ status: "unexpected-error" });
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={run}
          disabled={pending}
          aria-describedby="schwab-transactions-diagnostic-status"
          data-testid="run-schwab-transactions-diagnostic-button"
          className="inline-flex min-h-9 w-fit items-center justify-center gap-2 rounded-md border border-sky-400/40 bg-sky-400/10 px-3 text-sm font-medium text-sky-100 transition hover:border-sky-300 hover:bg-sky-400/15 disabled:cursor-wait disabled:opacity-75"
        >
          <RefreshCw className={`size-3.5 ${pending ? "motion-safe:animate-spin" : ""}`} aria-hidden />
          {pending ? "Running…" : "Run Schwab Transaction & Order Diagnostic"}
        </button>
        <div id="schwab-transactions-diagnostic-status" aria-live="polite" className="text-xs empty:hidden">
          {pending ? <span className="text-zinc-500">Calling Schwab with your live connection…</span> : null}
          {state.status === "unexpected-error" ? (
            <span className="text-red-300">
              Diagnostic failed unexpectedly.{" "}
              <button type="button" onClick={run} className="underline underline-offset-2 hover:text-red-100">
                Retry
              </button>
            </span>
          ) : null}
        </div>
      </div>

      {state.status === "done" ? <DiagnosticResult result={state.result} onRetry={run} /> : null}
    </div>
  );
}

function DiagnosticResult({ result, onRetry }: { result: SchwabTransactionsDiagnosticResult; onRetry: () => void }) {
  if (result.status === "UNAVAILABLE") {
    return (
      <Panel title="Diagnostic Unavailable">
        <p className="text-sm text-zinc-300">{result.message}</p>
      </Panel>
    );
  }

  if (result.status === "ERROR") {
    return (
      <Panel title="Diagnostic Error">
        <p className="text-sm text-zinc-300">{result.message}</p>
        {result.statusCode ? (
          <p className="mt-2 text-xs text-zinc-500">
            Provider status: {result.statusCode}
            {result.retryAfter ? ` · retry after ${result.retryAfter}` : ""}
          </p>
        ) : null}
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 inline-flex min-h-8 items-center rounded-md border border-zinc-700 px-3 text-xs font-medium text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100"
        >
          Retry
        </button>
      </Panel>
    );
  }

  const { report } = result;

  return (
    <>
      <Panel title="Run Summary">
        <div className="flex flex-wrap gap-2">
          <Badge tone="info">Source: {report.source}</Badge>
          <Badge tone="good">Read only</Badge>
          <Badge tone="neutral">Nothing saved</Badge>
        </div>
        <p className="mt-3 text-xs text-zinc-500">Timestamp: {shortDateTime(report.timestamp)}</p>
      </Panel>

      <Panel title="Diagnostic A - Transaction Windows">
        <p className="mb-3 text-xs text-zinc-500">
          Same request the live sync makes (types={"TRADE,DIVIDEND_OR_INTEREST,RECEIVE_AND_DELIVER,CASH_IN_OR_CASH_OUT"}), for 7/30/60-day
          windows.
        </p>
        <ResultTable
          rows={report.windows}
          columns={[
            { header: "Window", render: (row: TransactionWindowResult) => `${row.days} days` },
            { header: "Status", render: (row) => <CallStatusBadge row={row} /> },
            { header: "Transactions", render: (row) => (row.status === "OK" ? String(row.transactionCount) : "—") },
            { header: "Malformed body?", render: (row) => (row.status === "OK" ? (row.malformedResponse ? "Yes" : "No") : "—") },
          ]}
        />
      </Panel>

      <Panel title="Diagnostic B - Transaction Types (30-day window)">
        <p className="mb-3 text-xs text-zinc-500">
          Tests each currently-used type value individually, plus the exact combined string the live sync sends today.
          Only values already present in the codebase - nothing invented or brute-forced.
        </p>
        <ResultTable
          rows={report.typeTests}
          columns={[
            { header: "types=", render: (row: TransactionTypeTestResult) => <code className="text-xs">{row.types}</code> },
            { header: "Status", render: (row) => <CallStatusBadge row={row} /> },
            { header: "Transactions", render: (row) => (row.status === "OK" ? String(row.transactionCount) : "—") },
          ]}
        />
      </Panel>

      <Panel title="Diagnostic C - Orders (60-day window)">
        <OrdersSummary orders={report.orders} />
      </Panel>

      <Panel title="Diagnostic D - Transfer Item Shapes (types=TRADE, 30-day window)">
        <p className="mb-3 text-xs text-zinc-500">
          Per-transaction, per-transfer-item breakdown of real TRADE transactions - shows exactly which item is the
          traded security vs. a cash/currency leg, and where instruction/positionEffect/price actually live. Never
          shows activity/transaction/order ids, account identifiers, CUSIP, or raw payload.
        </p>
        <TransferItemShapesSection transferItemShapes={report.transferItemShapes} />
      </Panel>
    </>
  );
}

function CallStatusBadge({ row }: { row: { status: "OK" | "ERROR"; httpStatus?: number; errorMessage?: string } }) {
  if (row.status === "OK") {
    return <Badge tone="good">OK</Badge>;
  }
  return (
    <span className="inline-flex flex-col gap-1">
      <Badge tone="bad">ERROR{row.httpStatus ? ` (${row.httpStatus})` : ""}</Badge>
      {row.errorMessage ? <span className="text-xs text-zinc-500">{row.errorMessage}</span> : null}
    </span>
  );
}

function OrdersSummary({ orders }: { orders: OrdersDiagnosticResult }) {
  if (orders.status === "ERROR") {
    return (
      <div className="space-y-2">
        <CallStatusBadge row={orders} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <SummaryDatum label="Orders received" value={String(orders.ordersReceived)} />
        <SummaryDatum label="Filled orders" value={String(orders.filledOrders)} />
        <SummaryDatum label="Option orders" value={String(orders.optionOrders)} />
        <SummaryDatum label="Fill legs" value={String(orders.fillLegs)} />
      </dl>
      {orders.malformedResponse ? <Badge tone="warn">Response body was not an array</Badge> : null}

      {orders.instrumentSummaries.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="min-w-[720px] w-full border-separate border-spacing-0 text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-normal text-zinc-500">
                <th className="border-b border-zinc-800 px-3 py-2 font-medium">Underlying</th>
                <th className="border-b border-zinc-800 px-3 py-2 font-medium">Put/Call</th>
                <th className="border-b border-zinc-800 px-3 py-2 font-medium">Strike</th>
                <th className="border-b border-zinc-800 px-3 py-2 font-medium">Expiration</th>
                <th className="border-b border-zinc-800 px-3 py-2 font-medium">Instruction</th>
                <th className="border-b border-zinc-800 px-3 py-2 font-medium">Qty</th>
                <th className="border-b border-zinc-800 px-3 py-2 font-medium">Fill price</th>
                <th className="border-b border-zinc-800 px-3 py-2 font-medium">Fill date</th>
              </tr>
            </thead>
            <tbody>
              {orders.instrumentSummaries.map((row, index) => (
                <tr key={index}>
                  <td className="border-b border-zinc-900 px-3 py-2">{row.underlyingSymbol ?? "—"}</td>
                  <td className="border-b border-zinc-900 px-3 py-2">{row.putCall ?? "—"}</td>
                  <td className="border-b border-zinc-900 px-3 py-2">{row.strike ?? "—"}</td>
                  <td className="border-b border-zinc-900 px-3 py-2">{row.expiration ? shortDateTime(row.expiration) : "—"}</td>
                  <td className="border-b border-zinc-900 px-3 py-2">{row.instruction ?? "—"}</td>
                  <td className="border-b border-zinc-900 px-3 py-2">{row.quantity ?? "—"}</td>
                  <td className="border-b border-zinc-900 px-3 py-2">{row.fillPrice ?? "—"}</td>
                  <td className="border-b border-zinc-900 px-3 py-2">{row.fillDate ? shortDateTime(row.fillDate) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-zinc-400">No option order legs found in this window.</p>
      )}
    </div>
  );
}

function TransferItemShapesSection({ transferItemShapes }: { transferItemShapes: TransferItemShapesDiagnosticResult }) {
  if (transferItemShapes.status === "ERROR") {
    return (
      <div className="space-y-2">
        <CallStatusBadge row={transferItemShapes} />
      </div>
    );
  }

  if (transferItemShapes.malformedResponse) {
    return <Badge tone="warn">Response body was not an array</Badge>;
  }

  if (transferItemShapes.transactions.length === 0) {
    return <p className="text-sm text-zinc-400">No TRADE transactions found in this window.</p>;
  }

  return (
    <div className="space-y-4">
      {transferItemShapes.transactions.map((transaction) => (
        <div key={transaction.transactionOrdinal} className="rounded-md border border-zinc-800 p-3">
          <p className="mb-2 text-xs font-medium uppercase tracking-normal text-zinc-500">
            Transaction #{transaction.transactionOrdinal} · type: {transaction.transactionType ?? "—"}
          </p>
          <div className="overflow-x-auto">
            <table className="min-w-[900px] w-full border-separate border-spacing-0 text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-normal text-zinc-500">
                  <th className="border-b border-zinc-800 px-3 py-2 font-medium">Item #</th>
                  <th className="border-b border-zinc-800 px-3 py-2 font-medium">Asset type</th>
                  <th className="border-b border-zinc-800 px-3 py-2 font-medium">Instrument type</th>
                  <th className="border-b border-zinc-800 px-3 py-2 font-medium">Symbol</th>
                  <th className="border-b border-zinc-800 px-3 py-2 font-medium">Put/Call</th>
                  <th className="border-b border-zinc-800 px-3 py-2 font-medium">Strike</th>
                  <th className="border-b border-zinc-800 px-3 py-2 font-medium">Expiration</th>
                  <th className="border-b border-zinc-800 px-3 py-2 font-medium">Instruction</th>
                  <th className="border-b border-zinc-800 px-3 py-2 font-medium">Position effect</th>
                  <th className="border-b border-zinc-800 px-3 py-2 font-medium">Amount</th>
                  <th className="border-b border-zinc-800 px-3 py-2 font-medium">Price</th>
                  <th className="border-b border-zinc-800 px-3 py-2 font-medium">Fee item?</th>
                </tr>
              </thead>
              <tbody>
                {transaction.transferItems.map((item) => (
                  <tr key={item.transferItemIndex}>
                    <td className="border-b border-zinc-900 px-3 py-2">{item.transferItemIndex}</td>
                    <td className="border-b border-zinc-900 px-3 py-2">{item.assetType ?? "—"}</td>
                    <td className="border-b border-zinc-900 px-3 py-2">{item.instrumentType ?? "—"}</td>
                    <td className="border-b border-zinc-900 px-3 py-2">{item.symbolDescriptor ?? "—"}</td>
                    <td className="border-b border-zinc-900 px-3 py-2">{item.putCall ?? "—"}</td>
                    <td className="border-b border-zinc-900 px-3 py-2">{item.strike ?? "—"}</td>
                    <td className="border-b border-zinc-900 px-3 py-2">{item.expiration ? shortDateTime(item.expiration) : "—"}</td>
                    <td className="border-b border-zinc-900 px-3 py-2">{item.instruction ?? "—"}</td>
                    <td className="border-b border-zinc-900 px-3 py-2">{item.positionEffect ?? "—"}</td>
                    <td className="border-b border-zinc-900 px-3 py-2">{item.amount ?? "—"}</td>
                    <td className="border-b border-zinc-900 px-3 py-2">{item.price ?? "—"}</td>
                    <td className="border-b border-zinc-900 px-3 py-2">{item.hasFeeType ? "Yes" : "No"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

function ResultTable<T>({
  rows,
  columns,
}: {
  rows: T[];
  columns: { header: string; render: (row: T) => React.ReactNode }[];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-[600px] w-full border-separate border-spacing-0 text-left text-sm">
        <thead>
          <tr className="text-xs uppercase tracking-normal text-zinc-500">
            {columns.map((column) => (
              <th key={column.header} className="border-b border-zinc-800 px-3 py-2 font-medium">
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => (
                <td key={column.header} className="border-b border-zinc-900 px-3 py-2">
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SummaryDatum({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-normal text-zinc-500">{label}</dt>
      <dd className="mt-1 break-words font-medium text-zinc-100">{value}</dd>
    </div>
  );
}
