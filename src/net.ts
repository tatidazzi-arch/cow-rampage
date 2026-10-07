import * as THREE from 'three';
import Peer from 'peerjs';
import type { DataConnection } from 'peerjs';
import mqtt from 'mqtt';
import type { MqttClient } from 'mqtt';
import { COW_HALF_H, loadCowAssets, spawnCowModel } from './cowmodel';
import { skinById, tintCowModel } from './skins';

/** Prefixo dos tópicos/ids no relay e no servidor de sinalização. */
const APP_PREFIX = 'cowr3';

/** Brokers MQTT públicos (WebSocket): descoberta + relay quando o P2P não passa no NAT.
 *  Sem cadastro. Tenta em ordem se algum cair. */
const RELAY_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];

/** STUN público: descobre o endereço externo p/ conexão DIRETA quando o NAT deixa. */
const PEER_OPTS = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ],
  },
};

/** Query params de diagnóstico: ?nowebrtc (só relay) e ?norelay (só P2P). */
const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;

export interface CowNetState {
  [key: string]: number | string | boolean;
  x: number;
  y: number;
  z: number;
  yaw: number;
  speed: number;
  air: boolean;
  carry: boolean;
  score: number;
}

export interface PlayerProfile {
  [key: string]: number | string | boolean;
  name: string;
  color: number;
  skin: string;
}

export interface NetEventMsg {
  [key: string]: number | string | boolean;
  type: 'boom' | 'hit';
  text: string;
  x: number;
  y: number;
  z: number;
  /** hit: só a vítima com esse id aplica (os outros ignoram); '' = pra todos */
  target: string;
}

export interface ScoreEntry {
  id: string;
  name: string;
  color: number;
  score: number;
  me: boolean;
}

/** Envelope que trafega nos dois transportes (WebRTC direto e relay MQTT). */
type NetMsg =
  | { t: 'hello'; p: PlayerProfile }
  | { t: 'cow'; s: CowNetState }
  | { t: 'event'; e: NetEventMsg };

interface Wire {
  /** id de quem mandou */
  f: string;
  /** id do destinatário ('' = todos) */
  to: string;
  m: NetMsg;
}

/** Vaca de outro jogador: mesmo modelo FBX da vaca local (+fallback em caixa). */
export class RemoteCow {
  group = new THREE.Group();
  name: string;
  color: number;
  score = 0;
  skinId = 'comum';
  target = new THREE.Vector3();
  targetYaw = 0;
  modelReady = false;
  private mixer: THREE.AnimationMixer | null = null;
  private clips: Record<string, THREE.AnimationClip> = {};
  private currentClip = '';
  private fallback = new THREE.Group();
  private idleTime = 0;
  private oneShotT = 0;
  private legT = 0;
  private legs: THREE.Mesh[] = [];

