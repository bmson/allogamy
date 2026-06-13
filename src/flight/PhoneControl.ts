// PhoneControl — fly the bird from a phone's gyroscope, with a sound-pairing
// scaffold for handing control to a second device (the "display").
//
// This file is INPUT only: it produces a normalised ControlVector that the
// FlightController polls. It draws nothing and owns no Three.js state, so it can
// be swapped for the keyboard source without touching the flight maths.
//
// WHAT IS WORKING (runs today on a real phone over HTTPS):
//   - DeviceOrientation gyro reader → smoothed { pitch, yaw, roll, throttle }.
//   - One-shot calibration that captures a neutral pose so any comfortable hold
//     is "level"; tilt is measured as a delta from that pose.
//   - The iOS 13+ permission gate (DeviceOrientationEvent.requestPermission).
//
// WHAT IS SCAFFOLD (clearly stubbed, needs real-device testing to finish):
//   - PairingChannel: an audio-chirp (ggwave-style FSK) + WebRTC handshake that
//     would let a phone pair to the installation display by sound. The transport
//     is behind interfaces with explicit TODOs; nothing here imports ggwave or
//     opens a real RTCPeerConnection yet.

// ---------------------------------------------------------------------------
// Shared control contract
// ---------------------------------------------------------------------------

/**
 * Normalised flight intent, the single currency every input source speaks.
 * Each axis is roughly [-1, 1] (throttle [0, 1]); the FlightController scales
 * these into its own MAX_ROLL / MAX_PITCH so feel stays tunable in one place.
 *
 *   roll     +left  / -right   (bank into a turn)
 *   pitch    +up    / -down    (nose up climbs, nose down dives)
 *   yaw      direct rudder; usually 0 — banking already yaws the bird
 *   throttle 0..1, optional extra glide speed (keyboard leaves it at a default)
 */
export interface ControlVector {
  roll: number;
  pitch: number;
  yaw: number;
  throttle: number;
}

/**
 * A pollable input source. read() must be cheap and allocation-free — it is
 * called once per frame. It returns the latest smoothed vector; the source does
 * its own event handling / smoothing off the render loop.
 */
export interface ControlSource {
  /** Latest control intent. Cheap; safe to call every frame. */
  read(): ControlVector;
  /** True once the source can produce meaningful input (e.g. permission granted). */
  readonly active: boolean;
  /** Free listeners / timers. */
  dispose(): void;
}

const ZERO: Readonly<ControlVector> = Object.freeze({ roll: 0, pitch: 0, yaw: 0, throttle: 0 });

/** Reusable empty vector so callers never crash before a source is live. */
export function neutralControl(): ControlVector {
  return { ...ZERO };
}

// ---------------------------------------------------------------------------
// Keyboard adapter — wraps the existing boolean Input as a ControlSource so the
// keyboard and the phone are genuinely interchangeable. (The legacy Input class
// is untouched; this just reads its fields.)
// ---------------------------------------------------------------------------

/** The subset of core/Input.ts that we read. Kept structural to avoid a hard import. */
export interface BooleanInput {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
}

/**
 * Presents a boolean keyboard input as a continuous ControlSource. Eases toward
 * the held direction so a keyboard feels as weighty as the gyro (the
 * FlightController also eases, so this is gentle pre-smoothing only).
 */
export class KeyboardControlSource implements ControlSource {
  readonly active = true;
  private input: BooleanInput;
  private v: ControlVector = neutralControl();
  private last = performance.now();

  constructor(input: BooleanInput) {
    this.input = input;
  }

  read(): ControlVector {
    const now = performance.now();
    const dt = Math.min((now - this.last) / 1000, 0.05);
    this.last = now;

    const i = this.input;
    const targetRoll = (i.left ? 1 : 0) - (i.right ? 1 : 0);
    const targetPitch = (i.up ? 1 : 0) - (i.down ? 1 : 0);

    // Light ease so taps don't snap; the controller adds the real inertia.
    const k = Math.min(1, dt * 8);
    this.v.roll += (targetRoll - this.v.roll) * k;
    this.v.pitch += (targetPitch - this.v.pitch) * k;
    this.v.yaw = 0;
    this.v.throttle = 0;
    return this.v;
  }

