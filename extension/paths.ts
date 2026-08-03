/**
 * Package-relative runtime paths.
 *
 * The package ships its checker under extension/ and its doctrine documents
 * under docs/. Resolve both from this module's own location via import.meta.url
 * so callers can use absolute paths regardless of the project cwd or install
 * location (project-local, user-global, or node_modules).
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(EXTENSION_DIR, "..", "docs");

export const WRITING_CHECKER = join(EXTENSION_DIR, "writing-check.mjs");
export const TRACK_WORKFLOW_DOC = join(DOCS_DIR, "track-workflow.md");
export const PR_PUBLISHING_DOC = join(DOCS_DIR, "pr-publishing.md");
export const REVIEW_RULES_DOC = join(DOCS_DIR, "review-rules.md");
export const DESIGN_PRINCIPLES_DOC = join(DOCS_DIR, "design-principles.md");
export const MODEL_ROUTING_DOC = join(DOCS_DIR, "model-routing.md");
