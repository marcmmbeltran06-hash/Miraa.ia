// Asset.ts
import { ValueObject } from "./ValueObject.js";

/**
 * Represents an immutable asset (image, css, js) with its URL and integrity hash.
 */
export class Asset extends ValueObject {
  public readonly url: string;
  public readonly hash: string;
  public readonly type: "image" | "css" | "js";

  constructor(params: { url: string; hash: string; type: "image" | "css" | "js" }) {
    super();
    this.url = params.url;
    this.hash = params.hash;
    this.type = params.type;
  }
}
