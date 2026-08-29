// Small error formatting helper for scripts that accept unknown thrown values.
/** Return a readable message for Error and non-Error thrown values. */
export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || "Error";
  }
  return String(error);
}

/** Read Error messages unchanged and stringify every other value. */
export function coerceErrorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/** Preserve Error values and stringify every other value without workspace dependencies. */
export function toStringifiedError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** Preserve structured non-Error failures without requiring built workspace packages. */
export function toErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    // Twin of the canonical safe-copy loop in packages/normalization-core
    // (error-coercion.ts) and packages/retry (index.ts): skipping own `__proto__`
    // blocks the prototype-setter hijack; Reflect.set keeps Object.assign semantics.
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (key === "__proto__" || descriptor === undefined || !descriptor.enumerable) {
        continue;
      }
      if (!Reflect.set(error, key, Reflect.get(value, key))) {
        throw new TypeError(`Cannot assign property ${String(key)} to error target`);
      }
    }
  }
  return error;
}
