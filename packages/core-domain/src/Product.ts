// Product.ts
import { AggregateRoot } from "./AggregateRoot.js";
import { Identifier } from "@autowp/shared";
import { Result, ok, err } from "@autowp/shared";
import { DomainError } from "@autowp/shared";
import { Asset } from "./Asset.js";
import { Variant } from "./Variant.js";

/**
 * AggregateRoot representing a fashion product.
 */
export class Product extends AggregateRoot {
  public readonly name: string;
  public readonly description: string;
  public readonly price: number;
  public readonly currency: string;
  public readonly stock: number;
  public readonly images: Asset[];
  private _variants: Variant[] = [];

  private constructor(
    id: Identifier,
    name: string,
    description: string,
    price: number,
    currency: string,
    stock: number,
    images: Asset[]
  ) {
    super(id);
    this.name = name;
    this.description = description;
    this.price = price;
    this.currency = currency;
    this.stock = stock;
    this.images = images;
  }

  public static create(
    id: Identifier,
    name: string,
    description: string,
    price: number,
    currency: string,
    stock: number,
    images: Asset[]
  ): Result<Product, DomainError> {
    if (!name) return err(new DomainError("Product name required"));
    if (price < 0) return err(new DomainError("Price cannot be negative"));
    return ok(new Product(id, name, description, price, currency, stock, images));
  }

  /** Add a variant to the product */
  public addVariant(variant: Variant): Result<void, DomainError> {
    // Simple duplicate check based on size+color
    const exists = this._variants.some(
      (v) => v.size === variant.size && v.color === variant.color
    );
    if (exists) return err(new DomainError("Duplicate variant"));
    this._variants.push(variant);
    // Raise detection event (could also be raised elsewhere)
    this.raise({
      type: "ProductDetected",
      payload: {
        websiteId: "", // filled by caller if needed
        productId: this.id.value,
        name: this.name,
        price: this.price,
        currency: this.currency,
        images: this.images,
        variants: this._variants,
      },
    });
    return ok(undefined);
  }

  public get variants(): readonly Variant[] {
    return this._variants;
  }
}
