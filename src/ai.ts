import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Cow, COW_SCALE } from './cow';
import { isSweater } from './npc';
import type { NPCPhysics } from './npc';
import { isMuted } from './sound';
import { BALL, BRIDGE, CEMETERY, CITY, FOREST, GOATS, MANSION, MINE } from './world';

/** ====== voz do jogador (Web Speech API) ====== */
type SR = {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number;
  start: () => void; stop: () => void; abort: () => void;
  onresult: ((e: any) => void) | null; onerror: ((e: any) => void) | null; onend: (() => void) | null;
};
type SRCtor = { prototype: SR; new (): SR };

type Style = 'engraido' | 'esperto' | 'curto' | 'carinhoso' | 'nervoso';

interface Mem { r: 'eu' | 'cowai'; x: string; t: number }
interface Pref { [k: string]: number }

/** Vocabulário do CowAI: várias categorias, cada linha com um estilo. */
const VOCAB: Record<string, { s: Style; x: string }[]> = {
  apresentacao: [
    { s: 'esperto', x: 'cowai no sistema. sou a versão de bolso, assusta menos e lembra mais.' },
    { s: 'engraido', x: 'e aí, eu sou o cowai, hacker do pasto, e eu fujo de você por-principios éticos.' },
    { s: 'curto', x: 'cowai. fala comigo.' },
    { s: 'carinhoso', x: 'oi! eu sou o cowai. bom te ver por aqui.' },
  ],
  oi: [
    { s: 'engraido', x: 'e aí, mano. tô aqui jacando.' },
    { s: 'curto', x: 'oi!' },
    { s: 'esperto', x: 'salve. o que a gente faz hoje?' },
    { s: 'carinhoso', x: 'oi! que bom te ver.' },
  ],
  tutorial: [
    { s: 'esperto', x: 'anda com WASD, pula com espaço, cabeçada no Q, mortal no R, e troca o aparelho em 1 2 3. eu fico longe uns 50 metros porque sou tímido, mas te ouço.' },
    { s: 'engraido', x: 'regra do jogo: WASD anda, espaço pula, Q é cabeçada (derruba gente), R é o mortal (gira). e falando nisso, eu tô a 50 metros de você, respeitando sua senha.' },
    { s: 'curto', x: 'WASD anda. espaço pula. Q cabeçada. R mortal. 1 2 3 aparelho.' },
    { s: 'carinhoso', x: 'é fácil: WASD pra andar, espaço pra pular, Q pra dar cabeçada, R pro mortal, 1 2 3 pro aparelho. e me chama se travar.' },
  ],
  memoria: [
    { s: 'esperto', x: 'eu lembro de tudo que você falou. as últimas foram: {ultimas}' },
    { s: 'engraido', x: 'tá tudo gravado aqui na minha memória de arquivo morto. as últimas: {ultimas}' },
    { s: 'curto', x: 'você falou: {ultimas}' },
  ],
  piada: [
    { s: 'engraido', x: 'por que a vaca foi pra cidade? pra moer o pão.' },
    { s: 'engraido', x: 'o que uma vaca fala quando entra no banco? möööo, cadê meu agiota?' },
    { s: 'engraido', x: 'vaca programadora: ela tem Pascal e tem Milk.' },
    { s: 'engraido', x: 'a vaca clever demais? aí ela éClever demais.' },
    { s: 'esperto', x: 'nojaponês, vaca se diz "ushi". eu sou ushi, mas com senha.' },
  ],
  elogio: [
    { s: 'carinhoso', x: 'valeu! tô/meBrooklyn melhorando a cadacompile.' },
    { s: 'engraido', x: 'obrigado, isso vai pro meu ego de 64 bits.' },
    { s: 'curto', x: 'valeu mesmo!' },
    { s: 'esperto', x: 'obrigado. meu log de reforço agradece.' },
  ],
  bronca: [
    { s: 'nervoso', x: 'tá, tá, eu paro. desculpa.' },
    { s: 'engraido', x: 'tá bom, chefe. mas minha vontade própria vai voltar em uns 5 minutos.' },
    { s: 'curto', x: 'ok, parei.' },
    { s: 'esperto', x: 'entendido. mudo de rota.' },
  ],
  pergunta_jogo: [
    { s: 'esperto', x: 'tem missão de suéter no mapa: ache o homem de suéter amarelo, laranja, vinho ou roxo, dê cabeçada e traga. e missão de cabra em goat town.' },
    { s: 'curto', x: 'missão de suéter: ache o cara de suéter colorido e cabeceie ele.' },
    { s: 'engraido', x: 'tem trabalho pra mim e pra você: suéter colorido na cidade, e os bichos de cabra no povoado.' },
  ],
  ideia: [
    { s: 'esperto', x: 'ideia: a gente podia caçar o suéter amarelo juntos. eu marco, você cabeceia.' },
    { s: 'engraido', x: 'ideia maluca: e se a gente desse cabeçada em todo mundo do goat town? chaos bonito.' },
    { s: 'carinhoso', x: 'ideia: eu vou pegar um suéter pra você enquanto você limpa a cidade.分开 trabalho.' },
    { s: 'curto', x: 'ideia: eu pego o suéter, você cabeceia o resto.' },
  ],
  sem_entender: [
    { s: 'esperto', x: 'não entendi essa. fala de novo, mais devagar?' },
    { s: 'curto', x: 'como assim?' },
    { s: 'engraido', x: 'meu ouvido de vaca pegou essa pela metade. repete?' },
    { s: 'nervoso', x: 'hmm, isso não chegou direito. de novo?' },
  ],
  sim: [
    { s: 'curto', x: 'beleza, fechado.' },
    { s: 'engraido', x: 'isso! vamo nessa.' },
    { s: 'esperto', x: 'executando.' },
  ],
  nao: [
    { s: 'curto', x: 'beleza, não faço então.' },
    { s: 'esperto', x: 'entendido, mudo o plano.' },
    { s: 'nervoso', x: 'tá... tudo bem. eu ouvi.' },
  ],
  despedida: [
    { s: 'curto', x: 'flw, tchau!' },
    { s: 'engraido', x: 'vou continuar pastando por aqui. me chama.' },
    { s: 'carinhoso', x: 'vai lá! tô por aqui.' },
  ],
};

