// IdGenerator.ts
import { v7 as uuidv7 } from 'uuid';
import { Identifier } from './Identifier.js';

export interface IdGenerator {
  generate(): Identifier;
}

export class UuidV7Generator implements IdGenerator {
  generate(): Identifier {
    return Identifier.create(uuidv7());
  }
}
