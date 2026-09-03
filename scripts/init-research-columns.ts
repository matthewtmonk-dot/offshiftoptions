/**
 * One-time Research column-preference initializer for ANY user, identified by an
 * operator-supplied email address on the command line - this script has no built-in
 * knowledge of which real person that is, and neither does the application itself (the
 * Research feature is generic per-user preferences; see PROJECT_HANDOFF.md Research
 * section). Applies the one research-heavy preset this script currently offers
 * (`RESEARCH_HEAVY_COLUMN_PRESET` in src/domain/research/columns.ts).
 *
 * Dry run by default - reports what it would do and makes no changes. Add --apply to write.
 * Never overwrites a user's existing saved preference (no force flag exists; add one only
 * if a real future need for overwrite arises - don't add it speculatively).
 *
 * Usage:
 *   npx tsx scripts/init-research-columns.ts --email <email>            (dry run, reports only)
 *   npx tsx scripts/init-research-columns.ts --email <email> --apply    (writes, if safe to)
 *
 * Prints only the target's name/email and the column layout (a list of field keys like
 * "peRatio") - never a password, token, session, account number, or other secret.
 */
import { RESEARCH_HEAVY_COLUMN_PRESET } from "../src/domain/research/columns";
import { prisma } from "../src/lib/prisma";

function parseArgs(argv: string[]): { email: string | null; apply: boolean } {
  let email: string | null = null;
  let apply = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--email") {
      email = argv[i + 1] ?? null;
      i += 1;
    } else if (argv[i] === "--apply") {
      apply = true;
    }
  }
  return { email, apply };
}

async function main() {
  const { email, apply } = parseArgs(process.argv.slice(2));

  if (!email) {
    console.error("Missing required --email <address>.");
    console.error("Usage: npx tsx scripts/init-research-columns.ts --email <email> [--apply]");
    process.exitCode = 1;
    return;
  }

  const matches = await prisma.user.findMany({
    where: { email },
    select: { id: true, name: true, email: true },
  });

  if (matches.length === 0) {
    console.error(`No user found with email ${email} - nothing to do.`);
    process.exitCode = 1;
    return;
  }

  if (matches.length > 1) {
    // Defensive: User.email is a unique column, so this should be unreachable in practice -
    // but never guess which match was meant if it somehow happens.
    console.error(`${matches.length} users matched ${email} - refusing to guess which one. Aborting.`);
    process.exitCode = 1;
    return;
  }

  const user = matches[0];
  console.log("Target user:");
  console.log(`  ${user.name}`);
  console.log(`  ${user.email}`);
  console.log("");

  const existing = await prisma.userSettings.findUnique({
    where: { userId: user.id },
    select: { researchColumns: true },
  });
  const currentColumns = existing?.researchColumns ?? [];

  console.log("Current saved Research layout:");
  console.log(currentColumns.length ? `  ${currentColumns.join(", ")}` : "  none");
  console.log("");

  if (currentColumns.length > 0) {
    console.log("Existing preference found — no changes made");
    return;
  }

  console.log("Proposed Research layout:");
  console.log(`  ${RESEARCH_HEAVY_COLUMN_PRESET.join(", ")}`);
  console.log("");

  if (!apply) {
    console.log("DRY RUN — no changes made. Re-run with --apply to write this layout.");
    return;
  }

  await prisma.userSettings.upsert({
    where: { userId: user.id },
    update: { researchColumns: RESEARCH_HEAVY_COLUMN_PRESET },
    create: { userId: user.id, researchColumns: RESEARCH_HEAVY_COLUMN_PRESET },
  });

  console.log(`Applied. ${user.name} (${user.email}) now has the research-heavy Research column layout (${RESEARCH_HEAVY_COLUMN_PRESET.length} columns).`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
