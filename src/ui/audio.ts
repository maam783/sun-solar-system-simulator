/**
 * Sound.
 *
 * Three quiet things and nothing else: the ship, the drive, and the room the
 * whole thing happens in.
 *
 * The drive is the one that carries information. It is silent unless the engine
 * is actually firing, which means the long coasting stretches are silent too —
 * the same fact the physics states, said a second way. A pilot hears when they
 * are spending energy and hears when they are not.
 *
 * Everything is deliberately under-mixed. This is a room tone for a view, not a
 * score; if it is the thing you notice, it is too loud.
 *
 * Web Audio rather than <audio> elements, for two reasons: gain can be ramped
 * smoothly instead of stepped per frame, and a looping buffer can be told to
 * repeat *inside* its own ends, which skips the encoder padding that makes a
 * looped MP3 tick once a bar.
 */

const FILES = [
  'ambient', 'hum', 'drive', 'rcs', 'warp', 'rumble',
  'voice1', 'voice2', 'voice3', 'voice4', 'voice5', 'voice6',
] as const;

/** The lines of traffic, picked from at random. */
const VOICES = ['voice1', 'voice2', 'voice3', 'voice4', 'voice5', 'voice6'] as const;
type Clip = (typeof FILES)[number];

/**
 * Playback gains, set against the measured level of each file rather than by
 * ear — the first mix was chosen blind and came out with only three of the
 * sounds audible at all.
 *
 * The files sit at wildly different levels: the hum is a hot -4.8 dBFS, the
 * ambient bed -16, and the first hull creak was -39, which after a gain of 0.1
 * put it at -59 dBFS and simply never happened. These numbers bring them into
 * the same range, with the drive deliberately the loudest thing the ship does
 * because it is the only one that means anything.
 */
const LEVEL: Record<Clip, number> = {
  ambient: 0.26,
  hum: 0.10,
  drive: 0.40,
  // Attitude thrusters are felt through the hull, not heard as a jet. The
  // first one was a hiss at 0.30 and wrong on both counts.
  rcs: 0.11,
  warp: 0.45,
  rumble: 0.50,
  voice1: 0.9, voice2: 0.9, voice3: 0.9, voice4: 0.9, voice5: 0.9, voice6: 0.9,
};

export class Ambience {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<Clip, AudioBuffer>();
  private gains = new Map<Clip, GainNode>();
  private started = false;
  private nextBeacon = 0;
  private nextRumble = 0;
  private rcsGain: GainNode | null = null;
  private rcsSource: AudioBufferSourceNode | null = null;

  muted = false;
  /** True once the browser has let us make a sound. */
  get running(): boolean { return this.started; }

  constructor(private readonly basePath = './assets/audio') {}

  /**
   * Start on a user gesture, which is the only time a browser will allow it.
   * Safe to call repeatedly; only the first call does anything.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      const Ctor = window.AudioContext
        ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0;
      this.master.connect(this.ctx.destination);

      await Promise.all(FILES.map((name) => this.load(name)));

      this.loop('ambient');
      this.loop('hum');
      this.loop('drive', 0);
      // Fade the whole thing up over a few seconds, so it arrives rather than
      // starts.
      this.master.gain.linearRampToValueAtTime(1, this.ctx.currentTime + 4);
      this.nextBeacon = this.ctx.currentTime + 40;
    } catch {
      // No audio is a perfectly good outcome; nothing else depends on it.
      this.ctx = null;
    }
  }

  private async load(name: Clip): Promise<void> {
    const response = await fetch(`${this.basePath}/${name}.mp3`);
    if (!response.ok) throw new Error(`no audio ${name}`);
    this.buffers.set(name, await this.ctx!.decodeAudioData(await response.arrayBuffer()));
  }

  private loop(name: Clip, level = LEVEL[name]): void {
    const buffer = this.buffers.get(name);
    if (!buffer || !this.ctx || !this.master) return;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    // Stay clear of both ends: MP3 carries encoder padding there, and looping
    // through it is an audible click every time round.
    source.loopStart = Math.min(0.4, buffer.duration * 0.05);
    source.loopEnd = Math.max(source.loopStart + 0.1, buffer.duration - 0.4);
    const gain = this.ctx.createGain();
    gain.gain.value = level;
    source.connect(gain).connect(this.master);
    source.start();
    this.gains.set(name, gain);
  }

  /** Fired when the override engages, and when something huge goes past. */
  event(name: 'warp' | 'rumble'): void {
    this.oneShot(name);
  }

  /**
   * Attitude thrusters, held on while the ship is being steered.
   *
   * The first version fired the whole sample on each key press and let it run,
   * so the thrusters kept going long after the key was released — which is
   * both wrong and, as reported, obviously wrong. Cold gas stops when the
   * valve shuts. This loops while the key is down and closes in 80 ms, which
   * is about how fast a real valve seats.
   */
  steering(active: boolean): void {
    if (!this.ctx || !this.master) return;
    if (active && !this.rcsGain) {
      const buffer = this.buffers.get('rcs');
      if (!buffer || this.muted) return;
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      gain.gain.linearRampToValueAtTime(LEVEL.rcs, this.ctx.currentTime + 0.04);
      source.connect(gain).connect(this.master);
      source.start();
      this.rcsSource = source;
      this.rcsGain = gain;
    } else if (!active && this.rcsGain && this.rcsSource) {
      const gain = this.rcsGain;
      const source = this.rcsSource;
      const at = this.ctx.currentTime;
      gain.gain.cancelScheduledValues(at);
      gain.gain.setValueAtTime(gain.gain.value, at);
      gain.gain.linearRampToValueAtTime(0, at + 0.08);
      source.stop(at + 0.1);
      this.rcsGain = null;
      this.rcsSource = null;
    }
  }

