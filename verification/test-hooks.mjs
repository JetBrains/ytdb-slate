// Preload with `node --import ./verification/test-hooks.mjs` to replace pi SDK
// peers with controllable local stubs. Tests may mutate exported stub state to
// inject failures without installing or modifying an SDK package.
import { register } from "node:module";

register("./test-resolve-hooks.mjs", import.meta.url);
