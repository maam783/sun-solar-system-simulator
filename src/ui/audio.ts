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
  'ambient', 'ambient2', 'ambient3', 'ambient4', 'hum', 'drive', 'rcs', 'warp', 'rumble',
  'voice1', 'voice2', 'voice3', 'voice4', 'voice5', 'voice6', 'voice7', 'voice8', 'voice9', 'voice10', 'voice11', 'voice12', 'voice13', 'voice14', 'voice15', 'voice16',
] as const;

/**
 * The music, and the traffic. Both are drawn from without immediate repeats,
 * because the thing that gives a loop away is hearing it come round again.
 */
const BEDS = ['ambient', 'ambient2', 'ambient3', 'ambient4'] as const;
const VOICES = ['voice1', 'voice2', 'voice3', 'voice4', 'voice5', 'voice6', 'voice7', 'voice8', 'voice9', 'voice10', 'voice11', 'voice12', 'voice13', 'voice14', 'voice15', 'voice16'] as const;
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
  // The four beds came out 3.5 dB apart (-14.5, -12.6, -15.2, -16.1 dBFS), and
  // a crossfade between takes at different levels is a crossfade you can hear.
  // These equalise them to about -30 dBFS played, whichever one is up.
  ambient: 0.216,
  ambient2: 0.174,
  ambient3: 0.234,
  ambient4: 0.26,
  // The one sound that is always there, so it is the one that must not be
  // noticed. It sat at -24.8 dBFS, which is audible on its own with the music
  // off; this is 6 dB down from that.
  hum: 0.05,
  drive: 0.40,
  // The replacement sample is a proper knock — peak 0.477 reached in 14 ms,
  // crest factor 22.7 dB — where the one before it was a soft blub. It is also
  // three and a half times hotter in the peak, so the gain comes down by the
  // same amount rather than the pulse train arriving at half scale.
  rcs: 0.85,
  warp: 0.45,
  rumble: 0.50,
  // Measured against the old chain rather than guessed: limiting the speech
  // raised its RMS by 8.1 dB at the same peak, which would have made a level
  // that was already right too loud. This takes that back out, so what changes
  // is the character and not the volume — the crest factor falls from 20.6 dB
  // to 12.1, which is the constant pressure a radio link has and the part that
  // filtering alone could never supply.
  voice1: 0.2,
  voice2: 0.2,
  voice3: 0.2,
  voice4: 0.2,
  voice5: 0.2,
  voice6: 0.2,
  voice7: 0.2,
  voice8: 0.2,
  voice9: 0.2,
  voice10: 0.2,
  voice11: 0.2,
  voice12: 0.2,
  voice13: 0.2,
  voice14: 0.2,
  voice15: 0.2,
  voice16: 0.2,
};

export class Ambience {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<Clip, AudioBuffer>();
  private gains = new Map<Clip, GainNode>();
  private started = false;
  private nextBeacon = 0;
  private nextRumble = 0;
  private rcsActive = false;
  private nextPulse = 0;
  private lastBed: Clip | null = null;

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

      this.startBed();
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