  constructor(scene: THREE.Scene, name: string, color: number, skinId = 'comum') {
    this.name = name;
    this.color = color;
    this.skinId = skinId;
    const fur = new THREE.MeshLambertMaterial({ color: 0xebe6dc });
    const band = new THREE.MeshLambertMaterial({ color });
    const dark = new THREE.MeshLambertMaterial({ color: 0x4b3723 });

    const body = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1, 2.2), fur);
    body.position.y = 1.2;
    body.castShadow = true;
    this.fallback.add(body);
    const collar = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.25, 0.4), band);
    collar.position.set(0, 1.4, 0.9);
    this.fallback.add(collar);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.6, 0.7), fur);
    head.position.set(0, 1.6, 1.3);
    head.castShadow = true;
    this.fallback.add(head);
    for (const [px, pz] of [[-0.4, 0.7], [0.4, 0.7], [-0.4, -0.7], [0.4, -0.7]]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.7, 0.2), dark);
      leg.position.set(px, 0.35, pz);
      this.fallback.add(leg);
      this.legs.push(leg);
    }
    for (const s of [-0.25, 0.25]) {
      const horn = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.4, 6), dark);
      horn.position.set(s, 2.0, 1.2);
      this.fallback.add(horn);
    }
    this.group.add(this.fallback);

    const label = this.makeLabel(name, color);
    label.position.y = 5.4;
    this.group.add(label);
    this.target.set(-40, 1.2, -1810);
    this.group.position.copy(this.target);
    scene.add(this.group);
    void this.loadModel();
  }

  /** Carrega o MESMO modelo FBX da vaca local (compartilha o cache). */
  private async loadModel(): Promise<void> {
    try {
      const assets = await loadCowAssets();
      const spawned = spawnCowModel(assets);
      this.group.add(spawned.model);
      // manta na cor do jogador pra identificar de longe
      const blanket = new THREE.Mesh(
        new THREE.BoxGeometry(1.7, 0.18, 2.2),
        new THREE.MeshLambertMaterial({ color: this.color }),
      );
      blanket.position.set(0, 3.1, -0.2);
      this.group.add(blanket);
      this.fallback.visible = false;
      tintCowModel(spawned.model, skinById(this.skinId));
      this.mixer = spawned.mixer;
      this.clips = spawned.clips;
      this.modelReady = true;
      this.playClip('idle');
    } catch {
      /* mantém a vaca de caixa */
    }
  }

  /** Troca a skin depois de criada (ex.: hello com a skin chegou depois). */
  setSkin(skinId: string): void {
    if (!skinId || skinId === this.skinId) return;
    this.skinId = skinId;
    if (this.modelReady) tintCowModel(this.group, skinById(skinId));
  }

  private playClip(name: string): void {
    if (!this.mixer || !this.clips[name] || this.currentClip === name) return;
    const next = this.mixer.clipAction(this.clips[name]);
    next.reset();
    if (this.currentClip && this.clips[this.currentClip]) {
      this.mixer.clipAction(this.clips[this.currentClip]).crossFadeTo(next, 0.25, false);
    }
    next.play();
    this.currentClip = name;
  }

  private makeLabel(name: string, color: number): THREE.Sprite {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 64;
    const g = c.getContext('2d')!;
    g.font = 'bold 36px Arial';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 6;
    g.strokeStyle = '#000';
    g.strokeText(name, 128, 32);
    g.fillStyle = '#' + color.toString(16).padStart(6, '0');
    g.fillText(name, 128, 32);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true }));
    sp.scale.set(4, 1, 1);
    return sp;
  }

  setState(s: CowNetState) {
    // mesma origem dos pés da vaca local (corpo - COW_HALF_H)
    this.target.set(s.x, s.y - COW_HALF_H, s.z);
    this.targetYaw = s.yaw;
    this.score = s.score;
  }

  update(dt: number, speed: number) {
    if (this.mixer) this.mixer.update(dt);
    const k = 1 - Math.exp(-10 * dt);
    this.group.position.lerp(this.target, k);
    let d = this.targetYaw - this.group.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.group.rotation.y += d * k;
    if (this.modelReady) {
      if (speed > 0.8) {
        this.idleTime = 0;
        this.oneShotT = 0;
        this.playClip('walk');
      } else {
        this.playRemoteIdle(dt);
      }
    } else if (speed > 0.8) {
      this.legT += dt * speed * 1.6;
      this.legs.forEach((leg, i) => {
        leg.rotation.x = Math.sin(this.legT + (i % 2) * Math.PI) * 0.5;
      });
    }
  }

  private playRemoteIdle(dt: number): void {
    if (this.oneShotT > 0) {
      this.oneShotT -= dt;
      if (this.oneShotT <= 0) {
        this.oneShotT = 0;
        this.playClip('idle');
      }
      return;
    }
    if (this.currentClip === 'idlebreak' || this.currentClip === 'eat') {
      this.playClip('idle');
      return;
    }
    this.playClip('idle');
    this.idleTime += dt;
    if (this.idleTime > 8 + Math.random() * 10) {
      this.idleTime = 0;
      const pick = Math.random() < 0.5 ? 'eat' : 'idlebreak';
      const clip = this.clips[pick];
      if (clip) {
        this.oneShotT = clip.duration > 0 ? clip.duration : 3;
        this.playClip(pick);
      } else {
        this.idleTime = 4;
      }
    }
  }

  dispose(scene: THREE.Scene) {
    scene.remove(this.group);
  }
}

