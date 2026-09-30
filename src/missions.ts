import type { Tree } from './world';

export interface CarryInfo {
  isSweater: boolean;
  x: number;
  y: number;
  z: number;
}

export interface MissionCtx {
  carrying: CarryInfo | null;
  trees: Tree[];
  score: number;
  chaos: number;
}

export interface MissionDef {
  id: string;
  title: string;
  desc: string;
  target: number;
  reward: number;
  events?: Record<string, number>;
  timedCarry?: boolean;
  scoreGoal?: boolean;
  check?: (ctx: MissionCtx) => boolean;
}

/** "Arrume as folhas": homem de sueter no topo de uma arvore. */
function sweaterAtTreeTop(ctx: MissionCtx): boolean {
  const c = ctx.carrying;
  if (!c || !c.isSweater) return false;
  for (const t of ctx.trees) {
    if (Math.hypot(c.x - t.x, c.z - t.z) < t.radius + 2.5 && c.y > t.topY - 0.5) return true;
  }
  return false;
}

export class MissionManager {
  readonly missions: MissionDef[] = [
    { id: 'folhas', title: '🍃 Arrume as folhas', desc: 'Leve um homem de sueter (▼ amarelo: camisa amarela, laranja, ferrugem ou roxa) ao topo de uma árvore', target: 1, reward: 50, check: sweaterAtTreeTop },
    { id: 'entrega', title: '📦 Entrega expressa', desc: 'Coloque uma pessoa dentro do canhão', target: 1, reward: 30, events: { load: 1 } },
    { id: 'fogos', title: '🎆 Show de fogos', desc: 'Dispare o canhão 2 vezes', target: 2, reward: 40, events: { fire: 1 } },
    { id: 'vizinhos', title: '🤝 Cumprimente os vizinhos', desc: 'Dê cabeçada em 5 pessoas (é carinho)', target: 5, reward: 40, events: { headbutt: 1 } },
    { id: 'limpeza', title: '🧹 Limpeza urbana', desc: 'Derrube 8 pessoas que estão no caminho', target: 8, reward: 40, events: { knock: 1 } },
    { id: 'passeio', title: '🐴 Passeio a cavalo', desc: 'Carregue alguém no dorso por 12 segundos', target: 12, reward: 50, timedCarry: true },
    { id: 'escalada', title: '🧗 Teste de escalada', desc: 'Corra na parede de um prédio (pulo duplo no ar)', target: 1, reward: 40, events: { wallrun: 1 } },
    { id: 'fama', title: '⭐ Seja famoso', desc: 'Alcance 400 pontos de Score', target: 400, reward: 100, scoreGoal: true },
  ];

  idx = 0;
  progress = 0;
  finished = false;
  onComplete: (done: MissionDef, next: MissionDef | null) => void = () => {};

  current(): MissionDef | null {
    if (this.finished) return null;
    return this.missions[this.idx] ?? null;
  }

  event(name: string): void {
    const m = this.current();
    if (!m || !m.events || !(name in m.events)) return;
    this.progress += m.events[name] ?? 0;
    if (this.progress >= m.target) this.complete();
  }

  update(dt: number, ctx: MissionCtx): void {
    const m = this.current();
    if (!m) return;
    if (m.timedCarry) {
      if (ctx.carrying) {
        this.progress += dt;
        if (this.progress >= m.target) this.complete();
      }
      return;
    }
    if (m.scoreGoal) {
      this.progress = Math.min(ctx.score, m.target);
      if (ctx.score >= m.target) this.complete();
      return;
    }
    if (m.check && m.check(ctx)) {
      this.progress = m.target;
      this.complete();
    }
  }

  private complete(): void {
    const m = this.current();
    if (!m) return;
    this.idx++;
    this.progress = 0;
    if (this.idx >= this.missions.length) {
      this.finished = true;
      this.onComplete(m, null);
    } else {
      const next = this.missions[this.idx];
      this.onComplete(m, next ?? null);
    }
  }
}
