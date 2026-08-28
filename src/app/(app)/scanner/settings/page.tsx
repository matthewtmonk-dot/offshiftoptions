import { Save } from "lucide-react";
import { Badge, EmptyState, FieldLabel, Panel } from "@/components/ui";
import {
  getRuleDesired,
  SCANNER_RULE_DEFINITIONS,
  type ScannerRuleDefinition,
} from "@/domain/scanner/profile";
import { requireCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ensureMyLstScannerProfileForUser } from "@/lib/workflows";
import { updateScannerSettingsAction } from "../../actions";

export const dynamic = "force-dynamic";

export default async function ScannerSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const user = await requireCurrentUser();
  const params = await searchParams;
  const profile = await ensureMyLstScannerProfileForUser(user.id);
  const rules = await prisma.scannerRule.findMany({
    where: { profileId: profile.id },
    orderBy: { sortOrder: "asc" },
  });
  const rulesByKey = new Map(rules.map((rule) => [rule.key, rule]));

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-sm font-medium text-emerald-300">Editable per-user scanner settings</p>
          <h1 className="text-3xl font-semibold text-zinc-50">My LST Settings</h1>
        </div>
        <Badge tone="info">{user.name}&apos;s private profile</Badge>
      </div>

      {params.error ? (
        <div className="rounded-md border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-100">
          {params.error}
        </div>
      ) : null}
      {params.saved ? (
        <div className="rounded-md border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-sm text-emerald-100">
          Scanner settings saved.
        </div>
      ) : null}

      <form action={updateScannerSettingsAction} className="space-y-4">
        <Panel
          title="Criteria"
          action={
            <button
              type="submit"
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-emerald-400 px-4 text-sm font-semibold text-zinc-950 hover:bg-emerald-300"
            >
              <Save className="size-4" aria-hidden />
              Save Settings
            </button>
          }
        >
          <div className="grid gap-4 xl:grid-cols-2">
            {SCANNER_RULE_DEFINITIONS.map((definition) => {
              const rule = rulesByKey.get(definition.key);
              const desired = getRuleDesired(rule?.valueJson, definition.defaultDesired);
              return (
                <RuleEditor
                  key={definition.key}
                  definition={definition}
                  desired={desired}
                  enabled={rule?.enabled ?? true}
                />
              );
            })}
            {SCANNER_RULE_DEFINITIONS.length === 0 ? <EmptyState>No scanner settings are available.</EmptyState> : null}
          </div>
        </Panel>
      </form>
    </div>
  );
}

function RuleEditor({
  definition,
  desired,
  enabled,
}: {
  definition: ScannerRuleDefinition;
  desired: number | string | boolean | [number, number];
  enabled: boolean;
}) {
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-zinc-50">{definition.name}</h2>
          <p className="mt-1 text-sm text-zinc-400">{definition.explanation}</p>
        </div>
        <label className="flex min-h-10 shrink-0 items-center gap-2 rounded-md border border-zinc-700 px-3 text-sm text-zinc-300">
          <input
            type="checkbox"
            name={`${definition.key}:enabled`}
            defaultChecked={enabled}
            className="size-4 accent-emerald-400"
          />
          Enabled
        </label>
      </div>

      {definition.input.kind === "range" && Array.isArray(desired) ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <NumberField
            name={`${definition.key}:min`}
            label={definition.input.minLabel}
            defaultValue={desired[0]}
            min={definition.input.min}
            max={definition.input.max}
            step={definition.input.step}
          />
          <NumberField
            name={`${definition.key}:max`}
            label={definition.input.maxLabel}
            defaultValue={desired[1]}
            min={definition.input.min}
            max={definition.input.max}
            step={definition.input.step}
          />
        </div>
      ) : null}

      {definition.input.kind === "single" && !Array.isArray(desired) ? (
        <NumberField
          name={`${definition.key}:value`}
          label={definition.input.label}
          defaultValue={Number(desired)}
          min={definition.input.min}
          max={definition.input.max}
          step={definition.input.step}
        />
      ) : null}

      {definition.input.kind === "boolean" ? (
        <div>
          <FieldLabel>{definition.input.label}</FieldLabel>
          <p className="mt-2 text-sm text-zinc-400">Rule: candidate value must equal false.</p>
        </div>
      ) : null}
    </section>
  );
}

function NumberField({
  name,
  label,
  defaultValue,
  step,
  min,
  max,
}: {
  name: string;
  label: string;
  defaultValue: number;
  step?: string;
  min?: number;
  max?: number;
}) {
  return (
    <div className="space-y-2">
      <FieldLabel>{label}</FieldLabel>
      <input
        name={name}
        type="number"
        defaultValue={defaultValue}
        step={step}
        min={min}
        max={max}
        className="min-h-11 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-50 outline-none focus:border-emerald-400"
        required
      />
    </div>
  );
}