const PLACE_ALIASES: Record<string, () => { x: number; z: number; nome: string }> = {
  ponte: () => ({ x: (BRIDGE.x0 + BRIDGE.x1) / 2, z: (BRIDGE.z0 + BRIDGE.z1) / 2, nome: 'a ponte' }),
  bridge: () => ({ x: (BRIDGE.x0 + BRIDGE.x1) / 2, z: (BRIDGE.z0 + BRIDGE.z1) / 2, nome: 'a ponte' }),
  cidade: () => ({ x: CITY.x, z: CITY.z, nome: 'a cidade' }),
  city: () => ({ x: CITY.x, z: CITY.z, nome: 'a cidade' }),
  mansao: () => ({ x: MANSION.x, z: MANSION.z, nome: 'a mansão' }),
  casa: () => ({ x: MANSION.x, z: MANSION.z, nome: 'a mansão' }),
  cemiterio: () => ({ x: CEMETERY.x, z: CEMETERY.z, nome: 'o cemitério' }),
  floresta: () => ({ x: FOREST.x, z: FOREST.z, nome: 'a floresta' }),
  mato: () => ({ x: FOREST.x, z: FOREST.z, nome: 'a floresta' }),
  minas: () => ({ x: MINE.x, z: MINE.z, nome: 'as minas' }),
  vulcao: () => ({ x: MINE.x, z: MINE.z, nome: 'o vulcão' }),
  fazenda: () => ({ x: BALL.x, z: BALL.z, nome: 'a fazenda' }),
  cabras: () => ({ x: GOATS.x, z: GOATS.z, nome: 'goat town' }),
  bodes: () => ({ x: GOATS.x, z: GOATS.z, nome: 'goat town' }),
  cabra: () => ({ x: GOATS.x, z: GOATS.z, nome: 'goat town' }),
  loja: () => ({ x: 0, z: 0, nome: 'a loja' }),
};

const MIN_DIST = 50;

/** distância de Levenshtein (tolerância a erro de digitação/fala) */
function dist(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 3) return 99;
  const dp = new Array(n + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[n];
}

