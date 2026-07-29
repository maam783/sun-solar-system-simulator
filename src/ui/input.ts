/**
 * Pilot input.
 *
 * Mouse look uses pointer lock where the browser allows it and falls back to
 * click-and-drag where it does not — embedded and sandboxed frames often
 * refuse pointer lock, and a flight simulator you cannot aim is no use.
 *
 * Attitude is fly-by-wire: the stick commands a rotation *rate* and the
 * thrusters chase it, with the assist damping residual spin when the stick
 * centres. That is still a reaction-control system, just one with a computer
 * in the loop — which is how anything a human flies actually works. Turning
 * the assist off leaves rotation persisting exactly as Newton intended.
 */

import type { ShipCommand } from '../sim/ship';

export interface InputActions {
  killRelativeVelocity: () => void;
  cycleTarget: (delta: number) => void;
  toggleHelp: () => void;
  toggleAutopilot: () => void;
  toggleOverride: () => void;
  setAccelPreset: (index: number) => void;
  stepWarp: (delta: number) => void;
  togglePause: () => void;
  toggleFlightAssist: () => void;
  respawn: () => void;
  pointAtTarget: () => void;
  adjustFov: (delta: number) => void;
  adjustMaxAccel: (factor: number) => void;
  cycleHold: () => void;
}

const MOUSE_SENSITIVITY = 0.0022;
/** How fast the stick recentres when the mouse stops, per second. */
const STICK_DECAY = 9;

export class InputController {
  readonly command: ShipCommand = {
    throttle: 0, rcsX: 0, rcsY: 0, rcsZ: 0, pitch: 0, yaw: 0, roll: 0,
  };

  /** True while the main drive is locked on without holding a key. */
  throttleLock = false;
  pointerLocked = false;
  /** Set when pointer lock was refused, so the HUD can explain the fallback. */
  usingDragFallback = false;

  private readonly keys = new Set<string>();
  private stickPitch = 0;
  private stickYaw = 0;
  private dragging = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly actions: InputActions,
  ) {
    this.installKeyboard();
    this.installMouse();
  }

  private installKeyboard(): void {
    window.addEventListener('keydown', (event) => {
      // Let the browser have its own shortcuts.
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const code = event.code;

      // Keys the page would otherwise scroll or tab away on.
      if (['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(code)) {
        event.preventDefault();
      }
      if (event.repeat) return;
      this.keys.add(code);

      switch (code) {
        case 'Space': this.actions.killRelativeVelocity(); break;
        case 'Tab': this.actions.cycleTarget(event.shiftKey ? -1 : 1); break;
        case 'KeyT': this.actions.cycleTarget(event.shiftKey ? -1 : 1); break;
        case 'KeyH': this.actions.toggleHelp(); break;
        case 'KeyN': this.actions.toggleAutopilot(); break;
        case 'KeyO': this.actions.toggleOverride(); break;
        case 'KeyG': this.actions.toggleFlightAssist(); break;
        case 'KeyP': this.actions.togglePause(); break;
        case 'KeyR': this.keys.delete(code); this.actions.respawn(); break;
        case 'KeyV': this.actions.pointAtTarget(); break;
        case 'KeyC': this.actions.cycleHold(); break;
        case 'KeyZ': this.throttleLock = !this.throttleLock; break;
        case 'Digit1': this.actions.setAccelPreset(0); break;
        case 'Digit2': this.actions.setAccelPreset(1); break;
        case 'Digit3': this.actions.setAccelPreset(2); break;
        case 'BracketLeft': this.actions.stepWarp(-1); break;
        case 'BracketRight': this.actions.stepWarp(1); break;
        case 'Comma': this.actions.adjustMaxAccel(1 / 1.5); break;
        case 'Period': this.actions.adjustMaxAccel(1.5); break;
        case 'Minus': this.actions.adjustFov(5); break;
        case 'Equal': this.actions.adjustFov(-5); break;
        default: break;
      }
    });

    window.addEventListener('keyup', (event) => this.keys.delete(event.code));
    // Releasing focus must not leave a thruster stuck on.
    window.addEventListener('blur', () => this.keys.clear());
  }

  private installMouse(): void {
    this.canvas.addEventListener('click', () => {
      if (this.pointerLocked || this.usingDragFallback) return;
      const request = this.canvas.requestPointerLock?.();
      // Chromium returns a promise; a rejection means the frame forbids it.
      if (request && typeof (request as Promise<void>).catch === 'function') {
        (request as unknown as Promise<void>).catch(() => {
          this.usingDragFallback = true;
        });
      }
    });

    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
      if (this.pointerLocked) this.usingDragFallback = false;
    });
    document.addEventListener('pointerlockerror', () => {
      this.usingDragFallback = true;
    });

    this.canvas.addEventListener('mousedown', () => { this.dragging = true; });
    window.addEventListener('mouseup', () => { this.dragging = false; });

    window.addEventListener('mousemove', (event) => {
      const active = this.pointerLocked || this.dragging;
      if (!active) return;
      // Screen up should pitch the nose up, hence the sign on movementY.
      this.stickYaw -= event.movementX * MOUSE_SENSITIVITY;
      this.stickPitch -= event.movementY * MOUSE_SENSITIVITY;
      this.stickPitch = Math.max(-1, Math.min(1, this.stickPitch));
      this.stickYaw = Math.max(-1, Math.min(1, this.stickYaw));
    });

    this.canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      this.actions.adjustFov(Math.sign(event.deltaY) * 3);
    }, { passive: false });
  }

  /** Refresh the command struct. Called once per rendered frame. */
  update(dt: number): ShipCommand {
    const held = (code: string) => (this.keys.has(code) ? 1 : 0);

    const forward = held('KeyW') - held('KeyS');
    this.command.throttle = this.throttleLock ? 1 : Math.max(0, forward);
    // S with no throttle lock is a retro burn on the main drive, expressed as
    // aft translation so the ship does not have to turn around for a nudge.
    this.command.rcsZ = held('KeyS') && !this.throttleLock ? 1 : 0;
    this.command.rcsX = held('KeyD') - held('KeyA');
    this.command.rcsY = held('KeyR') - held('KeyF');
    this.command.roll = held('KeyQ') - held('KeyE');

    // Arrow keys duplicate the stick for anyone without a usable mouse.
    const arrowPitch = held('ArrowUp') - held('ArrowDown');
    const arrowYaw = held('ArrowLeft') - held('ArrowRight');

    this.command.pitch = Math.max(-1, Math.min(1, this.stickPitch + arrowPitch));
    this.command.yaw = Math.max(-1, Math.min(1, this.stickYaw + arrowYaw));

    // The stick springs back to centre so the ship stops turning when the
    // mouse stops moving, rather than drifting forever.
    const decay = Math.exp(-STICK_DECAY * dt);
    this.stickPitch *= decay;
    this.stickYaw *= decay;

    return this.command;
  }

  isHeld(code: string): boolean {
    return this.keys.has(code);
  }

  /** Drive the ship from a script (used by the scenario runner). */
  clear(): void {
    this.keys.clear();
    this.stickPitch = 0;
    this.stickYaw = 0;
    this.throttleLock = false;
    this.command.throttle = 0;
    this.command.rcsX = 0;
    this.command.rcsY = 0;
    this.command.rcsZ = 0;
    this.command.pitch = 0;
    this.command.yaw = 0;
    this.command.roll = 0;
  }
}
