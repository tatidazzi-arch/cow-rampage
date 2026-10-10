/** Efeitos sonoros sintetizados com WebAudio (zero arquivos, zero download).
 *  Tudo passa por try/catch: som nunca pode quebrar o jogo. */

export type SfxName =
  | 'click' | 'jump' | 'thud' | 'boom' | 'splash'
  | 'coin' | 'moo' | 'clang' | 'flop';

const MUTE_KEY = 'cowrampage.muted';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;
let muted = false;

try {
  muted = window.localStorage.getItem(MUTE_KEY) === '1';
} catch { /* sem persistência */ }

function ac(): AudioContext | null {
  try {
    if (!ctx) {
      const AC = window.AudioContext
        || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.32;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** Chamar em gestos do usuário (clique/tecla) pra liberar o áudio no navegador. */
export function resumeAudio(): void {
  ac();
  ensureSplash();
}

/** Splash de verdade (mp3 do pack do usuário). Carrega 1x; se falhar, usa o sintetizado. */
let splashBuf: AudioBuffer | null = null;
let splashLoading: Promise<void> | null = null;
let lastSplashAt = 0;

function ensureSplash(): void {
  if (splashBuf || splashLoading) return;
  splashLoading = (async () => {
    try {
      const res = await fetch('sounds/splash.mp3');
      if (!res.ok) return;
      const ab = await res.arrayBuffer();
      const c = ac();
      if (!c) return;
      splashBuf = await c.decodeAudioData(ab);
    } catch { /* mantém o sintetizado */ }
    finally {
      splashLoading = null;
    }
  })();
  void splashLoading;
}

function playSplashSample(): boolean {
  const c = ac();
  if (!c || !master || muted || !splashBuf) return false;
  try {
    const now = performance.now();
    if (now - lastSplashAt < 250) return true; // não empilha splash em cima de splash
    lastSplashAt = now;
    const src = c.createBufferSource();
    src.buffer = splashBuf;
    const g = c.createGain();
    g.gain.value = 0.7;
    src.connect(g);
    g.connect(master);
    src.start();
    return true;
  } catch {
    return false;
  }
}

export function isMuted(): boolean {
  return muted;
}

export function toggleMute(): boolean {
  muted = !muted;
  try {
    window.localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch { /* ignora */ }
  if (muted) stopSpeech();
  return muted;
}

/** NPC reclamando de verdade (voz do sistema, em inglês). Um de cada vez,
 *  sem fila: se já tem alguém falando, ignora (evita spam com 350 NPCs).
 *  Emoção pela pontuação e palavras: grito (!!!!), medo (PUT ME DOWN/CANNON),
 *  indignação (?) — cada uma com ritmo/tom/voz próprios. */
export function speakComplaint(text: string): void {
  if (muted) return;
  try {
    const ss = window.speechSynthesis;
    if (!ss) return;
    if (ss.speaking || ss.pending) return;
    const bangs = (text.match(/!/g) || []).length;
    const fear = /PUT ME DOWN|CANNON|FLY|MOM|FAMILY|SECURITY/i.test(text);
    const indignant = text.includes('?');
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    // medo = rápido e agudo; grito = rápido e alto; indignação = sobe no fim
    u.rate = (fear ? 1.35 : 1.1) + Math.random() * 0.2 + Math.min(0.2, bangs * 0.03);
    u.pitch = Math.min(
      2,
      (fear ? 1.4 : indignant ? 1.25 : 1.1) + Math.random() * 0.35 + Math.min(0.3, bangs * 0.05),
    );
    u.volume = 1;
    const vs = ss.getVoices();
    const ens = vs.filter((v) => v.lang && v.lang.toLowerCase().startsWith('en'));
    if (ens.length > 0) u.voice = ens[Math.floor(Math.random() * ens.length)]!;
    ss.speak(u);
  } catch { /* silencioso, nunca quebra o jogo */ }
}

export function stopSpeech(): void {
  try {
    const ss = window.speechSynthesis;
    if (ss && (ss.speaking || ss.pending)) ss.cancel();
  } catch { /* ignora */ }
}

function tone(o: { f: number; f2?: number; t?: OscillatorType; d: number; v?: number; at?: number }): void {
  const c = ac();
  if (!c || !master || muted) return;
  try {
    const t0 = c.currentTime + (o.at ?? 0);
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = o.t ?? 'sine';
    osc.frequency.setValueAtTime(Math.max(20, o.f), t0);
    if (o.f2) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.f2), t0 + o.d);
    const v = o.v ?? 0.5;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(v, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.d);
    osc.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + o.d + 0.05);
  } catch { /* nunca quebra o jogo */ }
}

function noise(o: { d: number; f?: number; f2?: number; q?: number; v?: number; at?: number; type?: BiquadFilterType }): void {
  const c = ac();
  if (!c || !master || muted) return;
  try {
    if (!noiseBuf) {
      noiseBuf = c.createBuffer(1, c.sampleRate, c.sampleRate);
      const ch = noiseBuf.getChannelData(0);
      for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
    }
    const t0 = c.currentTime + (o.at ?? 0);
    const src = c.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const flt = c.createBiquadFilter();
    flt.type = o.type ?? 'lowpass';
    flt.frequency.setValueAtTime(o.f ?? 1000, t0);
    if (o.f2) flt.frequency.exponentialRampToValueAtTime(Math.max(40, o.f2), t0 + o.d);
    flt.Q.value = o.q ?? 0.8;
    const g = c.createGain();
    const v = o.v ?? 0.5;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(v, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.d);
    src.connect(flt);
    flt.connect(g);
    g.connect(master);
    src.start(t0);
    src.stop(t0 + o.d + 0.05);
  } catch { /* nunca quebra o jogo */ }
}

/** Mugido: serra descendente com vibrato + passa-baixa. */
function moo(): void {
  const c = ac();
  if (!c || !master || muted) return;
  try {
    const t0 = c.currentTime;
    const osc = c.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(190, t0);
    osc.frequency.exponentialRampToValueAtTime(120, t0 + 0.55);
    const lfo = c.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 9;
    const lfoG = c.createGain();
    lfoG.gain.value = 14;
    lfo.connect(lfoG);
    lfoG.connect(osc.frequency);
    const flt = c.createBiquadFilter();
    flt.type = 'lowpass';
    flt.frequency.value = 750;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.5, t0 + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.62);
    osc.connect(flt);
    flt.connect(g);
    g.connect(master);
    osc.start(t0);
    lfo.start(t0);
    osc.stop(t0 + 0.7);
    lfo.stop(t0 + 0.7);
  } catch { /* nunca quebra o jogo */ }
}

