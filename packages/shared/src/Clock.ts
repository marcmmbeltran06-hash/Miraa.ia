// Clock.ts
import { Timestamp } from './Timestamp.js';

export interface Clock {
  now(): Timestamp;
}

export class SystemClock implements Clock {
  now(): Timestamp {
    return Timestamp.now();
  }
}
