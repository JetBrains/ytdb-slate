// Provides the pi-coding-agent bindings imported by extension/worker.ts,
// extension/episodes.ts, extension/paths.ts and extension/render.ts. Session
// factories throw by default; tests can replace methods on codingAgentStub.
export const CONFIG_DIR_NAME = ".pi";
export const DEFAULT_COMPACTION_SETTINGS = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
};
export const codingAgentStub = {
  getAgentDir: () => "/tmp/slate-node-test-agent",
  shouldCompact: () => false,
  convertToLlm: (messages) => messages,
  serializeConversation: (messages) => JSON.stringify(messages),
  createAgentSession: async () => { throw new Error("createAgentSession stub called"); },
  openSession: () => { throw new Error("SessionManager.open stub called"); },
  createSession: () => ({}),
  createSettings: () => ({
    getGlobalSettings: () => ({}),
    getProjectSettings: () => ({}),
  }),
  settingsFromStorage: () => ({
    getDefaultThinkingLevel: () => "medium",
  }),
};
export const getAgentDir = (...args) => codingAgentStub.getAgentDir(...args);
export const shouldCompact = (...args) => codingAgentStub.shouldCompact(...args);
const ESTIMATED_IMAGE_CHARS = 4800;
function estimateTextAndImageContentChars(content) {
  if (typeof content === "string") return content.length;
  let chars = 0;
  for (const block of content) {
    if (block.type === "text" && block.text) chars += block.text.length;
    else if (block.type === "image") chars += ESTIMATED_IMAGE_CHARS;
  }
  return chars;
}
export const estimateTokens = (message) => {
  let chars = 0;
  switch (message.role) {
    case "user":
      return Math.ceil(estimateTextAndImageContentChars(message.content) / 4);
    case "assistant":
      for (const block of message.content) {
        if (block.type === "text") chars += block.text.length;
        else if (block.type === "thinking") chars += block.thinking.length;
        else if (block.type === "toolCall") chars += block.name.length + JSON.stringify(block.arguments).length;
      }
      return Math.ceil(chars / 4);
    case "custom":
    case "toolResult":
      return Math.ceil(estimateTextAndImageContentChars(message.content) / 4);
    case "bashExecution":
      return Math.ceil((message.command.length + message.output.length) / 4);
    case "branchSummary":
    case "compactionSummary":
      return Math.ceil(message.summary.length / 4);
    default:
      return 0;
  }
};
export const convertToLlm = (...args) => codingAgentStub.convertToLlm(...args);
export const serializeConversation = (...args) => codingAgentStub.serializeConversation(...args);
export const createAgentSession = (...args) => codingAgentStub.createAgentSession(...args);
export class DefaultResourceLoader {
  constructor(options) { this.options = options; }
  async reload() {}
  getExtensions() { return { extensions: [], errors: [] }; }
}
export class SessionManager {
  static open(...args) { return codingAgentStub.openSession(...args); }
  static create(...args) { return codingAgentStub.createSession(...args); }
}
export class SettingsManager {
  static create(...args) { return codingAgentStub.createSettings(...args); }
  static fromStorage(...args) { return codingAgentStub.settingsFromStorage(...args); }
}
export const getMarkdownTheme = () => ({});
export const keyHint = (key) => key;
