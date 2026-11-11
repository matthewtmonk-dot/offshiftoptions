import { NextResponse } from "next/server";
import { getBuildInfo } from "@/lib/build-info";
import { prisma } from "@/lib/prisma";
import { runtimeConfigReport } from "@/lib/runtime-config";

export const dynamic = "force-dynamic";

export async function GET() {
  const startedAt = Date.now();
  // Resolved once per request from a build-time generated file (see src/lib/build-info.ts /
  // scripts/write-build-info.mjs) - never a runtime git call, never a secret, and never fails
  // the health check even if the generated file is missing (falls back to "unknown").
  const { commit, buildTime } = getBuildInfo();
  // Names of expected settings the running process cannot see (never values) - see runtime-config.ts.
  const config = runtimeConfigReport();

  try {
    await prisma.$queryRaw`SELECT 1`;

    return NextResponse.json({
      app: "ok",
      database: "ok",
      commit,
      buildTime,
      config,
      latencyMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Health check database query failed:", error);
    return NextResponse.json(
      {
        app: "ok",
        database: "error",
        commit,
        buildTime,
        config,
        checkedAt: new Date().toISOString(),
      },
      { status: 503 },
    );
  }
}
