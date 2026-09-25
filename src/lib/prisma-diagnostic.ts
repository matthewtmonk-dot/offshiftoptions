import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

const globalForDiagnosticPrisma = globalThis as unknown as {
  diagnosticPrisma?: PrismaClient;
};

function createDiagnosticPrismaClient() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for Prisma.");
  }

  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

export const prismaDiagnostic = globalForDiagnosticPrisma.diagnosticPrisma ?? createDiagnosticPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForDiagnosticPrisma.diagnosticPrisma = prismaDiagnostic;
}
