/** Fail fast: validate env once when the Node.js server boots. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("@/lib/server/env");
  }
}
