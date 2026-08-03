export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Opt pi-ask into remote-only ask flows: in non-TUI mode it emits structured
  // ask events on the extension event bus (bridged to web clients by
  // lib/ask-user-bridge.ts) instead of returning the non-interactive fallback.
  process.env.PI_ASK_REMOTE_ONLY ??= "1";

  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();
}
