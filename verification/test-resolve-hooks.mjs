// Resolve hook used by test-hooks.mjs. It aliases only slate's four SDK peers;
// every other specifier is delegated unchanged to Node's resolver.
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolvePath(dirname(fileURLToPath(import.meta.url)), "stubs");
const aliases = new Map([
  ["@earendil-works/pi-ai", "pi-ai.mjs"],
  ["@earendil-works/pi-ai/compat", "pi-ai-compat.mjs"],
  ["@earendil-works/pi-coding-agent", "pi-coding-agent.mjs"],
  ["@earendil-works/pi-tui", "pi-tui.mjs"],
  ["typebox", "typebox.mjs"],
]);

export async function resolve(specifier, context, nextResolve) {
  const target = aliases.get(specifier);
  if (target) {
    return { url: pathToFileURL(resolvePath(root, target)).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
