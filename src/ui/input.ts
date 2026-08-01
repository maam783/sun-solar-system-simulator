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
  toggleFullscreen: () => void;
  toggleMute: () => void;
  toggleConsole: () => void;
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
  releaseMouse: () => void;
}

/** Radians of nose movement per pixel of mouse travel, in PILOT mode. */
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
  /**
   * Raw look input, in radians, waiting to be applied.
   *
   * PILOT mode uses this directly: the nose goes where the mouse went and
   * stops when the mouse stops. Steering a rotation *rate* instead is what
   * makes a ship feel like it is skating on ice - every correction needs a
   * counter-correction, and the horizon never settles.
   */
  private lookPitch = 0;
  private lookYaw = 0;
  /** Where the head is pointed, relative to the hull. Radians. */
  headPitch = 0;
  headYaw = 0;
  /** Set by a click: turn the ship to face where the head is. */
  aimRequested = false;
  private dragging = false;
  private dragMoved = 0;

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
        // Escape is how you get the mouse cursor back. The browser releases
        // pointer lock on its own, but doing it explicitly also lets the same
        // key dismiss an overlay, which is what people reach for first.
        case 'Escape':
          this.keys.delete(code);
          this.actions.releaseMouse();
          break;
        case 'Space': this.actions.killRelativeVelocity(); break;
        case 'Tab': this.actions.cycleTarget(event.shiftKey ? -1 : 1); break;
        case 'KeyT': this.actions.cycleTarget(event.shiftKey ? -1 : 1); break;
        case 'KeyH': this.actions.toggleHelp(); break;
        case 'KeyF': this.actions.toggleFullscreen(); break;
        case 'KeyM': this.actions.toggleMute(); break;
        // The whole instrument console, for anyone who wants it, on the key it
        // lives on in every other program that has one.
        case 'Backquote': this.actions.toggleConsole(); break;
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
    // Drag to look. Not pointer lock, which hides the cursor and makes the
    // browser paint its own "press Escape" banner over the view; and not the
    // cursor position either, which was tried and was worse — if simply moving
    // the mouse swings the view, there is no way to reach a button without the
    // sky turning on the way, and the thing becomes unusable.
    //
    // Holding the button is the whole difference. It means looking around is
    // always available and never accidental, the cursor stays visible, and a
    // click that did not drag is unambiguous enough to mean something else.
    const LIMIT_YAW = 2.7;
    const LIMIT_PITCH = 1.35;
    const SENSITIVITY = 0.0032;

    this.canvas.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      this.dragging = true;
      this.dragMoved = 0;
      this.canvas.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', (event) => {
      if (!this.dragging) return;
      this.dragMoved += Math.abs(event.movementX) + Math.abs(event.movementY);
      this.headYaw -= event.movementX * SENSITIVITY;
      this.headPitch -= event.movementY * SENSITIVITY;
      this.headYaw = Math.max(-LIMIT_YAW, Math.min(LIMIT_YAW, this.headYaw));
      this.headPitch = Math.max(-LIMIT_PITCH, Math.min(LIMIT_PITCH, this.headPitch));
    });

    window.addEventListener('mouseup', (event) => {
      if (event.button !== 0 || !this.dragging) return;
      this.dragging = false;
      this.canvas.style.cursor = 'grab';
      // A press that never moved is a click, and a click means "point the ship
      // at what I am looking at". Anything that moved was a look, and looking
      // must not change course.
      if (this.dragMoved < 5) this.aimRequested = true;
    });

    this.canvas.style.cursor = 'grab';

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

  /**
   * Take the accumulated look movement and clear it. Returns radians of pitch
   * and yaw to apply to the nose this frame.
   */
  consumeLook(): { pitch: number; yaw: number } {
    const out = { pitch: this.lookPitch, yaw: this.lookYaw };
    this.lookPitch = 0;
    this.lookYaw = 0;
    return out;
  }

  /** Throttle axis for PILOT mode: +1 faster, -1 slower; smaller with shift. */
  throttleAxis(): number {
    const held = (code: string) => (this.keys.has(code) ? 1 : 0);
    const fine = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 0.22 : 1;
    return (held('KeyW') - held('KeyS')) * fine;
  }

  /**
   * Steering demand, -1 to 1 on each axis. What is done with it is the caller's
   * business: the ship has mass, so this is a request for torque and not a
   * change of heading.
   */
  steerAxis(): { pitch: number; yaw: number } {
    const held = (code: string) => (this.keys.has(code) ? 1 : 0);
    const fine = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 0.25 : 1;
    return {
      pitch: (held('ArrowUp') - held('ArrowDown')) * fine,
      yaw: (held('ArrowLeft') - held('ArrowRight')) * fine,
    };
  }

  /** Face front again. */
  recentreHead(): void {
    this.headPitch = 0;
    this.headYaw = 0;
  }

  /** Consume a click-to-aim request. */
  takeAim(): boolean {
    const wanted = this.aimRequested;
    this.aimRequested = false;
    return wanted;
  }

  isHeld(code: string): boolean {
    return this.keys.has(code);
  }

  /** Drive the ship from a script (used by the scenario runner). */
  clear(): void {
    this.keys.clear();
    this.stickPitch = 0;
    this.stickYaw = 0;
    this.lookPitch = 0;
    this.lookYaw = 0;
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
