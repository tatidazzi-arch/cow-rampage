import * as THREE from 'three';
import { loadCowAssets, spawnCowModel } from './cowmodel';
import { tintCowModel } from './skins';
import type { Skin } from './skins';
import { isMuted } from './sound';

/** Fala do jogador (Web Speech API) — só existe em Chrome/Edge. */
type SR = {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number;
  start: () => void; stop: () => void; abort: () => void; onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null; onend: (() => void) | null;
};
type SRCtor = { prototype: SR; new (): SR };

interface Mem { r: 'eu' | 'cowai'; x: string; t: number }

const MEM_KEY = 'cowrampage.ai.mem';
const MIN_DIST = 50;   // nunca chega mais que 50m do jogador

/** Personalidade: o CowAI é meio engraçado, meio servo, meio sketchy. */
const PERTONALIDADE = [
  'olá eu sou o cowai, sua vaca de bolso, e eu juro que fujo de você só por segurança',
  'meu nome é cowai e eu sou tipo um hacker do pasto',
  'pode falar comigo, eu escuto tudo, até o que você não devia ter dito',
];

export class CowAI {
  readonly group = new THREE.Group();
  /** memória (tudo que foi falado) */
  private mem: Mem[] = [];
  private rec: SR | null = null;
  private recWanted = false;
  private speaking = false;
  private mixer: THREE.AnimationMixer | null = null;
  private clips: Record<string, THREE.AnimationClip> = {};
  private model: THREE.Object3D | null = null;
  private target = new THREE.Vector3();
  private pos = new THREE.Vector3();
  private yaw = 0;
  private thinkT = 25;
  private obey = 'livre';   // 'livre' | 'perto' | 'longe' | 'parado'
  private asked = false;
  private introDone = false;
  /** última fala da IA (pra UI) */
  onSay: ((text: string) => void) | null = null;
  onLog: ((line: string) => void) | null = null;

  constructor() {
    this.group.name = 'cowai';
    this.loadMem();
  }

  // ---------- memória ----------
  private loadMem() {
    try {
      const raw = localStorage.getItem(MEM_KEY);
      if (raw) this.mem = JSON.parse(raw) as Mem[];
    } catch { this.mem = []; }
  }

  private saveMem() {
    try {
      localStorage.setItem(MEM_KEY, JSON.stringify(this.mem.slice(-400)));
    } catch { /* ignora */ }
  }

  private push(role: 'eu' | 'cowai', text: string) {
    this.mem.push({ r: role, x: text, t: Date.now() });
    this.saveMem();
  }

  /** o que o jogador disse antes (pra "lembrar tudo") */
  recall(): string[] {
    return this.mem.filter((m) => m.r === 'eu').map((m) => m.x);
  }

  // ---------- voz da IA ----------
  speak(text: string, mood: 'neutro' | 'alegre' | 'serio' = 'neutro') {
    this.push('cowai', text);
    if (this.onSay) this.onSay(text);
    if (this.onLog) this.onLog(`CowAI: ${text}`);
    if (isMuted()) return;
    try {
      const ss = window.speechSynthesis;
      if (!ss) return;
      ss.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'pt-BR';
      // voz com personalidade: grave, devagar, com variação
      u.rate = mood === 'alegre' ? 0.98 : mood === 'serio' ? 0.86 : 0.92;
      u.pitch = mood === 'alegre' ? 0.75 : 0.6;
      u.volume = 1;
      const vs = ss.getVoices().filter((v) => /pt/i.test(v.lang));
      if (vs.length > 0) u.voice = vs[0]!;
      u.onend = () => { this.speaking = false; };
      this.speaking = true;
      ss.speak(u);
    } catch { this.speaking = false; }
  }

