// ValidationError.ts
import { DomainError } from './DomainError.js';

export class ValidationError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
