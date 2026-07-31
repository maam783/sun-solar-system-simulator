/**
 * The cockpit console.
 *
 * Plain DOM over the canvas: a few dozen text nodes updated per frame cost
 * nothing next to the renderer, and it keeps the instruments legible at any
 * resolution.
 *
 * The readouts are deliberately in real units. Speed is shown in m/s and km/s
 * and as a fraction of light speed at the same time, because at true scale
 * those three numbers tell very different stories: 7.7 km/s is orbital, and
 * also 0.0026% of c, and also nowhere near enough to get anywhere.
 */

import { AU, C_LIGHT, getBody } from '../data/constants';
import { AUTOPILOT, G0, NAV_TARGETS, SPEED, WARP } from '../config';
import { FLYBY_ROUTES } from '../sim/flyby';
import { PilotDrive } from '../sim/pilot';
import { formatDuration, formatSimDate } from '../sim/time';
import type { World } from '../sim/world';
import type { SolarSystemRenderer } from '../render/scene';
import type { AttitudeHold } from '../sim/flightassist';
import { len, sub, vec, normalize, scale } from '../math/vec3d';

const relVel = vec();
const relPos = vec();
const dirTmp = vec();

/** Distance in whatever unit a human would use at that range. */
export const formatDistance = (m: number): string => {
  if (!Number.isFinite(m)) return '--';
  const a = Math.abs(m);
  if (a < 1000) return `${m.toFixed(0)} m`;
  if (a < 1e7) return `${(m / 1000).toFixed(1)} km`;
  if (a < 0.01 * AU) return `${(m / 1000).toFixed(0)} km`;
  if (a < 1000 * AU) return `${(m / AU).toFixed(4)} AU`;
  return `${(m / AU).toFixed(1)} AU`;
};

export const formatSpeed = (v: number): string => {
  const a = Math.abs(v);
  if (a < 1000) return `${v.toFixed(1)} m/s`;
  if (a < 0.001 * C_LIGHT) return `${(v / 1000).toFixed(2)} km/s`;
  if (a < C_LIGHT) return `${(v / 1000).toFixed(0)} km/s`;
  return `${(v / C_LIGHT).toFixed(2)} c`;
};

const el = (tag: string, className?: string, text?: string): HTMLElement => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const row = (key: string): { root: HTMLElement; value: HTMLElement } => {
  const root = el('div', 'row');
  root.appendChild(el('span', 'k', key));
  const value = el('span', 'v', '--');
  root.appendChild(value);
  return { root, value };
};

const button = (label: string, onClick: () => void): HTMLButtonElement => {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
    (event.currentTarget as HTMLElement).blur();
  });
  return b;
};

export interface HudCallbacks {
  onEngageAutopilot: () => void;
  onDisengageAutopilot: () => void;
  onCircularize: () => void;
  onHohmann: () => void;
  onSetAccel: (accel: number) => void;
  onSetTarget: (id: string) => void;
  onSetWarpStage: (index: number) => void;
  onSetMode: (mode: 'normal' | 'override') => void;
  onSetOverrideStage: (index: number) => void;
  onToggleHelp: () => void;
  onRespawn: () => void;
  onSetHold: (hold: AttitudeHold) => void;
  onToggleAssist: () => void;
  onStartFlyby: (routeId: string) => void;
  onCancelFlyby: () => void;
  onSetFlightModel: (model: 'pilot' | 'orbital') => void;
  onAllStop: () => void;
  onFlyToTarget: () => void;
}

export class Hud {
  private readonly root: HTMLElement;
  private readonly fields = new Map<string, HTMLElement>();
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private targetSelect!: HTMLSelectElement;
  private warnings!: HTMLElement;
  private markers!: HTMLElement;
  private overlay!: HTMLElement;
  private overlayTitle!: HTMLElement;
  private overlayBody!: HTMLElement;
  private markerNodes = new Map<string, HTMLElement>();

