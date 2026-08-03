// Provides Type.String/Object/Array/Optional for extension/tools.ts and
// extension/index.ts. The descriptors retain arguments for test inspection.
const make = (kind, value, options) => ({ kind, value, options });
export const Type = {
  String: (options) => make("String", undefined, options),
  Object: (value, options) => make("Object", value, options),
  Array: (value, options) => make("Array", value, options),
  Optional: (value) => make("Optional", value),
};
