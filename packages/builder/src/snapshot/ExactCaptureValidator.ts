export interface ExactValidation { status: 'pass' | 'needs_reconstruction'; exactVisualScore: number | null; missingCriticalAssets: string[]; }
export class ExactCaptureValidator {
  public validate(missingCriticalAssets: string[], exactVisualScore: number | null): ExactValidation { return { status: missingCriticalAssets.length === 0 && exactVisualScore !== null && exactVisualScore >= 0.995 ? 'pass' : 'needs_reconstruction', exactVisualScore, missingCriticalAssets }; }
}
