export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { startOpencodeServe } = await import("./src/utils/opencodeServeManager.js");
      const { startOpencodeQuickTunnel } = await import("./src/utils/opencodeQuickTunnel.js");
      startOpencodeServe();
      startOpencodeQuickTunnel();
    } catch (e) {
      console.warn("[instrumentation] opencode auto-start skipped:", e?.message);
    }
  }
}