/**
 * Multiplayer híbrido (funciona em QUALQUER rede):
 *
 * 1) Relay MQTT (WebSocket 443/8084/8884) — sempre ligado. É por onde a turma se
 *    DESCOBRE (hello no tópico da sala) e por onde as mensagens vão quando o P2P
 *    não consegue furar o NAT (ex.: 4G/CGNAT, NAT simétrico).
 * 2) WebRTC direto (PeerJS/DataChannel) — melhor esforço, em paralelo. Quando abre,
 *    as mensagens daquele jogador passam a ir direto (menos latência), e o relay
 *    fica só de descoberta/keepalive.
 *
 * Sem cadastro/API key: usa a nuvem pública do PeerJS para a sinalização e brokers
 * MQTT públicos para o relay.
 */
export class NetManager {
  roomCode = '';
  myName = 'Jimmy';
  myColor = 0xffcc00;
  mySkin = 'comum';
  onEvent: ((e: NetEventMsg, fromName: string) => void) | null = null;
  onPeers: (() => void) | null = null;
  onRemoteLeave: ((peerId: string) => void) | null = null;

  private peer: Peer | null = null;
  private conns = new Map<string, DataConnection>();
  /** conexões que NÓS iniciamos (desempate de discagem simultânea). */
  private outgoing = new WeakSet<DataConnection>();
  private dialing = new Set<string>();
  private profiles = new Map<string, PlayerProfile & { score: number }>();
  private lastSeen = new Map<string, number>();
  private relay: MqttClient | null = null;
  private relayTopic = '';
  private relayConnected = false;
  private relayBrokerIdx = 0;
  private myId = '';
  private joinGen = 0;
  private helloTimer = 0;
  private sweepTimer = 0;
  private maxSeen = 1;
  private aloneSince = 0;

  private profile(): PlayerProfile {
    return { name: this.myName, color: this.myColor, skin: this.mySkin };
  }

  get id(): string {
    return this.myId;
  }

  get connected(): boolean {
    return this.relayConnected || (this.peer !== null && !this.peer.destroyed);
  }

  peerCount(): number {
    return this.profiles.size + 1;
  }

  /** true se dá pra tentar P2P direto (usado só no diagnóstico). */
  get directCount(): number {
    return this.conns.size;
  }

  async join(code: string, name: string, color: number): Promise<void> {
    await this.leave();
    const gen = ++this.joinGen;
    this.roomCode = code.trim().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16) || 'rampage';
    this.myName = name.trim().slice(0, 12) || 'Jimmy';
    this.myColor = color;
    this.myId = `${APP_PREFIX}-${this.roomCode}-${Math.random().toString(36).slice(2, 10)}`;
    this.relayTopic = `${APP_PREFIX}/${this.roomCode}/all`;
    this.profiles.clear();
    this.lastSeen.clear();
    this.maxSeen = 1;
    this.aloneSince = 0;

    const wantWebrtc = !(params && params.has('nowebrtc'));
    const wantRelay = !(params && params.has('norelay'));

    // 1) relay primeiro: descoberta garantida em qualquer rede
    if (wantRelay) this.openRelay(gen);
    // 2) WebRTC em paralelo: se furar o NAT, vira o caminho rápido
    if (wantWebrtc) {
      this.openPeer(this.myId, gen).catch((err) => {
        console.warn('[net] WebRTC indisponível, seguindo só no relay:', String((err && err.type) || err));
      });
    }

