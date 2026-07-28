// Identifier.ts
export class Identifier {
  public readonly value: string;
  private constructor(value: string) {
    this.value = value;
  }
  public static create(value: string): Identifier {
    return new Identifier(value);
  }
  public toString(): string {
    return this.value;
  }
}