  dispose(): void {
    /* no listeners owned here */
  }
}

// ---------------------------------------------------------------------------
// Phone gyroscope source (WORKING)
// ---------------------------------------------------------------------------

export interface GyroOptions {
  /**
   * Degrees of tilt that map to full deflection. Smaller = twitchier. The
   * defaults assume a phone held loosely in two hands.
   */
  rollRangeDeg?: number; // left/right wrist roll → bank
  pitchRangeDeg?: number; // fore/aft tilt → climb/dive
  /** Smoothing time constant (seconds). Larger = floatier, heavier feel. */
  smoothing?: number;
  /** Deadzone (in normalised units, after ranging) to kill hand jitter near centre. */
  deadzone?: number;
  /** Invert pitch if a given mounting feels backwards. */
  invertPitch?: boolean;
}

const DEFAULT_GYRO: Required<GyroOptions> = {
  rollRangeDeg: 35,
  pitchRangeDeg: 30,
  smoothing: 0.18,
  deadzone: 0.06,
  invertPitch: false,
};

/** DeviceOrientationEvent as the WHATWG names it, with the iOS permission add-on. */
type OrientationEventLike = {
  alpha: number | null; // compass heading, 0..360 (z axis)
  beta: number | null; // front/back tilt, -180..180 (x axis)
  gamma: number | null; // left/right tilt, -90..90 (y axis)
};

type IOSPermissionCtor = {
  requestPermission?: () => Promise<'granted' | 'denied' | 'default'>;
};

/**
 * Reads DeviceOrientation and turns wrist tilt into a ControlVector.
 *
 * Usage (must be triggered by a user gesture on iOS — see requestPermission):
 *   const gyro = new GyroControlSource();
 *   await gyro.requestPermission();   // shows the iOS prompt if needed
 *   gyro.calibrate();                 // capture "this is level" on first read
 *   // each frame:
 *   const v = gyro.read();
 */
export class GyroControlSource implements ControlSource {
  active = false;

  private opts: Required<GyroOptions>;
  private v: ControlVector = neutralControl();

  // Latest raw reading (degrees), and the captured neutral pose.
  private rawBeta = 0;
  private rawGamma = 0;
  private rawAlpha = 0;
  private neutralBeta = 0;
  private neutralGamma = 0;
  private haveNeutral = false;
  private pendingCalibrate = false;
  private gotReading = false;

  private last = performance.now();
  private onOrient = (e: Event) => this.ingest(e as unknown as OrientationEventLike);

  constructor(options: GyroOptions = {}) {
    this.opts = { ...DEFAULT_GYRO, ...options };
  }

  /** True once at least one orientation sample has arrived. */
  get hasSignal(): boolean {
    return this.gotReading;
  }

  /**
   * Ask for sensor access and start listening. On iOS 13+ this MUST be called
   * from a user-gesture handler (tap), or the prompt is suppressed. Resolves
   * true if we are now listening, false if denied/unsupported.
   */
  async requestPermission(): Promise<boolean> {
    if (typeof window === 'undefined' || typeof DeviceOrientationEvent === 'undefined') {
      return false;
    }
    const ctor = DeviceOrientationEvent as unknown as IOSPermissionCtor;
    if (typeof ctor.requestPermission === 'function') {
      try {
        const state = await ctor.requestPermission();
        if (state !== 'granted') return false;
      } catch {
        // Throws if not called from a user gesture; treat as denied.
        return false;
      }
    }
    this.start();
    return true;
  }

  /** Begin listening (call after permission is known-granted, or on Android). */
  start(): void {
    window.addEventListener('deviceorientation', this.onOrient, true);
    this.active = true;
  }

  /**
   * Capture the current pose as "level" on the next sample. Call when the player
   * is holding the phone the way they want to fly. Recalibrate any time.
   */
  calibrate(): void {
    this.pendingCalibrate = true;
    // If a reading is already in hand, snap immediately too.
    if (this.gotReading) {
      this.neutralBeta = this.rawBeta;
      this.neutralGamma = this.rawGamma;
      this.haveNeutral = true;
      this.pendingCalibrate = false;
    }
  }

