// coreDomain.test.ts
import { describe, it, expect } from "vitest";
import { Identifier } from "@autowp/shared";
import { Website } from "../src/Website";
import { Product } from "../src/Product";
import { Variant } from "../src/Variant";
import { Asset } from "../src/Asset";
import { DomainError } from "@autowp/shared";

/** Helper to create a simple Identifier */
function id(value: string): Identifier {
  return Identifier.create(value);
}

describe("Core Domain - AggregateRoot Event Sourcing", () => {
  it("Given a Website, when startExtraction is called, then an event is raised and pullEvents clears it", () => {
    // Given
    const websiteResult = Website.create(id("w1"), "https://example.com");
    expect(websiteResult.ok).toBe(true);
    const website = websiteResult.value;

    // When
    const startResult = website.startExtraction();
    expect(startResult.ok).toBe(true);

    // Then
    const events = website.pullEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("WebsiteExtractionStarted");
    // After pulling, the internal list must be empty
    expect(website.pullEvents()).toHaveLength(0);
  });
});

describe("Core Domain - Product Variants and Validation", () => {
  it("Given a valid product, when adding a new variant, then variant list grows and event is raised", () => {
    // Given
    const asset = new Asset({ url: "https://img.com/1.jpg", hash: "hash1", type: "image" });
    const productResult = Product.create(
      id("p1"),
      "Elegant Dress",
      "Beautiful summer dress",
      120,
      "EUR",
      10,
      [asset]
    );
    expect(productResult.ok).toBe(true);
    const product = productResult.value;

    const variant = new Variant({ size: "M", color: "Red" });
    const addResult = product.addVariant(variant);
    expect(addResult.ok).toBe(true);
    expect(product.variants).toHaveLength(1);
    expect(product.variants[0].size).toBe("M");
    expect(product.variants[0].color).toBe("Red");

    // Event should have been raised
    const events = product.pullEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("ProductDetected");
  });

  it("Given a product with negative price, when creating it, then returns an error Result", () => {
    const asset = new Asset({ url: "https://img.com/2.jpg", hash: "hash2", type: "image" });
    const result = Product.create(
      id("p2"),
      "Faulty Shirt",
      "Should fail",
      -5,
      "EUR",
      5,
      [asset]
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(DomainError);
    }
  });
});