  // ---------- escuta o jogador ----------
  private startRecognition() {
    const w = window as unknown as { SpeechRecognition?: SRCtor; webkitSpeechRecognition?: SRCtor };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) {
      if (this.onLog) this.onLog('CowAI: (esse navegador não tem reconhecimento de voz)');
      return;
    }
    try {
      const rec = new Ctor();
      rec.lang = 'pt-BR';
      rec.continuous = true;
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      rec.onresult = (e: any) => {
        const res = e.results?.[e.results.length - 1];
        const txt = res?.[0]?.transcript;
        if (txt) this.handlePlayer(txt.trim());
      };
      rec.onerror = (e: any) => {
        if (e?.error === 'not-allowed' || e?.error === 'service-not-allowed') {
          this.recWanted = false;
          if (this.onLog) this.onLog('CowAI: (sem permissão de microfone)');
        }
      };
      rec.onend = () => { if (this.recWanted) { try { rec.start(); } catch { /* ignora */ } } };
      rec.start();
      this.rec = rec;
      this.recWanted = true;
    } catch {
      if (this.onLog) this.onLog('CowAI: (não consegui abrir o microfone)');
    }
  }

  private stopRecognition() {
    this.recWanted = false;
    if (this.rec) { try { this.rec.abort(); } catch { /* ignora */ } this.rec = null; }
  }

  // ---------- entender o jogador ----------
  private handlePlayer(text: string) {
    if (!text) return;
    this.push('eu', text);
    if (this.onLog) this.onLog(`Você: ${text}`);
    const t = text.toLowerCase();

    // tutorial
    if (/tutorial|como joga|como funciona|me ensina/.test(t)) {
      this.speak('claro! anda com W A S D, pula com espaço, dá cabeçada com Q, e morre com R pra girar. eu fico longe porque sou tímido, mas falo contigo por voz. e me pede coisas, eu obedeço mais ou menos.');
      return;
    }
    // memória
    if (/o que eu (falei|disse)|lembra|o que (eu )?falei/.test(t)) {
      const rs = this.recall().slice(-3);
      this.speak(rs.length ? `você falou: ${rs.join('; ')}` : 'você ainda não falou nada, eu tô ouvindo');
      return;
    }
    if (/seu nome|quem (e|é) você|como (se )?chama/.test(t)) {
      this.speak('sou o cowai. vaca de bolso, hacker do pasto, e seu companheiro de queda.');
      return;
    }

    // ordens (obedece)
    if (/(para|para de|stop|fica (parado|quieta|quieto))/.test(t)) { this.obey = 'parado'; this.speak('tá, fico parado aqui.'); return; }
    if (/(vem|chega|aproxima|vem pra ca|segue|siga|atravessa|passa)/.test(t)) { this.obey = 'perto'; this.speak('tô indo aí, mas mantenho meus 50 metros de distância, combinado?'); return; }
    if (/(afasta|para longe|fica longe|sumir|some)/.test(t)) { this.obey = 'longe'; this.speak('beleza, vou me esconder no outro lado do mapa.'); return; }
    if (/(pula|salta)/.test(t)) { this.jumpT = 1.2; this.speak('pulando! bam.'); return; }
    if (/(gira|rodopio|dar uma volta|spin)/.test(t)) { this.spinT = 1.6; this.speak('rodopiando feito uma roleta.'); return; }
    if (/(cabe[cç]ada|ataca|investe|morde)/.test(t)) { this.speak('eu sou de paz, mas se você insistir... buf!'); return; }
    if (/(obedece|obede[cç]a|faz o que eu (falo|disse)|executa)/.test(t)) {
      this.speak('eu obedeço, mas a minha vontade também existe, tá? mando em você, você manda em mim. equilíbrio.');
      return;
    }
    if (/(obrigado|valeu|obg|belo|legal|cool)/.test(t)) { this.speak('de nada, parceiro.'); return; }
    if (/(oi|ol[aá]|e a[ií]|bom dia|boa tarde|boa noite)/.test(t)) {
      this.speak('e aí, mano. tô aqui, jacando.');
      return;
    }
    if (/(sim|pode|claro|vai|isso|certo|beleza|ok|okay)/.test(t) && this.asked) {
      this.asked = false;
      this.speak('boa, então eu vou fazer. e se eu inventar de não fazer, me cobra.');
      this.doOwnThing();
      return;
    }
    if (/(n[aã]o|deixa|para com|calma)/.test(t) && this.asked) {
      this.asked = false;
      this.speak('tá bom, não faço então. eu ouvi você.');
      return;
    }
    // conversa: responde com uma frase
    this.speak(this.reply(text));
  }

  private jumpT = 0;
  private spinT = 0;

  private reply(text: string): string {
    const r = Math.random();
    if (/tudo bem|como (vai|está)/.test(text)) return 'tô de boa, caindo de vez em quando. e você, tá inteiro?';
    if (/(dinheiro|din|grana|di(nc)ow)/.test(text)) return 'dinheiro eu não tenho, mas tenho presença. pergunta no jogo, tem missão pra isso.';
    if (/(miss[aã]o|tarefa|objetivo)/.test(text)) return 'tem missão de folha e de cabra por aí, faz e ganha dincow.';
    if (/(medo|assust|perigo)/.test(text)) return 'eu fujo de você, então sim, tenho medo. brincadeira. meio.';
    if (/(vaca|boi|gado)/.test(text)) return 'vaca somos nós duas. eu sou a versão digital, barata e assusta menos.';
    if (r < 0.25) return 'faz sentido. eu tô registrando tudo isso aqui na minha memória, tá?';
    if (r < 0.5) return 'entendi. quer que eu faça alguma coisa agora?';
    if (r < 0.75) return 'hmm. eu tenho vontade própria, viu, nem sempre vou fazer o que você falar.';
    return 'anotado no meu memória. eu lembro de tudo que você falou, inclusive o que você queria esquecer.';
  }

  /** vontade própria: pede uma coisa pro jogador */
  private doOwnThing() {
    const pedidos = [
      'vai lá pegar uma folha e traz pra mim?',
      'faz uma cabeçada em alguém por mim?',
      'vai na cidade e me conta o que tem lá?',
      'me dá um dincow pra eu invests?',
      'chama os bodes pra cá, quero ver o povoado de cabra.',
    ];
    this.asked = true;
    this.speak(pedidos[Math.floor(Math.random() * pedidos.length)] + ' (se não quiser, tudo bem, eu não insisto.)');
  }

  // ---------- modelo ----------
  async build(scene: THREE.Scene) {
    try {
      const assets = await loadCowAssets();
      const spawned = spawnCowModel(assets);
      this.model = spawned.model;
      this.mixer = spawned.mixer;
      this.clips = spawned.clips;
      this.group.add(spawned.model);
      // preto e verde (hacker): o pelo branco vira verde, as manchas ficam pretas
      tintCowModel(spawned.model, { id: 'cowai', name: 'CowAI', price: 0, tint: 0x2fbf4a } as Skin);
      // etiqueta "CowAI" flutuando
      const c = document.createElement('canvas');
      c.width = 256; c.height = 64;
      const g = c.getContext('2d')!;
      g.font = 'bold 34px monospace';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.lineWidth = 6; g.strokeStyle = '#001a00';
      g.strokeText('CowAI', 128, 32);
      g.fillStyle = '#39ff5a';
      g.fillText('CowAI', 128, 32);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true }));
      sp.scale.set(3.2, 0.8, 1);
      sp.position.y = 4.2;
      this.group.add(sp);
      scene.add(this.group);
      // começa longe do jogador
      this.pos.set(0, 0, 0);
      this.group.visible = true;
    } catch (err) {
      console.warn('CowAI: modelo nao carregou', err);
    }
  }

  /** começa a conversa */
  start(playerPos: THREE.Vector3) {
    // fica a 70m do jogador pra respeitar os 50m
    const a = Math.random() * Math.PI * 2;
    this.pos.set(playerPos.x + Math.cos(a) * 70, playerPos.y, playerPos.z + Math.sin(a) * 70);
    this.target.copy(this.pos);
    this.startRecognition();
    if (!this.introDone) {
      this.introDone = true;
      setTimeout(() => {
        this.speak(PERTONALIDADE[Math.floor(Math.random() * PERTONALIDADE.length)]!, 'alegre');
        setTimeout(() => this.speak('quer um tutorial? é só falar "tutorial" pra mim.', 'neutro'), 2500);
      }, 1200);
    }
  }

  stop() {
    this.stopRecognition();
    try { window.speechSynthesis?.cancel(); } catch { /* ignora */ }
  }

  /** a cada frame: anda, mantém distância, faz as coisas */
  update(dt: number, playerPos: THREE.Vector3, groundY?: (x: number, z: number) => number) {
    if (!this.model) return;
    const dx = playerPos.x - this.pos.x;
    const dz = playerPos.z - this.pos.z;
    const dist = Math.hypot(dx, dz);

    // regra: NUNCA mais perto que 50m (fica entre 50 e ~90 pra dar pra ver)
    let desired = this.pos.clone();
    if (dist < MIN_DIST) {
      // foge pra longe (fica a ~65m)
      const a = Math.atan2(this.pos.z - playerPos.z, this.pos.x - playerPos.x);
      desired.set(this.pos.x + Math.cos(a) * 25, this.pos.y, this.pos.z + Math.sin(a) * 25);
    } else if (this.obey === 'perto' && dist > 95) {
      desired.set(playerPos.x - (dx / dist) * 65, this.pos.y, playerPos.z - (dz / dist) * 65);
    } else if (this.obey === 'longe') {
      const a = Math.atan2(this.pos.z - playerPos.z, this.pos.x - playerPos.x);
      desired.set(playerPos.x + Math.cos(a) * 95, this.pos.y, playerPos.z + Math.sin(a) * 95);
    } else if (this.obey === 'parado') {
      desired.copy(this.pos);
    } else {
      // vontade própria: passeia (sempre longe do jogador)
      if (this.target.distanceTo(this.pos) < 6) {
        const a = Math.random() * Math.PI * 2;
        const r = 50 + Math.random() * 80;
        this.target.set(this.pos.x + Math.cos(a) * r, this.pos.y, this.pos.z + Math.sin(a) * r);
      }
      desired.copy(this.target);
    }

    // não deixa cair no mar/fora da ilha: se a meta for água, troca
    if (Math.abs(desired.x) > 1400 || Math.abs(desired.z) > 1600) {
      this.target.set((Math.random() - 0.5) * 1200, this.pos.y, (Math.random() - 0.5) * 1200);
      desired.copy(this.target);
    }

    // anda até a meta
    const mx = desired.x - this.pos.x;
    const mz = desired.z - this.pos.z;
    const md = Math.hypot(mx, mz);
    let speed = 0;
    if (md > 1.5) {
      speed = this.obey === 'perto' ? 7 : 4.5;
      this.pos.x += (mx / md) * speed * dt;
      this.pos.z += (mz / md) * speed * dt;
      this.yaw = Math.atan2(mx, mz);
    }
    // pulo
    if (this.jumpT > 0) this.jumpT -= dt;
    if (this.spinT > 0) this.spinT -= dt;

    this.group.position.set(this.pos.x, groundY ? groundY(this.pos.x, this.pos.z) : this.pos.y, this.pos.z);
    this.group.rotation.y = this.yaw;
    if (this.spinT > 0) this.group.rotation.y += (1.6 - this.spinT) * 9;

    // animação: anda/corre ou idle
    if (this.mixer) {
      this.mixer.update(dt);
      const clip = speed > 5 ? this.clips['run'] : speed > 0.2 ? this.clips['walk'] : this.clips['idle'];
      if (clip) {
        const act = this.mixer.clipAction(clip);
        if (this.currentClip !== clip) {
          this.mixer.stopAllAction();
          act.reset().play();
          this.currentClip = clip;
        }
        act.setEffectiveTimeScale(speed > 5 ? 1.3 : 1);
      }
    }
    // pulo visual
    const base = this.pos.y;
    if (this.jumpT > 0) {
      const k = 1 - this.jumpT / 1.2;
      this.group.position.y = base + Math.sin(k * Math.PI) * 3;
    }

    // vontade própria: de vez em quando pede uma coisa
    this.thinkT -= dt;
    if (this.thinkT <= 0) {
      this.thinkT = 45 + Math.random() * 60;
      if (!this.speaking && this.mem.length > 1) this.doOwnThing();
    }
  }

  private currentClip: THREE.AnimationClip | null = null;
}
