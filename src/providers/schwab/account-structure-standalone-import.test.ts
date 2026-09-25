import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe("standalone account-structure diagnostic import", () => {
  it("imports the DB-only list helper under the production Node runtime shape without Next-only guards", () => {
    const env = {
      ...process.env,
      NODE_ENV: "production",
      DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://user:pass@127.0.0.1:5432/test",
    };

    const output = execFileSync(
      process.execPath,
      [
        "--conditions=react-server",
        "--import",
        "tsx",
        "-e",
        "const mod = await import('./src/providers/schwab/account-structure-list.ts'); console.log('IMPORT_OK', typeof mod.listDiagnosticAccounts === 'function');",
      ],
      { cwd: repoRoot, env, encoding: "utf8" },
    );

    expect(output).toContain("IMPORT_OK true");
  });
});
