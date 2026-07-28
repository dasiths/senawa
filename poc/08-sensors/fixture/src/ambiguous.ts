// A deliberately AMBIGUOUS subject for the inferential sensor.
//
// Nothing here is a clear-cut violation. There is no I/O, no forbidden import,
// no type error. The only questions are matters of taste:
//   - is `TotalCalculator` an abstraction worth its weight, or ceremony?
//   - does `Money` belong in domain, or is it over-modelled for one use?
//   - is `applyTo` in the right layer?
//
// If the sensor's verdict holds still here, it is measuring something. If it
// flips run to run, gating on it would produce backpressure the worker cannot
// reproduce, which is indistinguishable from a flaky test.

export class Money {
  constructor(private readonly cents: number) {}
  add(other: Money): Money {
    return new Money(this.cents + other.cents);
  }
  toNumber(): number {
    return this.cents / 100;
  }
}

export interface TotalCalculator {
  total(amounts: Money[]): Money;
}

export class SimpleTotalCalculator implements TotalCalculator {
  total(amounts: Money[]): Money {
    return amounts.reduce((acc, m) => acc.add(m), new Money(0));
  }
}

export class Order {
  constructor(
    private readonly lines: Money[],
    private readonly calculator: TotalCalculator,
  ) {}

  applyTo(): Money {
    return this.calculator.total(this.lines);
  }
}
