import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
  const startedAt = Date.now();

  try {
    await prisma.$queryRaw`SELECT 1`;

    return NextResponse.json({
      app: "ok",
      database: "ok",
      latencyMs: Date.now() - startedAt,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        app: "ok",
        database: "error",
        message: error instanceof Error ? error.message : "Unknown database error",
        checkedAt: new Date().toISOString(),
      },
      { status: 503 },
    );
  }
}