  private ingest(e: OrientationEventLike): void {
    // beta = pitch (nose up/down when phone held upright), gamma = roll.
    this.rawBeta = e.beta ?? this.rawBeta;
    this.rawGamma = e.gamma ?? this.rawGamma;
    this.rawAlpha = e.alpha ?? this.rawAlpha;
    this.gotReading = true;

    if (this.pendingCalibrate || !this.haveNeutral) {
      this.neutralBeta = this.rawBeta;
      this.neutralGamma = this.rawGamma;
      this.haveNeutral = true;
      this.pendingCalibrate = false;
    }
  }

  read(): ControlVector {
    const now = performance.now();
    const dt = Math.min((now - this.last) / 1000, 0.05);
    this.last = now;

    if (!this.gotReading) return this.v; // still ZERO until first sample

    const o = this.opts;

    // Delta from the captured neutral, in degrees.
    let dRoll = this.rawGamma - this.neutralGamma; // wrist roll → bank
    let dPitch = this.rawBeta - this.neutralBeta; // fore/aft → climb/dive

    // Map to normalised [-1, 1], clamp, then apply a centred deadzone so a
    // resting hand reads as truly level (no slow drift while "holding still").
    let roll = clamp(dRoll / o.rollRangeDeg, -1, 1);
    let pitch = clamp(dPitch / o.pitchRangeDeg, -1, 1);
    if (o.invertPitch) pitch = -pitch;
    roll = applyDeadzone(roll, o.deadzone);
    pitch = applyDeadzone(pitch, o.deadzone);

    // Sign convention: tilting the LEFT side down (negative gamma) should bank
    // left (roll +). So invert gamma → roll.
    roll = -roll;

    // Exponential smoothing toward the target → that floaty, weighty feel.
    const k = 1 - Math.exp(-dt / Math.max(0.001, o.smoothing));
    this.v.roll += (roll - this.v.roll) * k;
    this.v.pitch += (pitch - this.v.pitch) * k;
    this.v.yaw = 0; // banking yaws the bird; leave rudder neutral
    this.v.throttle = 0; // no throttle gesture yet (see TODO below)

    // TODO(device): map a deliberate forward "lunge" (DeviceMotion accel.z) to
    // throttle for a dive-boost. DeviceMotion needs its own permission and is
    // noisier than orientation, so it is intentionally left out of v1.

    return this.v;
  }

