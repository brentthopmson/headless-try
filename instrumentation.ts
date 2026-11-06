export async function register() {
  console.log("[instrumentation] register() called, NEXT_RUNTIME =", process.env.NEXT_RUNTIME);
  if (process.env.NEXT_RUNTIME === "nodejs") {
    console.log("[boot] Initializing opencode + serverless integration...");
    try {
      const { startOpencodeServe } = await import("./src/utils/opencodeServeManager.js");
      const { startOpencodeQuickTunnel } = await import("./src/utils/opencodeQuickTunnel.js");
      const { startServerlessTunnel } = await import("./src/utils/serverlessTunnel.js");
      // sync password quickly (env-based) if present
      await startOpencodeServe();
      // tunnels: start/sync in background (launchers run sync-tunnels.js for blocking sync)
      startOpencodeQuickTunnel().catch(e => console.warn("[boot] opencode tunnel:", e?.message));
      startServerlessTunnel().catch(e => console.warn("[boot] serverless tunnel:", e?.message));
      console.log("[boot] Integration started (tunnel sync running in background)");
    } catch (e) {
      console.warn("[boot] integration auto-start skipped:", e?.message);
    }
  }
}