  /**
   * `thrust` is 0 to 1. `nearness` is 0 far away and 1 skimming a surface, and
   * is the one sound here that is pure licence: nothing carries through vacuum.
   * It is included because passing a thing that size ought to be felt, and a
   * sub-bass swell is how that is done everywhere else.
   */
  update(thrust: number, dt: number, nearness = 0): void {
    if (!this.ctx || !this.master) return;
    const drive = this.gains.get('drive');
    if (drive) {
      const target = this.muted ? 0 : LEVEL.drive * Math.min(1, Math.max(0, thrust));
      // A short ramp rather than a jump: a drive that snaps on sounds like a
      // switch, and this one is meant to sound like mass being pushed.
      const k = 1 - Math.exp(-dt / 0.45);
      drive.gain.value += (target - drive.gain.value) * k;
    }
    this.master.gain.value = this.muted
      ? Math.max(0, this.master.gain.value - dt * 2)
      : this.master.gain.value;

    // Close to something enormous.
    if (nearness > 0.35 && this.ctx.currentTime > this.nextRumble) {
      this.nextRumble = this.ctx.currentTime + 25;
      this.oneShot('rumble', LEVEL.rumble * nearness);
    }
    // Somebody on a distant circuit, rarely enough that it is still an event.
    if (this.ctx.currentTime > this.nextBeacon) {
      this.nextBeacon = this.ctx.currentTime + 80 + Math.random() * 140;
      this.beacon();
    }
  }

  /**
   * A distant radio beacon, in the one form of it that is genuinely authentic.
   *
   * Apollo's air-to-ground tapes are public domain and could simply be played,
   * but the voices are the wrong thing: "Tranquility Base" is a quotation, it is
   * recognised instantly, and it belongs to one specific place three days from
   * Earth — hearing it while rounding Saturn breaks the shot rather than
   * dressing it. What carries the texture is the *signalling*, and that can be
   * reproduced exactly rather than sampled.
   *
   * These are the real Quindar tones: 2,525 Hz to key the transmitter and
   * 2,475 Hz to unkey it, 250 ms each, sent in-band on the voice circuit
   * because the ground link had no separate channel for them. Between them,
   * the circuit itself — noise through a 300-3,000 Hz voice band, which is why
   * the loops sound the way they do. No words, so nothing to recognise and
   * nothing to date it: just somebody, somewhere, holding a channel open.
   */
  private beacon(): void {
    if (!this.ctx || !this.master || this.muted) return;
    const t0 = this.ctx.currentTime;
    const bus = this.ctx.createGain();
    bus.gain.value = 0.075;
    bus.connect(this.master);

    const tone = (freq: number, at: number): void => {
      const osc = this.ctx!.createOscillator();
      const gain = this.ctx!.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.5, at + 0.01);
      gain.gain.setValueAtTime(0.5, at + 0.24);
      gain.gain.linearRampToValueAtTime(0, at + 0.25);
      osc.connect(gain).connect(bus);
      osc.start(at);
      osc.stop(at + 0.3);
    };

    // Somebody actually says something. The words are invented and name no
    // mission, place or date, so the same traffic belongs at Saturn as at
    // Pluto; the radio character is put on here rather than baked into the
    // recording, by squeezing it into the 300-3,000 Hz the circuit passes.
    const pick = VOICES[Math.floor(Math.random() * VOICES.length)]!;
    const speechBuffer = this.buffers.get(pick);
    const speech = speechBuffer ? speechBuffer.duration + 0.35 : 2.5;

    tone(2525, t0);
    tone(2475, t0 + 0.25 + speech);

    if (speechBuffer) {
      const voice = this.ctx.createBufferSource();
      voice.buffer = speechBuffer;
      const high = this.ctx.createBiquadFilter();
      high.type = 'highpass';
      high.frequency.value = 320;
      const low = this.ctx.createBiquadFilter();
      low.type = 'lowpass';
      low.frequency.value = 2900;
      // A little presence peak, which is what makes a small speaker sound like
      // a small speaker rather than like a muffled one.
      const peak = this.ctx.createBiquadFilter();
      peak.type = 'peaking';
      peak.frequency.value = 1700;
      peak.Q.value = 1.1;
      peak.gain.value = 7;
      const level = this.ctx.createGain();
      level.gain.value = LEVEL[pick];
      voice.connect(high).connect(low).connect(peak).connect(level).connect(bus);
      voice.start(t0 + 0.3);
    }

    // The open circuit underneath it.
    const frames = Math.ceil(this.ctx.sampleRate * speech);
    const buffer = this.ctx.createBuffer(1, frames, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * 0.5;
    const noise = this.ctx.createBufferSource();
    noise.buffer = buffer;
    const band = this.ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 1200;
    band.Q.value = 0.7;
    const level = this.ctx.createGain();
    level.gain.value = 0.22;
    noise.connect(band).connect(level).connect(bus);
    noise.start(t0 + 0.25);
  }

  private oneShot(name: Clip, level = LEVEL[name]): void {
    const buffer = this.buffers.get(name);
    if (!buffer || !this.ctx || !this.master || this.muted) return;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const gain = this.ctx.createGain();
    gain.gain.value = level;
    source.connect(gain).connect(this.master);
    source.start();
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master && this.ctx) {
      this.master.gain.cancelScheduledValues(this.ctx.currentTime);
      this.master.gain.linearRampToValueAtTime(this.muted ? 0 : 1, this.ctx.currentTime + 0.4);
    }
    return this.muted;
  }
}
