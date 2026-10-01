// Tool results are read by a model, not a person, so they are written as
// compact JSON: indentation only costs tokens.
//
// Only a reference back to an object that is still being written is circular.
// The same object appearing twice side by side is written both times.
export function toJsonText(value: unknown): string {
  const ancestors: object[] = [];
  return JSON.stringify(value, function (this: any, _key, current) {
    if (typeof current !== 'object' || current === null) {
      return current;
    }
    while (ancestors.length && ancestors[ancestors.length - 1] !== this) {
      ancestors.pop();
    }
    if (ancestors.includes(current)) {
      return '[Circular Reference]';
    }
    ancestors.push(current);
    return current;
  });
}
