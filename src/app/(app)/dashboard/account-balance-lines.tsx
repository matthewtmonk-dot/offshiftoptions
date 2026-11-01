"use client";

import { useEffect, useState } from "react";
import { InfoTip } from "@/components/info-tip";
import type { TradingCapital } from "@/lib/portfolio-plan";
import { getTradingCapitalAction } from "../actions";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/**
 * The two other numbers thinkorswim shows next to Net Liq, in plain English, read live from Schwab. Loaded after the
 * page appears so a slow Schwab answer never delays the Dashboard; if Schwab can't be reached the lines say so.
 */
export function AccountBalanceLines() {
  const [capital, setCapital] = useState<TradingCapital | "loading">("loading");

  useEffect(() => {
    let active = true;
    getTradingCapitalAction()
      .then((result) => {
        if (active) setCapital(result);
      })
      .catch(() => {
        if (active) setCapital({ ok: false, message: "Could not reach Schwab." });
      });
    return () => {
      active = false;
    };
  }, []);

  if (capital !== "loading" && !capital.ok) {
    return <div className="text-xs text-zinc-500">Cash details unavailable right now.</div>;
  }
  const ok = capital !== "loading" ? capital : null;

  return (
    <div className="space-y-1" data-testid="account-balance-lines">
      <BalanceLine
        label="Available to trade"
        thinkorswim="Option Buying Power"
        value={ok ? usd.format(ok.availableToTrade) : null}
        help={'Cash you can use right now to sell new cash-secured puts. Schwab already holds back the money that backs your open puts, so this is what is actually free. Thinkorswim calls this “Option Buying Power.”'}
      />
      <BalanceLine
        label="Cash in account"
        thinkorswim="Cash & Sweep Vehicle"
        value={ok && ok.cashBalance !== null ? usd.format(ok.cashBalance) : ok ? "-" : null}
        help={'All the cash sitting in the account, including the part Schwab is holding to back your open puts, so it is more than you can spend. Thinkorswim calls this “Cash & Sweep Vehicle.”'}
      />
    </div>
  );
}

function BalanceLine({ label, thinkorswim, value, help }: { label: string; thinkorswim: string; value: string | null; help: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-[13px]">
      <span className="inline-flex items-center gap-0.5 text-zinc-400">
        {label}
        <InfoTip label={label} align="start">{help}</InfoTip>
        <span className="hidden text-[11px] text-zinc-600 sm:inline">({thinkorswim})</span>
      </span>
      <span className="font-medium tabular-nums text-zinc-200">{value ?? "…"}</span>
    </div>
  );
}
