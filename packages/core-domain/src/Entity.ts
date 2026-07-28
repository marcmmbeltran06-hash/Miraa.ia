// Entity.ts
import { Identifier } from "@autowp/shared";

/** Base class for Entities ensuring each has a unique Identifier */
export abstract class Entity {
  public readonly id: Identifier;

  protected constructor(id: Identifier) {
    this.id = id;
  }

  /** Equality based on identifier */
  public equals(other: Entity): boolean {
    return this.id.value === other.id.value;
  }
}
