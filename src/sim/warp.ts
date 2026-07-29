/**
 * Time warp.
 *
 * Warp is the honest way to cover interplanetary distances: it replays the
 * same physics faster rather than bending it. A Hohmann transfer to Mars takes
 * 259 days and even a continuous 1 g burn takes two, so without warp the
 * realistic flight modes would be unusable.
 *
 * The controller never decides on its own that a planet is "close". It asks
 * for a factor, the integrator reports the largest factor its substep budget
 * could actually sustain, and the warp drops to that. Near a planet the
 * substeps get small and the warp falls out of it automatically; in deep space
 * nothing constrains it.
 */

import { WARP } from '../config';

export type WarpLimitReason =
  | 'none'
  | 'gravity'
  | 'manual-thrust'
  | 'override'
  | 'autopilot-burn'
  | 'terminal-approach'
  | 'destroyed';

export class WarpController {
  /** Factor the pilot selected. */
  requested = 1;
  /** Factor actually in force this frame. */
  effective = 1;
  reason: WarpLimitReason = 'none';

  private ceiling = Infinity;

  get limited(): boolean {
    return this.effective < this.requested - 1e-9;
  }

  get stageIndex(): number {
    const i = WARP.stages.indexOf(this.requested);
    return i >= 0 ? i : 0;
  }

  setStage(index: number): void {
    const clamped = Math.max(0, Math.min(WARP.stages.length - 1, index));
    this.requested = WARP.stages[clamped]!;
  }

  stepStage(delta: number): void {
    this.setStage(this.stageIndex + delta);
  }

  reset(): void {
    this.requested = 1;
    this.effective = 1;
    this.ceiling = Infinity;
    this.reason = 'none';
  }

  /**
   * Impose a ceiling for this frame. Called once per constraint before the
   * step; the tightest one wins.
   */
  constrain(limit: number, reason: WarpLimitReason): void {
    if (limit < this.ceiling) {
      this.ceiling = limit;
      this.reason = reason;
    }
  }

  /** Resolve the factor to use this frame. */
  resolve(): number {
    const target = Math.min(this.requested, this.ceiling);
    if (target < this.effective) {
      // Drop immediately: the constraint is a hard accuracy limit.
      this.effective = target;
    } else {
      this.effective = Math.min(target, this.effective);
    }
    if (this.effective < 1) this.effective = Math.max(this.effective, 1e-3);
    return this.effective;
  }

  /**
   * After the step, let the warp climb back toward what the pilot asked for.
   * Doubling per second keeps the recovery visible but not jarring.
   */
  recover(dtReal: number): void {
    const target = Math.min(this.requested, this.ceiling);
    if (this.effective < target) {
      this.effective = Math.min(target, this.effective * Math.pow(WARP.recoverPerSecond, dtReal * 4));
    }
    this.ceiling = Infinity;
    if (this.effective >= this.requested - 1e-9) this.reason = 'none';
  }

  /** Feedback from the integrator: the warp its substep budget could carry. */
  applyIntegratorLimit(warpAllowed: number): void {
    if (Number.isFinite(warpAllowed) && warpAllowed < this.effective) {
      this.effective = Math.max(1e-3, warpAllowed);
      this.reason = 'gravity';
    }
  }
}
