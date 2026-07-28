// Version.ts
export class Version {
  public readonly major: number;
  public readonly minor: number;
  public readonly patch: number;
  private constructor(major: number, minor: number, patch: number) {
    this.major = major;
    this.minor = minor;
    this.patch = patch;
  }
  public static parse(version: string): Version {
    const parts = version.split('.').map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) {
      throw new Error('Invalid semantic version');
    }
    return new Version(parts[0], parts[1], parts[2]);
  }
  public toString(): string {
    return `${this.major}.${this.minor}.${this.patch}`;
  }
  public compare(other: Version): number {
    if (this.major !== other.major) return this.major - other.major;
    if (this.minor !== other.minor) return this.minor - other.minor;
    return this.patch - other.patch;
  }
}