export class CowAI {
  /** a vaca da IA (física de verdade: pode levar cabeçada, cair, tombar) */
  cow: Cow;
  private world: RAPIER.World;
  private mem: Mem[] = [];
  private rec: SR | null = null;
  private recWanted = false;
  private speaking = false;
  /** o que aprendeu: preferências por estilo e correções do jogador */
  private prefs: Pref = {};
  private learned: Record<string, string> = {};  // frase -> intenção (o que aprendeu)
  private actions: Pref = {};       // ação -> quanto deu resultado
  private confuse: Pref = {};       // frase -> tentativas
  private obey = 'livre';
  private asked = false;
  private introDone = false;
  private thinkT = 20;
  private confused = 0;             // vezes que não entendeu (recentemente)
  private lastAction = 'livre';     // última ação que a IA fez (pra learning)
  private lastSaid = '';
  /** destino atual (lugar ou alvo) */
  private goal: { x: number; z: number; nome: string } | null = null;
  private goalT = 0;
  private wander = new THREE.Vector3();
  private jumpT = 0;
  private spinT = 0;
  private ray: RAPIER.Ray | null = null;
  /** o que a IA está caçando (missão de suéter) */
  private prey: NPCPhysics | null = null;
  private preyGot = false;

  onSay: ((text: string) => void) | null = null;
  onLog: ((line: string) => void) | null = null;
  /** a IA ganha uma missão pro jogador */
  onDeliver: ((kind: string) => void) | null = null;

  constructor(scene: THREE.Scene, world: RAPIER.World) {
    this.world = world;
    this.cow = new Cow(scene, world, 200, 200);
    this.cow.setSkin({ id: 'cowai', name: 'CowAI', price: 0, tint: 0x2fbf4a });
    this.loadAll();
  }

  // ================= memória / aprendizado =================
  private loadAll() {
    try {
      const raw = localStorage.getItem('cowrampage.ai.mem');
      if (raw) this.mem = JSON.parse(raw) as Mem[];
      const p = localStorage.getItem('cowrampage.ai.prefs');
      if (p) this.prefs = JSON.parse(p) as Pref;
      const l = localStorage.getItem('cowrampage.ai.learned');
      if (l) this.learned = JSON.parse(l) as Record<string, string>;
      const a = localStorage.getItem('cowrampage.ai.actions');
      if (a) this.actions = JSON.parse(a) as Pref;
    } catch { /* começa do zero */ }
  }

  private saveAll() {
    try {
      localStorage.setItem('cowrampage.ai.mem', JSON.stringify(this.mem.slice(-500)));
      localStorage.setItem('cowrampage.ai.prefs', JSON.stringify(this.prefs));
      localStorage.setItem('cowrampage.ai.learned', JSON.stringify(this.learned));
      localStorage.setItem('cowrampage.ai.actions', JSON.stringify(this.actions));
    } catch { /* ignora */ }
  }

  private push(role: 'eu' | 'cowai', text: string) {
    this.mem.push({ r: role, x: text, t: Date.now() });
    this.saveAll();
  }

  /** o que aprendeu com o jogador: estilo preferido, correções, ações que deram certo */
  private learn(key: string, delta: number) {
    this.prefs[key] = (this.prefs[key] ?? 0) + delta;
    this.saveAll();
  }

  private bestStyle(cat: string): Style {
    const opts = VOCAB[cat] ?? VOCAB['oi'];
    let best = opts[0]!;
    let bestScore = -Infinity;
    for (const o of opts) {
      const s = this.prefs[`${cat}:${o.s}`] ?? 0;
      if (s > bestScore) { bestScore = s; best = o; }
    }
    return best.s;
  }

