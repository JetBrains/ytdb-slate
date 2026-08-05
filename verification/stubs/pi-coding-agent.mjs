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
