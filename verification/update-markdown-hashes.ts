import { updateHashes } from "./markdown-hashes.ts";

try {
  updateHashes(process.cwd(), process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
