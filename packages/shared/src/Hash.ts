// Hash.ts
import { createHash } from 'crypto';

export class Hash {
  private readonly algorithm: string;
  constructor(algorithm: string = 'sha256') {
    this.algorithm = algorithm;
  }
  public compute(data: string): string {
    return createHash(this.algorithm).update(data).digest('hex');
  }
}
