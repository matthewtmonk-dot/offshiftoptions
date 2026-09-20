import { NextResponse } from "next/server";
import { getBuildInfo } from "@/lib/build-info";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  const startedAt = Date.now();
  // Resolved once per request from a build-time generated file (see src/lib/build-info.ts /
  // scripts/write-build-info.mjs) - never a runtime git call, never a secret, and never fails
  // the health check even if the generated file is missing (falls back to "unknown").
  const { commit, buildTime } = getBuildInfo();

  try {
    await prisma.$queryRaw`SELECT 1`;

    return NextResponse.json({
      app: "ok",
      database: "ok",
      commit,
      buildTime,
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
        checkedAt: new Date().toISOString(),
      },
      { status: 503 },
    );
  }
}
