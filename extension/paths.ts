/**
 * Package-relative runtime paths.
 *
 * The package ships its checker under extension/ and its doctrine documents
 * under docs/. Resolve both from this module's own location via import.meta.url
 * so callers can use absolute paths regardless of the project cwd or install
 * location (project-local, user-global, or node_modules).
 */

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(EXTENSION_DIR, "..", "docs");

export const WRITING_CHECKER = join(EXTENSION_DIR, "writing-check.mjs");
export const SIZE_GRADE_SCRIPT = join(EXTENSION_DIR, "size-grade.mjs");
// Dynamic import specifiers must be file URLs: raw paths break on Windows and
// treat `#` or `?` in an install directory as URL syntax.
export const WRITING_CHECKER_URL = pathToFileURL(WRITING_CHECKER).href;
export const TRACK_WORKFLOW_DOC = join(DOCS_DIR, "track-workflow.md");
export const PR_PUBLISHING_DOC = join(DOCS_DIR, "pr-publishing.md");
export const REVIEW_RULES_DOC = join(DOCS_DIR, "review-rules.md");
export const DESIGN_PRINCIPLES_DOC = join(DOCS_DIR, "design-principles.md");
export const MODEL_ROUTING_DOC = join(DOCS_DIR, "model-routing.md");
export const WRITING_GUIDANCE_DOC = join(DOCS_DIR, "writing-guidance.md");
export const CONTEXT_BUDGET_DOC = join(DOCS_DIR, "context-budget.md");
export const MODEL_FAILOVER_DOC = join(DOCS_DIR, "model-failover.md");
export const BLAST_RADIUS_DOC = join(DOCS_DIR, "blast-radius.md");
export const USER_NOTES_DOC = join(DOCS_DIR, "user-notes.md");