  dispose(): void {
    window.removeEventListener('deviceorientation', this.onOrient, true);
    this.active = false;
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Zero out small inputs, then rescale so the edge of the deadzone is still 0
 *  and full tilt is still 1 (no sudden jump at the deadzone boundary). */
function applyDeadzone(x: number, dz: number): number {
  const a = Math.abs(x);
  if (a <= dz) return 0;
  const scaled = (a - dz) / (1 - dz);
  return Math.sign(x) * scaled;
}

// ---------------------------------------------------------------------------
// Pairing over sound (SCAFFOLD — interfaces + stubs, no live transport yet)
// ---------------------------------------------------------------------------
//
// The installation runs on a big display; the player walks up with a phone. We
// want zero-typing pairing: the display emits a short audio chirp encoding a
// WebRTC SDP offer; the phone "hears" it, decodes the offer, and chirps back its
// SDP answer. Once the data channel is open, the phone streams its ControlVector
// to the display.
//
// Acoustic data is via ggwave (FSK in the audible/near-ultrasonic band). We do
// NOT bundle ggwave here — it is loaded at runtime and wired behind these
// interfaces so this module stays dependency-free and the real wiring can be
// dropped in after on-device testing.

/** A bidirectional, message-oriented link once a pair is established. */
export interface PairingChannel {
  /** Begin pairing in the given role. Resolves when a peer link is open. */
  connect(role: PairingRole): Promise<void>;
  /** Send an already-serialised control snapshot to the peer. */
  send(data: ArrayBuffer | string): void;
  /** Latest decoded control vector from the remote phone (display side). */
  onControl(cb: (v: ControlVector) => void): void;
  /** Coarse status for a pairing UI. */
  readonly state: PairingState;
  onStateChange(cb: (s: PairingState) => void): void;
  dispose(): void;
}

export type PairingRole = 'display' | 'phone';
export type PairingState = 'idle' | 'listening' | 'chirping' | 'connecting' | 'connected' | 'failed';

/** The acoustic codec we expect ggwave (or similar) to provide. */
export interface AcousticCodec {
  /** Encode bytes/string to PCM and play it through the speaker. */
  transmit(payload: string): Promise<void>;
  /** Listen on the mic; invoke cb with each decoded payload. Returns a stop fn. */
  receive(cb: (payload: string) => void): () => void;
}

/** The WebRTC side, narrowed to what pairing needs. */
export interface SignalTransport {
  /** Create an SDP offer (display). */
  createOffer(): Promise<string>;
  /** Accept a remote offer and produce an answer (phone). */
  acceptOffer(offerSdp: string): Promise<string>;
  /** Apply the remote answer (display). */
  acceptAnswer(answerSdp: string): Promise<void>;
  /** Fired when the data channel is usable. */
  onOpen(cb: () => void): void;
  /** Fired for each inbound data-channel message. */
  onMessage(cb: (data: ArrayBuffer | string) => void): void;
  send(data: ArrayBuffer | string): void;
  dispose(): void;
}

/**
 * Wire a control vector for the audio/RTC link. Tiny, fixed-width, lossy-OK:
 * three signed bytes + one unsigned. Acoustic bandwidth is precious, so this is
 * deliberately ~4 bytes, sent at a modest rate (see TODO in DisplayPairing).
 */
export function packControl(v: ControlVector): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = q(v.roll);
  b[1] = q(v.pitch);
  b[2] = q(v.yaw);
  b[3] = Math.round(clamp(v.throttle, 0, 1) * 255);
  return b;
}

export function unpackControl(b: Uint8Array): ControlVector {
  return {
    roll: dq(b[0]),
    pitch: dq(b[1]),
    yaw: dq(b[2]),
    throttle: (b[3] ?? 0) / 255,
  };
}

/** Quantise [-1,1] → unsigned byte and back. */
function q(x: number): number {
  return Math.round((clamp(x, -1, 1) * 0.5 + 0.5) * 255);
}
function dq(b: number): number {
  return ((b ?? 128) / 255) * 2 - 1;
}

/**
 * Reference pairing flow built on the two interfaces above. The handshake is
 * real (offer → chirp → answer → chirp → connect); only the AcousticCodec and
 * SignalTransport implementations are injected, so this can be unit-reasoned
 * about now and exercised for real once ggwave/WebRTC are supplied.
 *
 * STATUS: scaffold. With null transports it will sit in 'listening'/'chirping'
 * forever — that is intentional until real implementations are wired (TODOs).
 */
export class SoundPairing implements PairingChannel {
  state: PairingState = 'idle';

  private codec: AcousticCodec | null;
  private rtc: SignalTransport | null;
  private stopReceive: (() => void) | null = null;
  private controlCb: ((v: ControlVector) => void) | null = null;
  private stateCb: ((s: PairingState) => void) | null = null;

  /**
   * Inject the acoustic + RTC backends. Pass nulls to construct the scaffold
   * without any runtime deps (e.g. for type-checking or a "coming soon" UI).
   */
  constructor(codec: AcousticCodec | null = null, rtc: SignalTransport | null = null) {
    this.codec = codec;
    this.rtc = rtc;
  }

  onControl(cb: (v: ControlVector) => void): void {
    this.controlCb = cb;
  }
  onStateChange(cb: (s: PairingState) => void): void {
    this.stateCb = cb;
  }

  async connect(role: PairingRole): Promise<void> {
    if (!this.codec || !this.rtc) {
      // Honest failure: nothing to talk through yet.
      this.setState('failed');
      // TODO(device): construct a real AcousticCodec (ggwave) + SignalTransport
      //   (RTCPeerConnection + RTCDataChannel) and pass them to the constructor.
      return;
    }
    if (role === 'display') {
      await this.runDisplay();
    } else {
      await this.runPhone();
    }
  }

