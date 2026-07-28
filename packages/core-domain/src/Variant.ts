// Variant.ts
import { ValueObject } from "./ValueObject.js";

/** Value object representing a product variant (size, color, optional extra price) */
export class Variant extends ValueObject {
  public readonly size: string;
  public readonly color: string;
  public readonly additionalPrice?: number;

  constructor(params: { size: string; color: string; additionalPrice?: number }) {
    super();
    this.size = params.size;
    this.color = params.color;
    this.additionalPrice = params.additionalPrice;
  }
}