  helpVisible = false;
  advanced = false;
  /**
   * Simple is the default. The full console exists, but a first-time pilot
   * should not have to decide between PILOT, ORBITAL, ALL STOP, FLY THERE,
   * ORBIT HERE and STOP before they have looked at anything.
   */
  simple = true;

  constructor(private readonly callbacks: HudCallbacks) {
    this.root = document.getElementById('hud')!;
    this.build();
  }

  private field(key: string): HTMLElement {
    const node = this.fields.get(key);
    if (!node) throw new Error(`no HUD field ${key}`);
    return node;
  }

  private addRow(parent: HTMLElement, key: string, label: string, advanced = false): void {
    const { root, value } = row(label);
    if (advanced) root.classList.add('adv');
    parent.appendChild(root);
    this.fields.set(key, value);
  }

  /** Show or hide the engineering readouts. */
  setAdvanced(on: boolean): void {
    this.advanced = on;
    this.root.classList.toggle('advanced', on);
  }

  /** Switch between the one-panel view and the whole console. */
  setSimple(on: boolean): void {
    this.simple = on;
    this.root.classList.toggle('simple', on);
    this.setAdvanced(!on);
    const button = this.buttons.get('console');
    if (button) button.textContent = on ? 'FULL CONSOLE' : 'SIMPLE VIEW';
  }

  private build(): void {
    this.root.appendChild(el('div', '', '')).id = 'reticle';
    this.markers = el('div');
    this.markers.id = 'markers';
    this.root.appendChild(this.markers);

    this.buildFlightPanel();
    this.buildSightsPanel();
    this.buildNavPanel();
    this.buildConsolePanel();
    this.buildTimePanel();
    this.buildWarnings();
    this.buildMouseHint();
    this.buildOverlay();
  }

  private buildFlightPanel(): void {
    const panel = el('div', 'panel');
    panel.id = 'flight';
    panel.appendChild(el('h2', '', 'Flight'));

    const speed = el('div', 'big', '0 m/s');
    panel.appendChild(speed);
    this.fields.set('speed', speed);

    const speedSub = el('div', 'sub', '');
    panel.appendChild(speedSub);
    this.fields.set('speedSub', speedSub);

    // Throttle: a bar, because "how fast am I asking to go" is the one control
    // a pilot needs to read at a glance.
    const bar = el('div', 'bar');
    const fill = el('div', 'fill');
    bar.appendChild(fill);
    panel.appendChild(bar);
    this.fields.set('throttleFill', fill);
    const throttleLabel = el('div', 'sub', 'THROTTLE — W faster · S slower');
    panel.appendChild(throttleLabel);
    this.fields.set('throttleLabel', throttleLabel);

    panel.appendChild(el('div', 'sep'));
    this.addRow(panel, 'reference', 'NEAR');
    this.addRow(panel, 'altitude', 'DISTANCE');
    this.addRow(panel, 'mode', 'DRIVE', true);
    this.addRow(panel, 'gload', 'G-LOAD', true);
    this.addRow(panel, 'thrust', 'THRUST', true);
    this.addRow(panel, 'assist', 'ASSIST', true);

    const orbitRows = el('div', 'adv');
    panel.appendChild(orbitRows);
    orbitRows.appendChild(el('div', 'sep'));
    this.addRow(orbitRows, 'apoapsis', 'APOAPSIS');
    this.addRow(orbitRows, 'periapsis', 'PERIAPSIS');
    this.addRow(orbitRows, 'period', 'PERIOD');

    const modelBtns = el('div', 'btns full');
    const pilotBtn = button('PILOT', () => this.callbacks.onSetFlightModel('pilot'));
    const orbitalBtn = button('ORBITAL', () => this.callbacks.onSetFlightModel('orbital'));
    this.buttons.set('modelPilot', pilotBtn);
    this.buttons.set('modelOrbital', orbitalBtn);
    modelBtns.append(pilotBtn, orbitalBtn);
    modelBtns.appendChild(button('ALL STOP', () => this.callbacks.onAllStop()));
    panel.appendChild(modelBtns);

    const btns = el('div', 'btns adv');
    const normal = button('NORMAL', () => this.callbacks.onSetMode('normal'));
    const override = button('OVERRIDE', () => this.callbacks.onSetMode('override'));
    this.buttons.set('modeNormal', normal);
    this.buttons.set('modeOverride', override);
    btns.append(normal, override);
    for (let i = 0; i < SPEED.overrideStages.length; i++) {
      const stage = SPEED.overrideStages[i]!;
      const b = button(`${stage}c`, () => this.callbacks.onSetOverrideStage(i));
      this.buttons.set(`override${i}`, b);
      btns.appendChild(b);
    }
    panel.appendChild(btns);

    const assistBtns = el('div', 'btns adv');
    assistBtns.appendChild(button('ASSIST', () => this.callbacks.onToggleAssist()));
    for (const hold of ['off', 'prograde', 'retrograde', 'target'] as AttitudeHold[]) {
      const b = button(hold.toUpperCase().slice(0, 4), () => this.callbacks.onSetHold(hold));
      this.buttons.set(`hold_${hold}`, b);
      assistBtns.appendChild(b);
    }
    panel.appendChild(assistBtns);

    this.root.appendChild(panel);
  }