    window.clearInterval(this.helloTimer);
    this.helloTimer = window.setInterval(() => {
      this.publish({ f: this.myId, to: '', m: { t: 'hello', p: this.profile() } });
    }, 6000);
    window.clearInterval(this.sweepTimer);
    this.sweepTimer = window.setInterval(() => this.sweep(), 5000);
    if (this.onPeers) this.onPeers();
  }

  // ---------- WebRTC direto (PeerJS) ----------

  private openPeer(id: string, gen: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const peer = new Peer(id, PEER_OPTS);
      let settled = false;
      peer.on('open', (openId: string) => {
        if (gen !== this.joinGen) {
          try { peer.destroy(); } catch { /* ignora */ }
          if (!settled) { settled = true; reject(new Error('stale')); }
          return;
        }
        settled = true;
        this.peer = peer;
        this.myId = openId;
        resolve();
      });
      peer.on('error', (err) => {
        const type = String(err && err.type ? err.type : err);
        if (!settled && (type === 'unavailable-id' || type === 'network' || type === 'server-error' || type === 'socket-error' || type === 'socket-closed')) {
          settled = true;
          try { peer.destroy(); } catch { /* ignora */ }
          reject(err);
          return;
        }
        console.warn('[net] aviso do PeerJS:', type);
      });
      peer.on('connection', (conn) => this.attach(conn));
      peer.on('disconnected', () => {
        console.warn('[net] sinal caiu, reconectando...');
        try { peer.reconnect(); } catch { /* ignora */ }
      });
    });
  }

  private attach(conn: DataConnection): void {
    conn.on('open', () => {
      this.finalizeConn(conn);
      this.sendDirect(conn, { t: 'hello', p: this.profile() });
    });
    conn.on('data', (raw) => {
      if (this.conns.get(conn.peer) !== conn) return;
      this.onWire(raw as Wire);
    });
    conn.on('close', () => this.dropConn(conn.peer));
    conn.on('error', () => this.dropConn(conn.peer));
  }

  private connectTo(id: string): void {
    const peer = this.peer;
    if (!peer || peer.destroyed || !id || id === this.myId || this.conns.has(id) || this.dialing.has(id)) return;
    this.dialing.add(id);
    try {
      const conn = peer.connect(id, { reliable: true });
      this.outgoing.add(conn);
      this.attach(conn);
    } catch (err) {
      this.dialing.delete(id);
      console.warn('[net] falha ao discar para', id, err);
    }
  }

  /** Desempata conexões duplicadas (discagem simultânea dos dois lados). */
  private finalizeConn(conn: DataConnection): void {
    const rid = conn.peer;
    this.dialing.delete(rid);
    const existing = this.conns.get(rid);
    if (existing && existing !== conn) {
      const iAmSmaller = this.myId < rid;
      const connIsOutgoing = this.outgoing.has(conn);
      const keepConn = connIsOutgoing === iAmSmaller;
      const drop = keepConn ? existing : conn;
      const keep = keepConn ? conn : existing;
      try { drop.close(); } catch { /* ignora */ }
      this.outgoing.delete(drop);
      this.conns.set(rid, keep);
      return;
    }
    this.conns.set(rid, conn);
    if (this.onPeers) this.onPeers();
  }

  /** Só descarta a conexão direta; o jogador continua via relay. */
  private dropConn(id: string): void {
    if (!this.conns.delete(id)) return;
    this.dialing.delete(id);
    if (this.onPeers) this.onPeers();
  }

  // ---------- Relay MQTT (descoberta + fallback) ----------

  private openRelay(gen: number): void {
    this.closeRelay();
    const url = RELAY_BROKERS[this.relayBrokerIdx % RELAY_BROKERS.length]!;
    let client: MqttClient;
    try {
      client = mqtt.connect(url, {
        clientId: this.myId,
        clean: true,
        reconnectPeriod: 4000,
        connectTimeout: 15000,
        keepalive: 30,
      });
    } catch (err) {
      console.warn('[net] relay falhou:', err);
      return;
    }
    this.relay = client;
    this.relayConnected = false;
    client.on('connect', () => {
      if (gen !== this.joinGen || this.relay !== client) return;
      this.relayConnected = true;
      console.log('[net] relay conectado:', url);
      client.subscribe(this.relayTopic, { qos: 0 }, () => {
        this.publish({ f: this.myId, to: '', m: { t: 'hello', p: this.profile() } });
      });
      if (this.onPeers) this.onPeers();
    });
    client.on('message', (topic, payload) => {
      if (gen !== this.joinGen || this.relay !== client) return;
      if (topic !== this.relayTopic) return;
      let w: Wire | null = null;
      try { w = JSON.parse(String(payload)) as Wire; } catch { return; }
      if (!w || typeof w.f !== 'string' || w.f === this.myId) return;
      if (w.to && w.to !== this.myId) return;
      this.onWire(w);
    });
    client.on('close', () => { if (this.relay === client) this.relayConnected = false; });
    client.on('error', () => { /* mqtt.js reconecta sozinho */ });
    // se o broker não responder, tenta o próximo da lista
    window.setTimeout(() => {
      if (gen !== this.joinGen || this.relay !== client) return;
      if (!this.relayConnected) {
        console.warn('[net] broker sem resposta, tentando o próximo...');
        this.relayBrokerIdx++;
        this.openRelay(gen);
      }
    }, 14000);
  }

  private closeRelay(): void {
    const c = this.relay;
    this.relay = null;
    this.relayConnected = false;
    if (c) {
      try { c.end(true); } catch { /* ignora */ }
    }
  }

  private publish(w: Wire): void {
    const c = this.relay;
    if (!c || !this.relayConnected) return;
    try { c.publish(this.relayTopic, JSON.stringify(w), { qos: 0 }); } catch { /* ignora */ }
  }

  private sendDirect(conn: DataConnection, m: NetMsg): void {
    try {
      if (conn.open) void conn.send({ f: this.myId, to: conn.peer, m } satisfies Wire);
    } catch { /* conexão fechando */ }
  }

  private sendTo(peerId: string, m: NetMsg): void {
    const conn = this.conns.get(peerId);
    if (conn && conn.open) {
      this.sendDirect(conn, m);
      return;
    }
    this.publish({ f: this.myId, to: peerId, m });
  }

  private broadcast(m: NetMsg): void {
    for (const id of this.profiles.keys()) this.sendTo(id, m);
  }

  private onWire(w: Wire): void {
    const from = w.f;
    this.lastSeen.set(from, Date.now());
    const known = this.profiles.has(from);
    if (w.m.t === 'hello') {
      const prev = this.profiles.get(from);
      this.profiles.set(from, {
        name: String(w.m.p.name || '?').slice(0, 12),
        color: Number(w.m.p.color) || 0xffffff,
        skin: typeof w.m.p.skin === 'string' ? w.m.p.skin : 'comum',
        score: prev ? prev.score : 0,
      });
      this.maxSeen = Math.max(this.maxSeen, this.profiles.size + 1);
      if (!known) {
        // novo jogador: tenta abrir o caminho direto (dedupe cuida da discagem dupla)
        this.connectTo(from);
        if (this.onPeers) this.onPeers();
      }
      return;
    }
    if (!known) {
      this.profiles.set(from, { name: '?', color: 0xffffff, skin: 'comum', score: 0 });
      this.lastSeen.set(from, Date.now());
      this.connectTo(from);
    }
    if (w.m.t === 'cow') {
      if (this.handleCow) this.handleCow(w.m.s, from);
      return;
    }
    if (w.m.t === 'event') {
      const pr = this.profiles.get(from);
      if (this.onEvent) this.onEvent(w.m.e, pr ? pr.name : '?');
    }
  }

  /** Remove quem passou 30s sem dar sinal (e sem conexão direta aberta). */
  private sweep(): void {
    const now = Date.now();
    for (const id of [...this.profiles.keys()]) {
      const last = this.lastSeen.get(id) ?? 0;
      const direct = this.conns.get(id);
      if (now - last > 30000 && !(direct && direct.open)) this.dropPeer(id);
    }
  }

  private dropPeer(id: string): void {
    this.profiles.delete(id);
    this.lastSeen.delete(id);
    this.dropConn(id);
    if (this.onRemoteLeave) this.onRemoteLeave(id);
    if (this.onPeers) this.onPeers();
  }

  private handleCow: ((s: CowNetState, peerId: string) => void) | null = null;

  onCowState(cb: (s: CowNetState, peerId: string) => void): void {
    this.handleCow = cb;
  }

  /** Força reanúncio (ex.: ao voltar pra aba no celular). */
  poke(): void {
    this.publish({ f: this.myId, to: '', m: { t: 'hello', p: this.profile() } });
    if (this.onPeers) this.onPeers();
  }

  /** Aviso quando já viu gente e ficou sozinho (conexão caiu?). */
  dropHint(): string {
    const n = this.profiles.size + 1;
    if (n > 1) {
      this.maxSeen = Math.max(this.maxSeen, n);
      this.aloneSince = 0;
      return '';
    }
    if (this.maxSeen < 2) return '';
    if (!this.aloneSince) this.aloneSince = Date.now();
    if (Date.now() - this.aloneSince < 20000) return '';
    return '⚠️ Conexão caiu? Toque em 🔄 RECONECTAR.';
  }

  sendState(s: CowNetState): void {
    this.broadcast({ t: 'cow', s });
  }

  sendBoom(text: string, x: number, y: number, z: number): void {
    this.broadcast({ t: 'event', e: { type: 'boom', text, x, y, z, target: '' } });
  }

  /** Cabeçada PvP: avisa a vítima onde foi o golpe (só ela aplica). */
  sendHit(targetPeerId: string, x: number, z: number): void {
    this.broadcast({ t: 'event', e: { type: 'hit', text: '', x, y: 0, z, target: targetPeerId } });
  }

  updateScore(peerId: string, score: number): void {
    const p = this.profiles.get(peerId);
    if (p) {
      p.score = score;
      if (this.onPeers) this.onPeers();
    }
  }

  profileOf(peerId: string): PlayerProfile | null {
    return this.profiles.get(peerId) ?? null;
  }

  /** Diagnóstico: sinal (PeerJS + relay) e nº de conexões diretas. */
  debugStatus(): { trackersOpen: number; trackersTotal: number; peers: number; known: number; relay: boolean } {
    const signaling = this.peer && !this.peer.destroyed && !this.peer.disconnected ? 1 : 0;
    const relay = this.relayConnected ? 1 : 0;
    return {
      trackersOpen: signaling + relay,
      trackersTotal: 2,
      peers: this.conns.size,
      known: this.profiles.size + 1,
      relay: this.relayConnected,
    };
  }

  scoreboard(myScore: number): ScoreEntry[] {
    const list: ScoreEntry[] = [{ id: this.myId, name: this.myName, color: this.myColor, score: myScore, me: true }];
    for (const [id, p] of this.profiles) {
      list.push({ id, name: p.name, color: p.color, score: p.score, me: false });
    }
    list.sort((a, b) => b.score - a.score);
    return list;
  }

  async leave(): Promise<void> {
    this.joinGen++;
    window.clearInterval(this.helloTimer);
    this.helloTimer = 0;
    window.clearInterval(this.sweepTimer);
    this.sweepTimer = 0;
    this.profiles.clear();
    this.lastSeen.clear();
    this.maxSeen = 1;
    this.aloneSince = 0;
    for (const c of this.conns.values()) {
      try { c.close(); } catch { /* ignora */ }
    }
    this.conns.clear();
    this.dialing.clear();
    this.closeRelay();
    const p = this.peer;
    this.peer = null;
    this.myId = '';
    if (p && !p.destroyed) {
      try { p.destroy(); } catch { /* ignora */ }
    }
    if (this.onPeers) this.onPeers();
  }
}