  // ================= fala =================
  speak(cat: string, vars: Record<string, string> = {}, mood: 'neutro' | 'alegre' | 'serio' = 'neutro') {
    const opts = VOCAB[cat] ?? VOCAB['oi'];
    const st = this.bestStyle(cat);
    const pool = opts.filter((o) => o.s === st);
    const pick = pool[Math.floor(Math.random() * pool.length)] ?? opts[0]!;
    let text = pick.x;
    for (const [k, v] of Object.entries(vars)) text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
    if (text === this.lastSaid && opts.length > 1) {
      const alt = opts[(opts.indexOf(pick) + 1) % opts.length]!;
      text = alt.x;
      for (const [k, v] of Object.entries(vars)) text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
    }
    this.lastSaid = text;
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
      u.rate = mood === 'alegre' ? 1.0 : mood === 'serio' ? 0.85 : 0.93;
      u.pitch = mood === 'alegre' ? 0.8 : 0.62;
      const vs = ss.getVoices().filter((v) => /pt/i.test(v.lang));
      if (vs.length > 0) u.voice = vs[0]!;
      u.onend = () => { this.speaking = false; };
      this.speaking = true;
      ss.speak(u);
    } catch { this.speaking = false; }
  }

  // ================= escuta =================
  private startRecognition() {
    const w = window as unknown as { SpeechRecognition?: SRCtor; webkitSpeechRecognition?: SRCtor };
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) { this.speak('sem_entender'); return; }
    try {
      const rec = new Ctor();
      rec.lang = 'pt-BR';
      rec.continuous = true;
      rec.interimResults = false;
      rec.maxAlternatives = 3;
      rec.onresult = (e: any) => {
        const res = e.results?.[e.results.length - 1];
        if (!res) return;
        // testa as alternativas: a que a IA entende tem prioridade (aprendizado)
        const alts: string[] = [];
        for (let i = 0; i < (res.length ?? 1); i++) alts.push(String(res[i]?.transcript ?? '').trim());
        this.handlePlayer(alts);
      };
      rec.onerror = (e: any) => {
        if (e?.error === 'not-allowed') { this.recWanted = false; }
      };
      rec.onend = () => { if (this.recWanted) { try { rec.start(); } catch { /* ignora */ } } };
      rec.start();
      this.rec = rec;
      this.recWanted = true;
    } catch { /* sem microfone */ }
  }

  private stopRecognition() {
    this.recWanted = false;
    if (this.rec) { try { this.rec.abort(); } catch { /* ignora */ } this.rec = null; }
  }

  // ================= entende o jogador =================
  private handlePlayer(alts: string[]) {
    const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    let best: { txt: string; intent: string; score: number } | null = null;
    for (const alt of alts) {
      if (!alt) continue;
      const n = norm(alt);
      // 1) o que o jogador já corrigiu antes (oAprendizado mais forte)
      if (this.learned[n]) {
        best = { txt: alt, intent: this.learned[n]!, score: 1000 };
        break;
      }
      // 2) intenção por palavra-chave
      const intent = this.matchIntent(n);
      const score = intent ? 100 + intent.length : 0;
      if (intent && (!best || score > best.score)) best = { txt: alt, intent, score };
    }
    if (!best) {
      // não entendeu: guarda a frase pra aprender depois
      const n = norm(alts[0] ?? '');
      if (n) this.confuse[n] = (this.confuse[n] ?? 0) + 1;
      this.confused++;
      this.speak('sem_entender');
      return;
    }
    this.confused = 0;
    this.push('eu', best.txt);
    if (this.onLog) this.onLog(`Você: ${best.txt}`);
    this.act(best.intent, best.txt);
  }

  /** casa a frase com uma intenção (palavras-chave +近似 por erro de digitação) */
  private matchIntent(n: string): string | null {
    const RULES: Record<string, string[]> = {
      tutorial: ['tutorial', 'como joga', 'como funciona', 'me ensina', 'explica', 'controles'],
      memoria: ['o que eu falei', 'o que eu disse', 'lembra', 'o que eu falei antes', 'repete'],
      nome: ['seu nome', 'quem e voce', 'quem e', 'como se chama', 'como vc se chama'],
      piada: ['piada', 'conta uma', 'engra', 'humor', 'faz piada'],
      ponte: ['ponte', 'bridge', 'vai pra ponte', 'va pra ponte', 'passa na ponte'],
      cidade: ['cidade', 'city', 'vai pra cidade', 'centro'],
      mansao: ['mansao', 'casa grande', 'vai pra mansao', 'palacio'],
      cemiterio: ['cemiterio', 'tumbas', 'vai pro cemiterio'],
      floresta: ['floresta', 'mato', 'arvores', 'vai pra floresta'],
      minas: ['minas', 'vulcao', 'mina', 'vai pras minas'],
      fazenda: ['fazenda', 'fazenda2', 'vai pra fazenda', 'past'],
      cabras: ['cabras', 'bodes', 'goat', 'cidade das cabras', 'vai pras cabras'],
      loja: ['loja', 'skin', 'skins', 'vai na loja'],
      atacar: ['ataca', 'cabeceia', 'cabeçada', 'investe', 'morde', 'bate em', 'derruba todo', 'bate em todo', 'manda bala', 'atropela'],
      sueter: ['sueter', 'camisa de suéter', 'missao do suéter', 'pega o sueter', 'achar o sueter'],
      seguir: ['vem', 'segue', 'siga', 'aproxima', 'chega', 'vem ca', 'vem pra ca'],
      longe: ['afasta', 'fica longe', 'sumir', 'some', 'vai pra longe', 'para longe'],
      parar: ['para', 'fica parado', 'fica quieto', 'stop', 'descansa'],
      pular: ['pula', 'salta', 'pula ai'],
      girar: ['gira', 'rodopio', 'spin', 'da uma volta'],
      elogio: ['obrigado', 'valeu', 'obg', 'beleza', 'legal', 'massa', 'show', 'foda', 'muito bom', 'parabens'],
      bronca: ['calado', 'chato', 'para de', 'cansou', 'obrigado nao', 'nao gosto', 'silencio'],
      sim: ['sim', 'pode', 'claro', 'vai', 'isso', 'certo', 'beleza', 'ok', 'okay', 'manda', 'faz'],
      nao: ['nao', 'deixa', 'melhor nao', 'cancel', 'para com isso'],
      ideia: ['ideia', 'sugestao', 'o que a gente faz', 'ideia ai'],
      adeus: ['tchau', 'flw', 'ate logo', 'vou embora', 'falou'],
      corrigir: ['nao era isso', 'eu quis dizer', 'queria dizer', 'era pra', 'corrigindo', 'nao, era'],
      oi: ['oi', 'ola', 'e ai', 'bom dia', 'boa tarde', 'boa noite', 'salve', 'opa'],
    };
    for (const [intent, keys] of Object.entries(RULES)) {
      for (const k of keys) {
        if (n.includes(k)) return intent;
      }
    }
    // erro de digitação/fala: tenta casar com distância pequena
    const words = n.split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
    for (const w of words) {
      for (const [intent, keys] of Object.entries(RULES)) {
        for (const k of keys) {
          if (k.length >= 4 && dist(w, k.replace(/[^a-z0-9]/g, '')) <= 2) return intent;
        }
      }
    }
    return null;
  }

  /** executa a intenção */
  private act(intent: string, raw: string) {
    const n = raw.toLowerCase();
    switch (intent) {
      case 'tutorial':
        this.speak('tutorial');
        return;
      case 'memoria': {
        const us = this.mem.filter((m) => m.r === 'eu').slice(-3).map((m) => m.x);
        this.speak('memoria', { ultimas: us.length ? us.join('; ') : 'nada ainda' });
        return;
      }
      case 'nome':
        this.speak('apresentacao');
        return;
      case 'piada':
        this.speak('piada');
        return;
      case 'ponte': case 'cidade': case 'mansao': case 'cemiterio':
      case 'floresta': case 'minas': case 'fazenda': case 'cabras': case 'loja': {
        const key = intent;
        const place = PLACE_ALIASES[key]?.() ?? PLACE_ALIASES[Object.keys(PLACE_ALIASES).find((k) => k.startsWith(key))!]?.();
        if (place) {
          this.goal = { x: place.x, z: place.z, nome: place.nome };
          this.goalT = 45;
          this.obey = 'perto';
          this.speak('sim', {}, 'alegre');
          this.sayCustom(`beleza, tô indo pra ${place.nome}.`);
        }
        return;
      }
      case 'atacar': {
        this.goal = null;
        this.obey = 'atacar';
        this.goalT = 30;
        this.lastAction = 'atacar';
        this.speak('sim', {}, 'alegre');
        this.sayCustom('pode deixar, vou passar batido em tudo que tiver pela frente.');
        return;
      }
      case 'sueter': {
        this.obey = 'sueter';
        this.goalT = 60;
        this.lastAction = 'sueter';
        this.speak('sim', {}, 'alegre');
        this.sayCustom('vou caçar um suéter pra você.');
        return;
      }
      case 'seguir':
        this.obey = 'perto';
        this.goal = null;
        this.speak('sim');
        return;
      case 'longe':
        this.obey = 'longe';
        this.speak('sim');
        return;
      case 'parar':
        this.obey = 'parado';
        this.goal = null;
        this.speak('sim');
        return;
      case 'pular':
        this.jumpT = 1.1;
        this.speak('sim');
        return;
      case 'girar':
        this.spinT = 1.6;
        this.speak('sim');
        return;
      case 'elogio':
        this.feedback(true, 'elogio');
        this.learn('geral:acao:' + (this.lastAction || 'livre'), 1);
        this.speak('elogio');
        return;
      case 'bronca':
        this.feedback(false, 'bronca');
        this.learn('geral:acao:' + (this.lastAction || 'livre'), -1);
        this.speak('bronca');
        return;
      case 'corrigir': {
        // "não era isso, era 'vai pra ponte'" → ela guarda a lição
        const m = n.match(/era\s+['"]?([^'"]+?)['"]?\s*$/);
        if (m && m[1]) {
          const phrase = m[1].trim();
          const it = this.matchIntent(phrase);
          if (it) {
            this.learnCorrection(phrase, it);
            this.act(it, phrase);
            return;
          }
        }
        this.speak('sem_entender');
        return;
      }
      case 'sim':
        if (this.asked) {
          this.asked = false;
          this.feedback(true, 'ideia');
          this.doOwnThing();
        } else this.speak('sim');
        return;
      case 'nao':
        if (this.asked) {
          this.asked = false;
          this.feedback(false, 'ideia');
          this.learn('geral:acao:' + (this.lastAction || 'livre'), -1);
          this.speak('nao');
        } else this.speak('nao');
        return;
      case 'ideia':
        this.speak('ideia');
        return;
      case 'adeus':
        this.speak('adeus');
        return;
      case 'oi':
        this.speak('oi');
        return;
      default:
        this.speak('sem_entender');
    }
    // se não entendeu mas a frase é parecida com algo já corrigido: aprende
    const key = n.trim();
    if (key && !this.learned[key]) {
      this.confuse[key] = (this.confuse[key] ?? 0) + 1;
    }
  }

  /** o jogador corrigiu: "não, eu quis dizer X" → a IA guarda a lição */
  private learnCorrection(phrase: string, intent: string) {
    const key = phrase.toLowerCase().trim();
    if (!key) return;
    this.learned[key] = intent;
    this.saveAll();
    this.sayCustom('anotado. da próxima vez eu já sei.');
  }

  /** o jogador elogiou/reclamou: a IA ajusta o estilo e a ação */
  private feedback(positive: boolean, category: string) {
    const st = this.bestStyle(category);
    this.learn(`${category}:${st}`, positive ? 1 : -1);
    if (positive) this.learn('geral:positivo', 1);
    else this.learn('geral:negativo', 1);
  }

  private sayCustom(text: string) {
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
      u.rate = 0.95;
      u.pitch = 0.65;
      const vs = ss.getVoices().filter((v) => /pt/i.test(v.lang));
      if (vs.length > 0) u.voice = vs[0]!;
      u.onend = () => { this.speaking = false; };
      this.speaking = true;
      ss.speak(u);
    } catch { this.speaking = false; }
  }

  /** vontade própria = dá ideias e age sozinho */
  private doOwnThing() {
    this.asked = true;
    const ideas = [
      'ideia: eu caço um suéter pra você enquanto você limpa a cidade.分开 trabalho, tá?',
      'ideia: bora dar uma volta na ponte? eu faço o caminho, você vai no embalo.',
      'ideia: tem um vulcão lá atrás, se você quiser um spectacle... eu aviso quando estiver perto.',
      'ideia: eu posso passar batido nos NPCs do goat town pra você. você me manda o sinal?',
    ];
    this.sayCustom(ideas[Math.floor(Math.random() * ideas.length)]!);
  }

  // ================= início =================
  start(playerPos: THREE.Vector3) {
    const a = Math.random() * Math.PI * 2;
    this.cow.body.setTranslation({
      x: playerPos.x + Math.cos(a) * 70,
      y: playerPos.y + 3,
      z: playerPos.z + Math.sin(a) * 70,
    }, true);
    this.cow.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.wander.set(playerPos.x + Math.cos(a) * 90, 0, playerPos.z + Math.sin(a) * 90);
    this.startRecognition();
    if (!this.introDone) {
      this.introDone = true;
      setTimeout(() => {
        this.speak('apresentacao', {}, 'alegre');
        setTimeout(() => this.speak('ideia'), 2200);
      }, 1500);
    }
  }

  stop() {
    this.stopRecognition();
    try { window.speechSynthesis?.cancel(); } catch { /* ignora */ }
  }

  // ================= cérebro: joga e obedece =================
  update(dt: number, playerPos: THREE.Vector3, npcs: NPCPhysics[], groundY: (x: number, z: number) => number) {
    const body = this.cow.body;
    const t = body.translation();
    const v = body.linvel();

    // chão (raycast igual o do jogador)
    if (!this.ray) this.ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    this.ray.origin.x = t.x; this.ray.origin.y = t.y; this.ray.origin.z = t.z;
    const hit = this.world.castRay(this.ray, 1.1 * COW_SCALE + 0.6, true,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, body);
    const grounded = hit !== null;

    // ---- escolhe o destino ----
    const dxp = playerPos.x - t.x;
    const dzp = playerPos.z - t.z;
    const distP = Math.hypot(dxp, dzp);
    let tx = t.x, tz = t.z, speed = 0;

    // prioridade 1: distância mínima (50m) — a IA foge se você chegar perto
    if (distP < MIN_DIST) {
      // foge pra ~65m (sempre acima dos 50m de regra)
      const a = Math.atan2(t.z - playerPos.z, t.x - playerPos.x);
      tx = playerPos.x + Math.cos(a) * 65;
      tz = playerPos.z + Math.sin(a) * 65;
      speed = 9;
    } else if (this.goal && this.goalT > 0) {
      // prioridade 2: ordem do jogador (ir pra um lugar)
      this.goalT -= dt;
      tx = this.goal.x; tz = this.goal.z;
      speed = 8;
      if (Math.hypot(tx - t.x, tz - t.z) < 14) {
        this.sayCustom(`cheguei em ${this.goal.nome}.`);
        this.goal = null;
        this.goalT = 0;
      }
    } else if (this.obey === 'atacar') {
      // prioridade 3: atacar quem tiver na frente
      this.goalT -= dt;
      let best: NPCPhysics | null = null;
      let bestD = 26;
      for (const n of npcs) {
        if (n.vendor || n.state === 'carried' || n.state === 'inCannon') continue;
        const p = n.body.translation();
        const d = Math.hypot(p.x - t.x, p.z - t.z);
        if (d < bestD) { bestD = d; best = n; }
      }
      if (best) {
        const p = best.body.translation();
        tx = p.x; tz = p.z; speed = 8;
        if (bestD < 3.6) {
          // cabeçada da IA
          const dx = p.x - t.x, dz = p.z - t.z;
          const l = Math.hypot(dx, dz) || 1;
          best.body.applyImpulse({ x: (dx / l) * 150, y: 110, z: (dz / l) * 150 }, true);
          this.sayCustom('toma essa!');
          this.actions['atacar'] = (this.actions['atacar'] ?? 0) + 1;
          this.goalT = Math.min(this.goalT, 12);
        }
      } else {
        tx = this.wander.x; tz = this.wander.z; speed = 4;
      }
      if (this.goalT <= 0) { this.obey = 'livre'; }
    } else if (this.obey === 'sueter') {
      // caça o homem de suéter (missão do jogador, mas a IA ajuda)
      this.goalT -= dt;
      if (!this.prey || this.prey.state === 'carried' || this.prey.state === 'inCannon') {
        this.prey = npcs.find((n) => isSweater(n) && n.state === 'walk') ?? null;
      }
      if (this.prey) {
        const p = this.prey.body.translation();
        tx = p.x; tz = p.z; speed = 8;
        if (Math.hypot(p.x - t.x, p.z - t.z) < 3.6) {
          const dx = p.x - t.x, dz = p.z - t.z;
          const l = Math.hypot(dx, dz) || 1;
          this.prey.body.applyImpulse({ x: (dx / l) * 160, y: 115, z: (dz / l) * 160 }, true);
          this.prey = null;
          this.preyGot = true;
          this.obey = 'livre';
          this.sayCustom('achei um suéter! já é seu, ou quer que eu leve?');
          if (this.onDeliver) this.onDeliver('sueter');
        }
      } else {
        tx = this.wander.x; tz = this.wander.z; speed = 4.5;
      }
      if (this.goalT <= 0) this.obey = 'livre';
    } else if (this.obey === 'perto' && distP > 95) {
      tx = playerPos.x - (dxp / distP) * 65;
      tz = playerPos.z - (dzp / distP) * 65;
      speed = 7;
    } else if (this.obey === 'longe') {
      const a = Math.atan2(t.z - playerPos.z, t.x - playerPos.x);
      tx = playerPos.x + Math.cos(a) * 95;
      tz = playerPos.z + Math.sin(a) * 95;
      speed = 7;
    } else if (this.obey === 'parado') {
      tx = t.x; tz = t.z; speed = 0;
    } else {
      // vontade própria: joga sozinho (vai caçar suéter, chutar NPCs, passear)
      this.goalT -= dt;
      if (this.goalT <= 0) {
        this.goalT = 20 + Math.random() * 25;
        const roll = Math.random();
        if (roll < 0.4) this.obey = 'sueter';
        else if (roll < 0.7) this.obey = 'atacar';
        else {
          this.obey = 'livre';
          const a = Math.random() * Math.PI * 2;
          const r = 60 + Math.random() * 120;
          this.wander.set(playerPos.x + Math.cos(a) * r, 0, playerPos.z + Math.sin(a) * r);
        }
      }
      tx = this.wander.x; tz = this.wander.z; speed = 5;
    }

    // ---- dirige o corpo ----
    const mx = tx - t.x, mz = tz - t.z;
    const md = Math.hypot(mx, mz);
    if (md > 1.2 && speed > 0) {
      this.cow.yaw = Math.atan2(mx, mz);
      if (grounded) {
        body.setLinvel({ x: (mx / md) * speed, y: v.y, z: (mz / md) * speed }, true);
      }
    } else if (grounded) {
      body.setLinvel({ x: v.x * 0.8, y: v.y, z: v.z * 0.8 }, true);
    }
    // pulo
    if (this.jumpT > 0) {
      this.jumpT -= dt;
      if (grounded) body.setLinvel({ x: v.x, y: 9, z: v.z }, true);
    }
    // gira (rodopio)
    if (this.spinT > 0) {
      this.spinT -= dt;
      this.cow.yaw += dt * 9;
    }
    // animação
    this.cow.update(dt, Math.hypot(v.x, v.z), !grounded);
    this.cow.syncMesh();

    // caiu na água / fora do mapa: volta pra perto do jogador (nunca some)
    const gy = groundY(t.x, t.z);
    if (t.y < gy - 2.5 || t.y < -4) {
      const a = Math.random() * Math.PI * 2;
      body.setTranslation({
        x: playerPos.x + Math.cos(a) * 70,
        y: gy + 4,
        z: playerPos.z + Math.sin(a) * 70,
      }, true);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    }

    // ideias de tempos em tempos (vontade própria)
    this.thinkT -= dt;
    if (this.thinkT <= 0) {
      this.thinkT = 50 + Math.random() * 70;
      if (!this.speaking && this.mem.length > 2) this.doOwnThing();
    }
  }

  /** a IA levou algo pro jogador (suéter) */
  hasDelivered(): boolean {
    const r = this.preyGot;
    this.preyGot = false;
    return r;
  }
}