  /**
   * The reason to have a ship. One click each, no piloting required — the ship
   * flies the shot and points itself at the subject.
   */
  private buildSightsPanel(): void {
    const panel = el('div', 'panel');
    panel.id = 'sights';
    panel.appendChild(el('h2', '', 'Sights'));

    for (const route of FLYBY_ROUTES) {
      const b = button(route.name.toUpperCase(), () => this.callbacks.onStartFlyby(route.id));
      b.className = 'wide';
      b.title = route.blurb;
      panel.appendChild(b);
      this.buttons.set(`flyby_${route.id}`, b);
    }

    const status = el('div', 'sub', '');
    panel.appendChild(status);
    this.fields.set('flybyStatus', status);

    const bar = el('div', 'bar');
    const fill = el('div', 'fill warn');
    bar.appendChild(fill);
    bar.id = 'flybybar';
    panel.appendChild(bar);
    this.fields.set('flybyFill', fill);

    const cancel = button('CANCEL', () => this.callbacks.onCancelFlyby());
    cancel.className = 'wide';
    panel.appendChild(cancel);
    this.buttons.set('flybyCancel', cancel);

    this.root.appendChild(panel);
  }

  private buildNavPanel(): void {
    const panel = el('div', 'panel');
    panel.id = 'nav';
    panel.appendChild(el('h2', '', 'Navigation'));

    this.targetSelect = document.createElement('select');
    for (const id of NAV_TARGETS) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = getBody(id).name.toUpperCase();
      this.targetSelect.appendChild(option);
    }
    this.targetSelect.addEventListener('change', () => {
      this.callbacks.onSetTarget(this.targetSelect.value);
      this.targetSelect.blur();
    });
    panel.appendChild(this.targetSelect);

    this.addRow(panel, 'range', 'RANGE');
    this.addRow(panel, 'targetSize', 'APPARENT');
    this.addRow(panel, 'closing', 'CLOSING', true);
    this.addRow(panel, 'eta', 'ETA');
    this.addRow(panel, 'apPhase', 'STATUS');

    const btns = el('div', 'btns');
    const go = button('FLY THERE', () => this.callbacks.onFlyToTarget());
    go.className = 'wide';
    this.buttons.set('engage', go);
    panel.appendChild(go);

    const btns2 = el('div', 'btns');
    btns2.appendChild(button('STOP', () => this.callbacks.onDisengageAutopilot()));
    btns2.appendChild(button('ORBIT HERE', () => this.callbacks.onCircularize()));
    panel.appendChild(btns2);

    btns.appendChild(button('HOHMANN', () => this.callbacks.onHohmann()));
    btns.className = 'btns adv';
    panel.appendChild(btns);

