export class CaptureStabilityController {
  public readonly policy = { domStableMs: 1200, networkIdleMs: 1500, maxSettleMs: 30000, maxScrollSteps: 80 };
  public shouldCaptureAgain(previousHash?: string, currentHash?: string): boolean { return Boolean(previousHash && currentHash && previousHash !== currentHash); }
}