  /** Display: emit an offer chirp, then listen for the answer chirp. */
  private async runDisplay(): Promise<void> {
    const codec = this.codec!;
    const rtc = this.rtc!;
    rtc.onOpen(() => this.onLinkOpen());
    rtc.onMessage((d) => this.onLinkMessage(d));

    const offer = await rtc.createOffer();
    this.setState('chirping');
    await codec.transmit(encodeSignal('offer', offer));

    this.setState('listening');
    this.stopReceive = codec.receive(async (payload) => {
      const sig = decodeSignal(payload);
      if (sig?.kind === 'answer') {
        this.setState('connecting');
        await rtc.acceptAnswer(sig.sdp);
        // onOpen → 'connected'
      }
    });
    // TODO(device): time out and re-chirp the offer if no answer in ~5s; the
    //   acoustic link is lossy and a single chirp will often be missed.
  }

  /** Phone: listen for an offer chirp, answer with a chirp, then stream control. */
  private async runPhone(): Promise<void> {
    const codec = this.codec!;
    const rtc = this.rtc!;
    rtc.onOpen(() => this.onLinkOpen());
    rtc.onMessage((d) => this.onLinkMessage(d));

    this.setState('listening');
    this.stopReceive = codec.receive(async (payload) => {
      const sig = decodeSignal(payload);
      if (sig?.kind === 'offer') {
        this.setState('connecting');
        const answer = await rtc.acceptOffer(sig.sdp);
        this.setState('chirping');
        await codec.transmit(encodeSignal('answer', answer));
        // onOpen → 'connected'
      }
    });
  }

  private onLinkOpen(): void {
    this.stopReceive?.();
    this.stopReceive = null;
    this.setState('connected');
  }

  private onLinkMessage(d: ArrayBuffer | string): void {
    if (!this.controlCb) return;
    if (typeof d === 'string') return; // control is binary
    const bytes = new Uint8Array(d);
    if (bytes.length >= 4) this.controlCb(unpackControl(bytes));
  }

  send(data: ArrayBuffer | string): void {
    this.rtc?.send(data);
  }

  private setState(s: PairingState): void {
    if (s === this.state) return;
    this.state = s;
    this.stateCb?.(s);
  }

  dispose(): void {
    this.stopReceive?.();
    this.stopReceive = null;
    this.rtc?.dispose();
  }
}

/** Minimal envelope so the acoustic codec carries typed SDP, not bare strings. */
type Signal = { kind: 'offer' | 'answer'; sdp: string };

function encodeSignal(kind: Signal['kind'], sdp: string): string {
  // Keep it short for the acoustic channel; SDP is large, so a real build would
  // strip it to the few lines WebRTC actually needs (or use a TURN-less trickle
  // of ICE candidates). For the scaffold a tagged JSON string is enough.
  // TODO(device): compress SDP (remove unused m-lines, gzip+base64) — full SDP
  //   over audio FSK is too slow to chirp in one burst.
  return JSON.stringify({ k: kind, s: sdp });
}

function decodeSignal(payload: string): Signal | null {
  try {
    const o = JSON.parse(payload);
    if (o && (o.k === 'offer' || o.k === 'answer') && typeof o.s === 'string') {
      return { kind: o.k, sdp: o.s };
    }
  } catch {
    /* not our envelope */
  }
  return null;
}

/**
 * A ControlSource fed by a PairingChannel (the DISPLAY consumes this): the phone
 * streams its vector over the link, and the display flies the bird with it. This
 * lets the same FlightController code accept remote input with no special cases.
 *
 * STATUS: wiring is real; it only produces motion once a PairingChannel actually
 * reaches 'connected' (i.e. once real codec + RTC are injected into SoundPairing).
 */
export class RemoteControlSource implements ControlSource {
  active = false;
  private v: ControlVector = neutralControl();

  constructor(channel: PairingChannel) {
    channel.onControl((cv) => {
      this.v = cv;
      this.active = true;
    });
    channel.onStateChange((s) => {
      if (s !== 'connected') this.active = false;
    });
  }

  read(): ControlVector {
    return this.v;
  }
  dispose(): void {
    /* channel is owned by the caller */
  }
}
