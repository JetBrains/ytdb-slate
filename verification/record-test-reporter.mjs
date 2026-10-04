// Structured execution evidence from Node's test runner.
export default async function* recordTestReporter(source) {
  for await (const event of source) {
    if (["test:pass", "test:fail", "test:summary", "test:stderr"].includes(event.type)) {
      yield JSON.stringify(event, (_key, value) => value instanceof Error ? { message: value.message, stack: value.stack } : value) + "\n";
    }
  }
}
