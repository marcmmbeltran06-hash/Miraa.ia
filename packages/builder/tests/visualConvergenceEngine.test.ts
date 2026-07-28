import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VisualConvergenceEngine } from '../src/validation/VisualConvergenceEngine.js';

const roots: string[] = [];

function site(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autowp-convergence-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'validation', 'visual'), { recursive: true });
  fs.mkdirSync(path.join(root, 'wp-content', 'themes', 'autowp-reconstruction', 'assets'), { recursive: true });
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('VisualConvergenceEngine', () => {
  it('preserves independent CSS repair sections and scopes layout repair to native commerce', () => {
    const root = site();
    const engine = new VisualConvergenceEngine();
    engine.createPlan(root, [{ slug: 'product' }]);
    fs.writeFileSync(path.join(root, 'validation', 'visual-validation-runtime.json'), JSON.stringify({
      status: 'needs_review',
      results: [{
        slug: 'product',
        viewportChecks: [{
          viewport: 'mobile',
          structure: { pass: false },
          positions: { pass: false },
        }],
      }],
      blockedClicks: [{ blocker: '.cookie-consent-overlay', text: 'Comprar' }],
    }));

    const first = engine.applySafeCorrections(root);
    const cssPath = path.join(root, 'wp-content', 'themes', 'autowp-reconstruction', 'assets', 'convergence.css');
    const css = fs.readFileSync(cssPath, 'utf8');

    expect(first.applied).toContain('repair-native-commerce-responsive-layout');
    expect(first.applied).toContain('disable-technical-click-blockers');
    expect(css).toContain('verified-technical-blockers:start');
    expect(css).toContain('native-commerce-responsive-layout:start');
    expect(css).toContain('body.autowp-native-commerce');
    expect(css).not.toContain('body{');
    expect(engine.applySafeCorrections(root).applied).toEqual([]);
  });
});