export function playSfx(name: SfxName): void {
  if (muted) return;
  switch (name) {
    case 'click':
      tone({ f: 760, t: 'square', d: 0.06, v: 0.12 });
      break;
    case 'jump':
      tone({ f: 300, f2: 620, t: 'sine', d: 0.16, v: 0.35 });
      break;
    case 'thud':
      tone({ f: 130, f2: 55, t: 'sine', d: 0.2, v: 0.6 });
      noise({ d: 0.12, f: 500, v: 0.3 });
      break;
    case 'boom':
      noise({ d: 0.7, f: 2200, f2: 90, v: 0.7 });
      tone({ f: 70, f2: 30, t: 'sine', d: 0.6, v: 0.6 });
      break;
    case 'splash':
      ensureSplash();
      if (!playSplashSample()) {
        noise({ d: 0.4, f: 1400, f2: 500, v: 0.4, type: 'bandpass', q: 1.2 });
      }
      break;
    case 'coin':
      tone({ f: 880, t: 'sine', d: 0.09, v: 0.3 });
      tone({ f: 1318, t: 'sine', d: 0.16, v: 0.3, at: 0.09 });
      break;
    case 'moo':
      moo();
      break;
    case 'clang':
      tone({ f: 220, t: 'square', d: 0.25, v: 0.25 });
      tone({ f: 331, t: 'square', d: 0.22, v: 0.18, at: 0.02 });
      noise({ d: 0.15, f: 3000, v: 0.2, type: 'highpass' });
      break;
    case 'flop':
      tone({ f: 160, f2: 45, t: 'sine', d: 0.35, v: 0.6 });
      noise({ d: 0.25, f: 700, f2: 150, v: 0.4 });
      break;
  }
}
