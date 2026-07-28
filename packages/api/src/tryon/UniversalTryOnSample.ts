import { Buffer } from 'node:buffer';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mergeProducts, type ProductData, type SeoReport } from '@autowp/seo-analyzer';

type GarmentZone = 'tops' | 'bottoms' | 'one-pieces';
type ModelGender = 'female' | 'male';

export interface TryOnCandidate {
  productName: string;
  productUrl: string;
  garmentImageUrl: string;
  garmentZone: GarmentZone;
  modelGender: ModelGender;
  price?: string;
}

export interface TryOnSampleManifest extends TryOnCandidate {
  status: 'planned' | 'generated' | 'skipped' | 'failed';
  engine?: string;
  resultFile?: string;
  reason?: string;
  generatedAt: string;
}

const ZONE_PATTERNS: Array<[GarmentZone, RegExp]> = [
  ['one-pieces', /\b(vestido|dress|mono|jumpsuit|overall)\b/i],
  ['bottoms', /\b(pantal[oó]n|jean|vaquero|falda|short|bermuda|trouser|skirt)\b/i],
  ['tops', /\b(camisa|blusa|camiseta|top|jersey|cardigan|chaqueta|blazer|bomber|polo|shirt|jacket|sweater|coat)\b/i],
];

const UNSUPPORTED = /\b(zapato|calzado|sandalia|bolso|mochila|gorra|sombrero|gafas|joya|bisuter[ií]a|cintur[oó]n|shoe|bag|hat|jewelry|belt)\b/i;
const FEMALE = /\b(mujer|woman|women|chica|girl|femenin|vestido|falda|blusa)\b/i;
const MALE = /\b(hombre|man|men|chico|boy|masculin)\b/i;
let tryOnQueue: Promise<void> = Promise.resolve();

function enqueueInference<T>(task: () => Promise<T>): Promise<T> {
  const result = tryOnQueue.then(task, task);
  tryOnQueue = result.then(() => undefined, () => undefined);
  return result;
}

function productText(product: ProductData): string {
  return [
    product.name,
    product.title,
    product.description,
    ...(product.categories ?? []),
    ...(product.collections ?? []),
    ...(product.tags ?? []),
  ].filter(Boolean).join(' ');
}

function imageUrl(product: ProductData): string | undefined {
  return product.images?.find((value) => /^https?:\/\//i.test(value))
    ?? product.media?.map((item) => item.url).find((value) => /^https?:\/\//i.test(value));
}

export function detectGarmentZone(product: ProductData): GarmentZone | undefined {
  const text = productText(product);
  if (UNSUPPORTED.test(text)) return undefined;
  return ZONE_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0];
}

export function chooseModelGender(report: SeoReport, product: ProductData): ModelGender {
  const text = `${productText(product)} ${report.pages.slice(0, 8).map((page) => `${page.title ?? ''} ${page.metaDescription ?? ''}`).join(' ')}`;
  if (MALE.test(text) && !FEMALE.test(text)) return 'male';
  return 'female';
}

export function selectTryOnCandidate(report: SeoReport): TryOnCandidate | undefined {
  const candidates = mergeProducts(report.pages.flatMap((page) => page.products)).products
    .map((product) => ({ product, zone: detectGarmentZone(product), image: imageUrl(product) }))
    .filter((item): item is { product: ProductData; zone: GarmentZone; image: string } => Boolean(item.zone && item.image))
    .sort((a, b) => {
      const aScore = Number(Boolean(a.product.price)) + Number(Boolean(a.product.name ?? a.product.title)) + (a.product.images?.length ?? 0);
      const bScore = Number(Boolean(b.product.price)) + Number(Boolean(b.product.name ?? b.product.title)) + (b.product.images?.length ?? 0);
      return bScore - aScore;
    });
  const selected = candidates[0];
  if (!selected) return undefined;
  return {
    productName: selected.product.name ?? selected.product.title ?? 'Prenda seleccionada',
    productUrl: selected.product.url ?? selected.product.sourceUrl,
    garmentImageUrl: selected.image,
    garmentZone: selected.zone,
    modelGender: chooseModelGender(report, selected.product),
    price: selected.product.price,
  };
}

async function sourceBytes(source: string): Promise<{ bytes: Buffer; mime: string }> {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Image download failed with ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 15 * 1024 * 1024) throw new Error('Image exceeds 15 MB');
    return { bytes, mime: response.headers.get('content-type') ?? 'image/jpeg' };
  }
  const bytes = fs.readFileSync(source);
  return { bytes, mime: path.extname(source).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg' };
}

export async function generateUniversalTryOnSample(jobDir: string, report: SeoReport): Promise<void> {
  const candidate = selectTryOnCandidate(report);
  const manifestPath = path.join(jobDir, 'tryon-sample.json');
  const generatedAt = new Date().toISOString();
  if (!candidate) {
    fs.writeFileSync(manifestPath, JSON.stringify({ status: 'skipped', reason: 'No supported clothing product with a usable image was found.', generatedAt }, null, 2));
    return;
  }

  const engineUrl = process.env.MIRA_TRYON_ENGINE_URL?.replace(/\/$/, '');
  const modelSource = candidate.modelGender === 'male'
    ? process.env.MIRA_MALE_MODEL_IMAGE
    : process.env.MIRA_FEMALE_MODEL_IMAGE;
  if (!engineUrl || !modelSource) {
    const planned: TryOnSampleManifest = {
      ...candidate,
      status: 'planned',
      reason: 'Set MIRA_TRYON_ENGINE_URL and the corresponding model image to generate the result.',
      generatedAt,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(planned, null, 2));
    return;
  }

  try {
    const result = await enqueueInference(async () => {
      const [person, garment] = await Promise.all([sourceBytes(modelSource), sourceBytes(candidate.garmentImageUrl)]);
      const response = await fetch(`${engineUrl}/v1/tryon`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(process.env.MIRA_TRYON_ENGINE_TOKEN ? { authorization: `Bearer ${process.env.MIRA_TRYON_ENGINE_TOKEN}` } : {}),
        },
        body: JSON.stringify({
          request_id: `report_${path.basename(jobDir).replace(/[^A-Za-z0-9_-]/g, '_')}`,
          person_image_base64: person.bytes.toString('base64'),
          person_mime: person.mime,
          garment_image_base64: garment.bytes.toString('base64'),
          garment_mime: garment.mime,
          category: candidate.garmentZone,
          garment_zone: candidate.garmentZone,
          garment_photo_type: 'model',
        }),
        signal: AbortSignal.timeout(Number(process.env.MIRA_TRYON_TIMEOUT_MS ?? 300_000)),
      });
      if (!response.ok) throw new Error(`Try-on engine returned ${response.status}: ${await response.text()}`);
      return response.json() as Promise<{ engine?: string; result_image_base64?: string }>;
    });
    if (!result.result_image_base64) throw new Error('Try-on engine returned no image');
    const resultFile = 'tryon-result.jpg';
    fs.writeFileSync(path.join(jobDir, resultFile), Buffer.from(result.result_image_base64, 'base64'));
    const manifest: TryOnSampleManifest = { ...candidate, status: 'generated', engine: result.engine, resultFile, generatedAt };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  } catch (error) {
    const failed: TryOnSampleManifest = {
      ...candidate,
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error),
      generatedAt,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(failed, null, 2));
  }
}
