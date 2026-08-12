export interface DeterministicSequence {
  next(): string;
}

export function createSequence(prefix: string): DeterministicSequence {
  let value = 0;
  return {
    next() {
      value += 1;
      return `${prefix}-${value}`;
    },
  };
}
