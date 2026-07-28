export type CaptureState = 'initial' | 'menu-open' | 'modal-open' | 'accordion-open' | 'form-ready';
export class StateCapturePlanner {
  public plan(): CaptureState[] { return ['initial', 'menu-open', 'modal-open', 'accordion-open', 'form-ready']; }
}
