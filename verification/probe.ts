/**
 * Verification-ladder probe extension (see verification/README.md).
 *
 * Drives ONE slate-initiated model switch through a chosen copy of
 * extension/model-default.ts, with controllable injections around it, so the
 * rungs that need a deterministic window (write failure, lock contention,
 * third-party writes, write-queue depth) can have one. It calls the REAL
 * withGlobalModelDefaultRestored with the REAL pi and ctx around a REAL
 * pi.setModel: only the CALLER differs from the two shipped switch sites
 * (extension/failover.ts and extension/handoff.ts), which is what lets the
 * injections be placed exactly.
 *
 * NOT part of the shipped package: package.json's `files` whitelist excludes
 * verification/, and nothing in extension/ imports this.
 *
 * Driven entirely by environment, so one file serves every rung:
 *   PROBE_MODULE  absolute path to the model-default.ts to exercise (the repo's
 *                 own, or a deliberately weakened copy for teeth-proving)
 *   PROBE_TARGET  "provider/id" to switch to (default probe-c/gamma-1)
 *   PROBE_QUEUE   settings writes enqueued synchronously before setModel, to
 *                 build pi's write-queue depth. When > 0 the probe does NOT
 *                 wait for pi's write to land — that wait is exactly what made
 *                 an earlier ladder unable to detect a weakened yield.
 *   PROBE_INJECT  none | chmod | chmod-transient:<ms> | lock | patch:<json>
 *   PROBE_RESULT  path for a JSON result blob (elapsed ms, live model/level,
 *                 raw before/after), consumed by the driver's assertions
 */
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
const AG = process.env.PI_CODING_AGENT_DIR!;
const SETTINGS = join(AG, "settings.json");
const MODULE = process.env.PROBE_MODULE!;
const TARGET = process.env.PROBE_TARGET ?? "probe-c/gamma-1";
const QUEUE = Number(process.env.PROBE_QUEUE ?? "0");
const INJECT = process.env.PROBE_INJECT ?? "none";
const RESULT = process.env.PROBE_RESULT;
const log = (...a: unknown[]) => console.error("[PROBE]", ...a);
function raw(): string { try { return readFileSync(SETTINGS, "utf8"); } catch (e) { return "UNREADABLE " + String(e); } }
function snap(): string { try { const j = JSON.parse(raw()); return `${j.defaultProvider}/${j.defaultModel}:${j.defaultThinkingLevel}`; } catch { return "UNPARSEABLE"; } }
function pairOnDisk(): string { try { const j = JSON.parse(raw()); return `${j.defaultProvider}/${j.defaultModel}`; } catch { return "UNPARSEABLE"; } }
async function waitForDisk(expectPair: string, budgetMs = 2000): Promise<boolean> {
  const t = Date.now();
  while (Date.now() - t < budgetMs) { if (pairOnDisk() === expectPair) return true; await new Promise((r) => setTimeout(r, 2)); }
  return false;
}
function applyPatch(patchJson: string): void {
  const patch = JSON.parse(patchJson) as Record<string, unknown>;
  const cur = JSON.parse(raw()) as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) { if (v === null) delete cur[k]; else cur[k] = v; }
  writeFileSync(SETTINGS, JSON.stringify(cur, null, 2));
}
export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_e, ctx) => {
    const mod = (await import(MODULE)) as { withGlobalModelDefaultRestored: (
      pi: unknown, ctx: unknown, config: unknown, target: { provider: string; id: string },
      performSwitch: () => Promise<unknown>, mayHavePersisted?: (r: unknown) => boolean) => Promise<unknown>; };
    const slash = TARGET.indexOf("/");
    const target = ctx.modelRegistry.find(TARGET.slice(0, slash), TARGET.slice(slash + 1));
    if (!target) { log("NO TARGET", TARGET); return; }
    const before = raw();
    log("module   =", MODULE);
    log("target   =", TARGET, "| queue =", QUEUE, "| inject =", INJECT);
    log("settings before =", snap());
    const t0 = Date.now();
    let sawPendingWrite: boolean | undefined;
    await mod.withGlobalModelDefaultRestored(pi, ctx, {}, { provider: target.provider, id: target.id }, async () => {
      if (QUEUE > 0) {
        const a = pi.getThinkingLevel();
        const b = a === "low" ? "medium" : "low";
        for (let i = 0; i < QUEUE; i++) pi.setThinkingLevel((i % 2 === 0 ? b : a) as never);
        log("enqueued", QUEUE, "settings writes @", Date.now() - t0, "ms | on disk =", snap());
      }
      const ok = await pi.setModel(target);
      sawPendingWrite = pairOnDisk() !== `${target.provider}/${target.id}`;
      log("setModel =", ok, "@", Date.now() - t0, "ms | on disk =", snap(), "| pi write still pending =", sawPendingWrite);
      if (INJECT !== "none" && QUEUE === 0) {
        const landed = await waitForDisk(`${target.provider}/${target.id}`);
        log("pi write landed =", landed, "@", Date.now() - t0, "ms | on disk =", snap());
      }
      if (INJECT === "chmod") { chmodSync(SETTINGS, 0o444); log("INJECT chmod 444 @", Date.now() - t0, "ms"); }
      else if (INJECT.startsWith("chmod-transient:")) {
        const ms = Number(INJECT.slice("chmod-transient:".length));
        chmodSync(SETTINGS, 0o444); log("INJECT chmod 444 (transient", ms, "ms) @", Date.now() - t0, "ms");
        setTimeout(() => { try { chmodSync(SETTINGS, 0o644); log("INJECT chmod 644 restored @", Date.now() - t0, "ms"); } catch (e) { log("restore failed", String(e)); } }, ms);
      }
      else if (INJECT === "lock") { mkdirSync(SETTINGS + ".lock"); log("INJECT lock grabbed @", Date.now() - t0, "ms"); }
      else if (INJECT.startsWith("patch:")) { applyPatch(INJECT.slice("patch:".length)); log("INJECT third-party patch @", Date.now() - t0, "ms | on disk =", snap()); }
      return ok;
    });
    const elapsed = Date.now() - t0;
    log("wrapper returned @", elapsed, "ms | settings after =", snap());
    try { chmodSync(SETTINGS, 0o644); } catch {}
    try { rmSync(SETTINGS + ".lock", { recursive: true, force: true }); } catch {}
    if (RESULT) writeFileSync(RESULT, JSON.stringify({ module: MODULE, target: TARGET, queue: QUEUE, inject: INJECT,
      elapsedMs: elapsed, piWriteStillPendingAfterSetModel: sawPendingWrite,
      liveModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null, liveThinking: pi.getThinkingLevel(),
      before, after: raw() }, null, 2));
    log("done | settings final =", snap());
  });
}