  /**
   * The music: one bed at a time, drawn at random, each fading into the next.
   *
   * A single two-minute loop is recognisable by its third pass, and once you
   * have heard the seam you cannot stop hearing it. Four beds in the same
   * register, never the same one twice running, and an eight-second crossfade
   * that starts before the outgoing one ends, means there is no seam to find:
   * what comes round is the *character*, not the take.
   */
  private startBed(): void {
    if (!this.ctx || !this.master) return;
    const choices = BEDS.filter((b) => b !== this.lastBed && this.buffers.has(b));
    const pick = (choices.length ? choices : BEDS.filter((b) => this.buffers.has(b)))[
      Math.floor(Math.random() * (choices.length || BEDS.length))
    ];
    const buffer = pick ? this.buffers.get(pick) : undefined;
    if (!pick || !buffer) return;
    this.lastBed = pick;

    const FADE = 8;
    const now = this.ctx.currentTime;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(LEVEL[pick], now + FADE);
    gain.gain.setValueAtTime(LEVEL[pick], now + buffer.duration - FADE);
    gain.gain.linearRampToValueAtTime(0, now + buffer.duration);
    source.connect(gain).connect(this.master);
    source.start(now);
    source.stop(now + buffer.duration + 0.1);

    // Bring the next one in while this one is still going out, so the two
    // overlap rather than meet.
    window.setTimeout(
      () => this.startBed(), Math.max(1000, (buffer.duration - FADE) * 1000));
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
   * Attitude thrusters, while the ship is being steered.
   *
   * Pulses, not a loop. Two attempts got this wrong in opposite directions:
   * the first fired a whole sample per key press and let it run on after the
   * key was released, and the second looped the sample — but the loop window
   * exists to skip MP3 padding on the two-minute beds, and applied to a
   * one-second clip it played 0.05 s to 0.6 s of a file whose only sound is in
   * the first third. That measured -60 dBFS, which is why the thrusters went
   * silent.
   *
   * A cold-gas thruster does not hold anyway: it fires in pulses, and holding a
   * valve open is not how attitude is trimmed. So this fires the puff about
   * five times a second while a key is down, with enough jitter that it does
   * not become a drum machine, and simply stops scheduling when the key comes
   * up — the pulse already in flight finishes on its own, which is what a valve
   * closing sounds like.
   */
  steering(active: boolean): void {
    if (active && !this.rcsActive) this.nextPulse = 0;
    this.rcsActive = active;
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

    if (this.rcsActive && this.ctx.currentTime > this.nextPulse) {
      // Slower than the first attempt, which at four a second turned a soft
      // sample into bubbling. Real attitude pulses are irregular and further
      // apart than that; the wide jitter is what stops a train of identical
      // transients reading as a machine.
      this.nextPulse = this.ctx.currentTime + 0.26 + Math.random() * 0.26;
      this.oneShot('rcs');
    }

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

      // The chain that makes a voice sound like a radio rather than like a
      // voice with the treble turned down. Filtering alone was not enough, as
      // reported, and the missing part is the dynamics: a link like this is
      // driven hard into limiting so that every syllable arrives at the same
      // level, and the peaks are clipped rather than reproduced. That constant
      // pressure — not the bandwidth — is what the ear recognises.
      //
      // Band first: 300 to 2,700 Hz is roughly what the circuit passes.
      const high = this.ctx.createBiquadFilter();
      high.type = 'highpass';
      high.frequency.value = 300;
      high.Q.value = 0.9;
      const low = this.ctx.createBiquadFilter();
      low.type = 'lowpass';
      low.frequency.value = 2700;
      low.Q.value = 0.9;
      // Presence peak: a small speaker in a small box.
      const peak = this.ctx.createBiquadFilter();
      peak.type = 'peaking';
      peak.frequency.value = 1800;
      peak.Q.value = 1.4;
      peak.gain.value = 9;
      // Push it well past the threshold, then limit hard.
      const drive = this.ctx.createGain();
      drive.gain.value = 5;
      const limiter = this.ctx.createDynamicsCompressor();
      limiter.threshold.value = -26;
      limiter.knee.value = 2;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.06;
      // Soft clipping on top, for the edge a saturated transmitter has.
      const shaper = this.ctx.createWaveShaper();
      const curve = new Float32Array(1024);
      for (let i = 0; i < curve.length; i++) {
        const x = (i / (curve.length - 1)) * 2 - 1;
        curve[i] = Math.tanh(x * 2.4);
      }
      shaper.curve = curve;
      shaper.oversample = '4x';
      // Band-limit again after the distortion, or its harmonics reach outside
      // the circuit and give the whole thing away.
      const post = this.ctx.createBiquadFilter();
      post.type = 'lowpass';
      post.frequency.value = 2700;

      const level = this.ctx.createGain();
      level.gain.value = LEVEL[pick];
      voice.connect(high).connect(low).connect(peak).connect(drive)
        .connect(limiter).connect(shaper).connect(post).connect(level).connect(bus);
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