    const accel = el('div', 'btns adv');
    AUTOPILOT.accelPresets.forEach((value, i) => {
      const b = button(`${Math.round(value / G0)}g`, () => this.callbacks.onSetAccel(value));
      this.buttons.set(`accel${i}`, b);
      accel.appendChild(b);
    });
    panel.appendChild(accel);

    this.root.appendChild(panel);
  }

  private buildConsolePanel(): void {
    const panel = el('div', 'panel');
    panel.id = 'console';
    panel.appendChild(el('h2', '', 'Reality check'));
    this.fields.set('consolePanel', panel);

    this.addRow(panel, 'deltaV', 'ΔV SPENT', true);
    this.addRow(panel, 'chemical', 'CHEMICAL (Isp 450 s)', true);
    this.addRow(panel, 'fusion', 'FUSION (Isp 1e5 s)', true);
    this.addRow(panel, 'antimatter', 'ANTIMATTER (0.3 c)', true);

    const note = el('div', 'hint adv',
      'Mass ratio a real rocket would need for the ΔV spent so far (m0/m1 = e^(Δv/ve)).');
    panel.appendChild(note);

    panel.appendChild(el('div', 'sep'));
    const btns = el('div', 'btns');
    btns.appendChild(button('CONTROLS (H)', () => this.callbacks.onToggleHelp()));
    btns.appendChild(button('RESPAWN (R)', () => this.callbacks.onRespawn()));
    const console_ = button('FULL CONSOLE', () => {
      this.setSimple(!this.simple);
      if (!this.simple) this.callbacks.onSetFlightModel('pilot');
    });
    this.buttons.set('console', console_);
    btns.appendChild(console_);
    panel.appendChild(btns);

    const status = el('div', 'hint', '');
    panel.appendChild(status);
    this.fields.set('status', status);

    this.root.appendChild(panel);
  }

  private buildTimePanel(): void {
    const panel = el('div', 'panel');
    panel.id = 'timepanel';
    panel.appendChild(el('h2', '', 'Time'));

    this.addRow(panel, 'date', 'DATE');
    this.addRow(panel, 'met', 'MISSION TIME', true);
    this.addRow(panel, 'warp', 'TIME WARP');
    this.addRow(panel, 'warpNote', 'STATUS', true);
    this.addRow(panel, 'fps', 'FPS', true);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = String(WARP.stages.length - 1);
    slider.step = '1';
    slider.value = '0';
    slider.addEventListener('input', () => {
      this.callbacks.onSetWarpStage(Number(slider.value));
    });
    panel.appendChild(slider);
    this.fields.set('warpSlider', slider);

    this.root.appendChild(panel);
  }

  private buildWarnings(): void {
    this.warnings = el('div');
    this.warnings.id = 'warnings';
    this.root.appendChild(this.warnings);
  }

  /**
   * The one piece of interface that has to explain itself: once the pointer is
   * captured for flying, there is no visible cursor to click the console with,
   * and nothing on screen says which key gives it back.
   */
  private buildMouseHint(): void {
    const hint = el('div');
    hint.id = 'mousehint';
    this.root.appendChild(hint);
    this.fields.set('mousehint', hint);
  }

  private buildOverlay(): void {
    this.overlay = el('div');
    this.overlay.id = 'overlay';
    const box = el('div', 'box');
    this.overlayTitle = el('h1', '', '');
    this.overlayBody = el('div');
    box.append(this.overlayTitle, this.overlayBody);
    this.overlay.appendChild(box);
    this.root.appendChild(this.overlay);
  }

  // -------------------------------------------------------------------------

  showHelp(): void {
    this.helpVisible = true;
    this.overlay.classList.add('show', 'help');
    this.overlayTitle.textContent = 'FLIGHT CONTROLS';
    this.overlayBody.innerHTML = `
      <p style="text-align:left;margin-bottom:10px">
        <strong>Flying is four keys.</strong> Point with the mouse, <kbd
        style="all:revert">W</kbd> to go faster, <kbd style="all:revert">S</kbd>
        slower, <kbd style="all:revert">Space</kbd> to stop. The ship holds
        itself against gravity, so letting go of everything leaves you parked
        next to whatever you are looking at. Or just click a flypast and watch.
      </p>
      <div class="keys">
        <div><kbd>Mouse</kbd>Point the nose (click to capture)</div>
        <div><kbd>Esc</kbd>Release the mouse / close this</div>
        <div><kbd>W / S</kbd>Faster / slower</div>
        <div><kbd>Space</kbd>All stop</div>
        <div><kbd>Q / E</kbd>Roll</div>
        <div><kbd>Q / E</kbd>Roll</div>
        <div><kbd>Tab / T</kbd>Cycle target</div>
        <div><kbd>A / D</kbd>Translate left / right</div>
        <div><kbd>R / F</kbd>Translate up / down</div>
        <div><kbd>, / .</kbd>Drive power (ORBITAL)</div>
        <div><kbd>Z</kbd>Drive lock (ORBITAL)</div>
        <div><kbd>N</kbd>Engage / abort autopilot</div>
        <div><kbd>1 2 3</kbd>Autopilot 1g / 3g / 10g</div>
        <div><kbd>C</kbd>Cycle attitude hold</div>
        <div><kbd>V</kbd>Point at target</div>
        <div><kbd>O</kbd>Toggle OVERRIDE drive</div>
        <div><kbd>[ / ]</kbd>Time warp down / up</div>
        <div><kbd>G</kbd>Flight assist on / off</div>
        <div><kbd>P</kbd>Pause</div>
        <div><kbd>R</kbd>Respawn in Earth orbit</div>
        <div><kbd>+ / −</kbd>Zoom (field of view)</div>
        <div><kbd>H</kbd>Close this</div>
      </div>
      <p class="hint" style="text-align:left;margin-top:14px">
        <strong>PILOT</strong> (default) commands velocity: the drive holds you
        against gravity so you can fly straight at things and stop next to them.
        <strong>ORBITAL</strong> is the Newtonian version, where thrust changes
        your orbit and you manage the consequences — press ORBIT HERE to drop
        into a real circular orbit around whatever you are near.
        Either way the solar system itself is unchanged: real positions, real
        sizes, real light. Everything at true scale.
      </p>`;
  }

  hideOverlay(): void {
    this.helpVisible = false;
    this.overlay.classList.remove('show', 'help');
  }

  showDestroyed(bodyName: string, speed: number): void {
    this.overlay.classList.add('show');
    this.overlay.classList.remove('help');
    this.overlayTitle.textContent = 'SHIP DESTROYED';
    this.overlayBody.innerHTML = `
      <p>Hull contact with <strong>${bodyName}</strong> at ${formatSpeed(speed)}.</p>
      <p class="hint">At true scale a planet is not a marker on a map. Press
      <kbd style="all:revert">R</kbd> to respawn in Earth orbit.</p>`;
  }

  get overlayShown(): boolean {
    return this.overlay.classList.contains('show');
  }

  // -------------------------------------------------------------------------

  update(
    world: World,
    renderer: SolarSystemRenderer,
    fps: number,
    pointerLocked = false,
  ): void {
    const ship = world.ship;
    const speed = world.referenceSpeed();

    this.field('speed').textContent = formatSpeed(speed);
    const beta = speed / C_LIGHT;
    this.field('speedSub').textContent =
      `${speed.toFixed(0)} m/s · ${(speed / 1000).toFixed(2)} km/s · ${(beta * 100).toFixed(4)} % c`;

    const overrideStage = SPEED.overrideStages[ship.overrideStage]!;
    this.field('mode').textContent = ship.mode === 'override'
      ? `OVERRIDE ${overrideStage}c`
      : 'NORMAL';

    // --- Throttle and flight model ---
    const ceiling = PilotDrive.ceiling(ship.mode, ship.overrideStage, world.nearest.altitude);
    const fraction = world.flightModel === 'pilot'
      ? world.pilot.throttleFraction(ceiling)
      : ship.currentAccel / Math.max(1e-6, ship.maxAccel);
    (this.field('throttleFill') as HTMLElement).style.width =
      `${Math.max(0, Math.min(1, world.flyby.active ? world.flyby.progress : fraction)) * 100}%`;
    this.field('throttleLabel').textContent = world.flyby.active
      ? `FLYPAST — ${Math.round(world.flyby.progress * 100)}% · ESC to take over`
      : world.flightModel === 'orbital'
      ? 'ORBITAL — W main drive · S retro'
      : world.pilot.cruiseSpeed > 0
        ? `${formatSpeed(world.pilot.cruiseSpeed)} — W faster · S slower · SPACE stop`
        : 'HOLDING — W to fly';
    this.buttons.get('modelPilot')!.classList.toggle('on', world.flightModel === 'pilot');
    this.buttons.get('modelOrbital')!.classList.toggle('on', world.flightModel === 'orbital');

    // --- Sightseeing route ---
    const flyby = world.flyby;
    this.field('flybyStatus').textContent = flyby.active
      ? flyby.route?.blurb ?? ''
      : (flyby.message || 'Pick a flypast — the ship flies it for you.');
    (this.field('flybyFill') as HTMLElement).style.width =
      `${(flyby.active ? flyby.progress : 0) * 100}%`;
    this.buttons.get('flybyCancel')!.style.display = flyby.active ? '' : 'none';
    for (const route of FLYBY_ROUTES) {
      this.buttons.get(`flyby_${route.id}`)!.classList.toggle(
        'on', flyby.active && flyby.route?.id === route.id);
    }
    this.field('reference').textContent = getBody(world.referenceId).name.toUpperCase();
    this.field('altitude').textContent = formatDistance(world.nearest.altitude);
    this.field('gload').textContent = `${(ship.currentAccel / G0).toFixed(2)} g`;
    this.field('thrust').textContent = `${(ship.maxAccel / G0).toFixed(1)} g max`;
    this.field('assist').textContent = ship.flightAssist ? 'ON' : 'OFF';

    const orbit = world.orbitInfo();
    if (orbit && orbit.e < 1) {
      const primary = getBody(orbit.primary);
      this.field('apoapsis').textContent = formatDistance(orbit.apoapsis - primary.radius);
      this.field('periapsis').textContent = formatDistance(orbit.periapsisAltitude);
      this.field('period').textContent = formatDuration(orbit.period);
    } else {
      this.field('apoapsis').textContent = 'ESCAPE';
      this.field('periapsis').textContent = orbit ? formatDistance(orbit.periapsis) : '--';
      this.field('period').textContent = '--';
    }

    // --- Navigation ---
    if (this.targetSelect.value !== world.targetId) this.targetSelect.value = world.targetId;
    const targetState = world.bodyState(world.targetId);
    sub(relPos, targetState.pos, ship.pos);
    const range = len(relPos);
    sub(relVel, ship.vel, targetState.vel);
    normalize(dirTmp, relPos);
    const closing = -(relVel.x * dirTmp.x + relVel.y * dirTmp.y + relVel.z * dirTmp.z);

    const targetBody = getBody(world.targetId);
    this.field('range').textContent = formatDistance(range - targetBody.radius);
    this.field('closing').textContent = formatSpeed(closing);
    this.field('targetSize').textContent =
      `${renderer.apparentDiameterDeg(world, world.targetId).toFixed(3)}°`;

    const status = world.autopilot.status(ship);
    this.field('eta').textContent = status.active ? formatDuration(status.eta) : '--';
    this.field('apPhase').textContent = status.active
      ? status.phase.toUpperCase()
      : (status.message || 'STANDBY');
    this.buttons.get('engage')!.classList.toggle('on', status.active);

    // --- Reality check: what a real rocket would need for this delta-v ---
    const dv = ship.deltaVUsed;
    this.field('deltaV').textContent = formatSpeed(dv);
    this.field('chemical').textContent = massRatio(dv, 450 * G0);
    this.field('fusion').textContent = massRatio(dv, 1e5 * G0);
    this.field('antimatter').textContent = massRatio(dv, 0.3 * C_LIGHT);

    // --- Time ---
    this.field('date').textContent = formatSimDate(world.clock.t);
    this.field('met').textContent = formatDuration(world.clock.elapsed);
    this.field('warp').textContent = world.warp.effective >= 1000
      ? `${(world.warp.effective / 1000).toFixed(1)}k ×`
      : `${world.warp.effective.toFixed(world.warp.effective < 10 ? 1 : 0)} ×`;
    this.field('warpNote').textContent = warpReason(world);
    this.field('fps').textContent = fps.toFixed(0);
    const slider = this.field('warpSlider') as HTMLInputElement;
    if (Number(slider.value) !== world.warp.stageIndex) {
      slider.value = String(world.warp.stageIndex);
    }

    // --- Mode / hold button states ---
    this.buttons.get('modeNormal')!.classList.toggle('on', ship.mode === 'normal');
    this.buttons.get('modeOverride')!.classList.toggle('on', ship.mode === 'override');
    for (let i = 0; i < SPEED.overrideStages.length; i++) {
      this.buttons.get(`override${i}`)!.classList.toggle(
        'on', ship.mode === 'override' && ship.overrideStage === i);
    }
    AUTOPILOT.accelPresets.forEach((value, i) => {
      this.buttons.get(`accel${i}`)!.classList.toggle(
        'on', Math.abs(world.autopilot.accel - value) < 1e-6);
    });
    for (const hold of ['off', 'prograde', 'retrograde', 'target'] as AttitudeHold[]) {
      this.buttons.get(`hold_${hold}`)!.classList.toggle('on', world.hold === hold);
    }

    const hint = this.field('mousehint');
    hint.textContent = world.flyby.active
      ? 'ESC — take back control'
      : pointerLocked
        ? 'ESC — release the mouse to use the console'
        : 'Click the view to fly';
    hint.className = pointerLocked ? 'locked' : '';

    this.updateWarnings(world);
    if (this.simple || world.flyby.active) this.clearMarkers();
    else this.updateMarkers(world, renderer);
  }

  private updateWarnings(world: World): void {
    const lines: Array<{ text: string; danger: boolean }> = [];

    const impact = world.timeToImpact();
    // A sightseeing route is a camera move on rails; it passes close on
    // purpose, so a collision warning is just noise across the shot.
    if (impact < 120 && !world.ship.destroyed && !world.flyby.active) {
      lines.push({
        text: `COLLISION COURSE · ${getBody(world.nearest.id).name.toUpperCase()} · ${impact.toFixed(0)} s`,
        danger: impact < 30,
      });
    }
    if (world.ship.currentAccel / G0 > 8 && !world.flyby.active) {
      lines.push({ text: `HIGH G-LOAD · ${(world.ship.currentAccel / G0).toFixed(0)} g`, danger: world.ship.currentAccel / G0 > 20 });
    }
    if (world.ship.mode === 'override') {
      lines.push({ text: 'OVERRIDE DRIVE ACTIVE · PHYSICS SUSPENDED', danger: false });
    }
    if (world.paused) lines.push({ text: 'PAUSED', danger: false });
    if (world.autopilot.message === 'OVERSPEED - EMERGENCY BRAKING') {
      lines.push({ text: world.autopilot.message, danger: true });
    }

    this.warnings.innerHTML = '';
    for (const line of lines) {
      const node = el('div', `warn-line${line.danger ? ' danger blink' : ''}`, line.text);
      this.warnings.appendChild(node);
    }
  }

  /**
   * Prograde, retrograde and target markers. Anything off screen is pinned to
   * the edge of the viewport pointing the way to turn, which is the only way
   * to find a body that is a single pixel wide.
   */
  private updateMarkers(world: World, renderer: SolarSystemRenderer): void {
    const entries: Array<[string, string, string, string]> = [];

    world.relativeVelocity(world.referenceId, relVel);
    if (len(relVel) > 0.05) {
      normalize(dirTmp, relVel);
      entries.push(['prograde', `${dirTmp.x},${dirTmp.y},${dirTmp.z}`, 'PRO', 'prograde']);
      scale(dirTmp, dirTmp, -1);
      entries.push(['retrograde', `${dirTmp.x},${dirTmp.y},${dirTmp.z}`, 'RET', 'retrograde']);
    }

    const targetState = world.bodyState(world.targetId);
    sub(relPos, targetState.pos, world.ship.pos);
    if (len(relPos) > 0) {
      normalize(dirTmp, relPos);
      entries.push(['target', `${dirTmp.x},${dirTmp.y},${dirTmp.z}`, 'TGT', 'target square']);
    }

    const seen = new Set<string>();
    for (const [key, dirStr, label, cls] of entries) {
      seen.add(key);
      const [x, y, z] = dirStr.split(',').map(Number) as [number, number, number];
      const projected = renderer.projectDirection({ x, y, z });

      let node = this.markerNodes.get(key);
      if (!node) {
        node = el('div', `marker ${cls}`);
        node.appendChild(el('div', 'glyph', label[0]!));
        node.appendChild(el('div', 'lbl', label));
        this.markers.appendChild(node);
        this.markerNodes.set(key, node);
      }

      // Normalised device coords -> pixels, clamped to a border ring when the
      // point is off screen or behind the ship.
      let nx = projected.x;
      let ny = projected.y;
      const offScreen = projected.behind || Math.abs(nx) > 1 || Math.abs(ny) > 1;
      if (offScreen) {
        if (projected.behind) { nx = -nx; ny = -ny; }
        const m = Math.max(Math.abs(nx), Math.abs(ny)) || 1;
        nx = (nx / m) * 0.94;
        ny = (ny / m) * 0.94;
      }
      node.style.left = `${(nx * 0.5 + 0.5) * 100}%`;
      node.style.top = `${(0.5 - ny * 0.5) * 100}%`;
      node.style.opacity = offScreen ? '0.5' : '0.9';
    }

    for (const [key, node] of this.markerNodes) {
      if (!seen.has(key)) {
        node.remove();
        this.markerNodes.delete(key);
      }
    }
  }

  private clearMarkers(): void {
    if (this.markerNodes.size === 0) return;
    for (const node of this.markerNodes.values()) node.remove();
    this.markerNodes.clear();
  }

  setStatus(text: string): void {
    this.field('status').textContent = text;
  }
}

/** Rocket-equation mass ratio, formatted so absurd numbers stay readable. */
const massRatio = (deltaV: number, exhaustVelocity: number): string => {
  if (deltaV < 1) return '1.00';
  const exponent = deltaV / exhaustVelocity;
  if (exponent > 700) return `10^${(exponent / Math.LN10).toExponential(2)}`;
  const ratio = Math.exp(exponent);
  if (ratio < 1000) return ratio.toFixed(2);
  const log10 = exponent / Math.LN10;
  return `10^${log10.toFixed(1)}`;
};

const warpReason = (world: World): string => {
  if (!world.warp.limited) return 'NOMINAL';
  switch (world.warp.reason) {
    case 'gravity': return 'LIMITED · GRAVITY';
    case 'manual-thrust': return 'LIMITED · MANUAL BURN';
    case 'override': return 'LIMITED · OVERRIDE';
    case 'autopilot-burn': return 'LIMITED · AUTOPILOT BURN';
    case 'terminal-approach': return 'LIMITED · APPROACH';
    default: return 'LIMITED';
  }
};
