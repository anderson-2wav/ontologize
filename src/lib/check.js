/**
 * @license MIT
 * @copyright 2025 2wav inc, Anderson Wiese
 */

// Simple Match-like implementation
const Match = {
  OneOf: (...types) => ({ _types: types, _isOneOf: true }),
  Optional: (type) => ({ _type: type, _isOptional: true }),
  Any: { _isAny: true }
};

function check(value, pattern, message) {
  function matches(val, pat) {
    if (pat === Object) return typeof val === "object" && val !== null && !Array.isArray(val);
    if (pat === Array) return Array.isArray(val);
    if (pat === String) return typeof val === "string";
    if (pat === Number) return typeof val === "number";
    if (pat === Boolean) return typeof val === "boolean";

    if (pat && pat._isOneOf) {
      return pat._types.some(type => matches(val, type));
    }

    if (pat && pat._isOptional) {
      return val === undefined || matches(val, pat._type);
    }

    if (pat && pat._isAny) {
      return true; // Match.Any always returns true
    }

    return false;
  }

  if (!matches(value, pattern)) {
    throw new Error(message || `Match failed for value: ${value}`);
  }
}

export { check, Match };
