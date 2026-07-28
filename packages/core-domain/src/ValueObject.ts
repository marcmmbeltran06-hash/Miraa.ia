// ValueObject.ts
/** Abstract base class for Value Objects */
export abstract class ValueObject {
  protected constructor() {
    // Value objects are intended to be immutable, but freezing at the base
    // constructor stage prevents derived classes from initializing fields.
    // Concrete implementations may freeze their own instances if needed.
  }
}
