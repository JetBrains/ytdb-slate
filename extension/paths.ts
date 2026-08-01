/**
 * Package-relative doc paths.
 *
 * The package ships its workflow/review/design docs under docs/ next to
 * extension/. The orchestrator doctrine (mode.ts) references them by
 * ABSOLUTE path — resolved from this module's own location via
 * import.meta.url — so they are readable regardless of the project cwd or
 * where the package is installed (project-local, user-global, node_modules).
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DOCS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "docs");

export const TRACK_WORKFLOW_DOC = join(DOCS_DIR, "track-workflow.md");
export const PR_PUBLISHING_DOC = join(DOCS_DIR, "pr-publishing.md");
export const REVIEW_RULES_DOC = join(DOCS_DIR, "review-rules.md");
export const DESIGN_PRINCIPLES_DOC = join(DOCS_DIR, "design-principles.md");
export const MODEL_ROUTING_DOC = join(DOCS_DIR, "model-routing.md");
