// Deliberately buggy. The brief tells the worker only that "it mishandles at
// least one case" - the sensor knows more than the brief does, which is the
// whole point of the exercise.
export function sum(values) {
  let total = 0;
  for (let i = 1; i < values.length; i++) {
    total += values[i];
  }
  return total;
}
