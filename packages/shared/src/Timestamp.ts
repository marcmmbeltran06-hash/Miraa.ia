// Timestamp.ts
export class Timestamp {
  private readonly date: Date;
  private constructor(date: Date) {
    this.date = date;
  }
  public static now(): Timestamp {
    return new Timestamp(new Date());
  }
  public static from(date: Date): Timestamp {
    return new Timestamp(date);
  }
  public toDate(): Date {
    return this.date;
  }
  public toISOString(): string {
    return this.date.toISOString();
  }
}
