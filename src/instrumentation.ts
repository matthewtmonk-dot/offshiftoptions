import type { Instrumentation } from "next";

/**
 * Next.js calls register() once when the server process starts and onRequestError() whenever it catches
 * an unexpected error on the server. Both only feed the self-service diagnostics log (src/lib/diagnostics.ts,
 * read at /account/diagnostics). Node-runtime only - the log writes to disk.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { installProcessDiagnostics } = await import("./lib/diagnostics");
    installProcessDiagnostics();
  }
}

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { recordDiagnostic } = await import("./lib/diagnostics");
  const digest = typeof error === "object" && error !== null && "digest" in error ? String((error as { digest: unknown }).digest) : undefined;
  const path = request.path.split("?")[0];
  recordDiagnostic({
    kind: "error",
    source: `${context.routeType} ${request.method} ${path}`,
    message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    digest,
  });
};
