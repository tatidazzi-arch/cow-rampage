import * as THREE from 'three';
import { joinRoom, selfId } from '@trystero-p2p/torrent';
import type { Room } from '@trystero-p2p/torrent';

const APP_ID = 'cow-rampage-3d-v1';

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
}

export interface NetEventMsg {
  [key: string]: number | string | boolean;
  type: 'boom';
  text: string;
  x: number;
  y: number;
  z: number;
}

export interface ScoreEntry {
  id: string;
  name: string;
  color: number;
  score: number;
  me: boolean;
}

/** Vaca simplificada de outro jogador (sem física, só interpola). */
export class RemoteCow {
  group = new THREE.Group();
  name: string;
  color: number;
  score = 0;
  target = new THREE.Vector3();
  targetYaw = 0;
  private legT = 0;
  private legs: THREE.Mesh[] = [];

  constructor(scene: THREE.Scene, name: string, color: number) {
    this.name = name;
    this.color = color;
    const fur = new THREE.MeshLambertMaterial({ color: 0xebe6dc });
    const band = new THREE.MeshLambertMaterial({ color });
    const dark = new THREE.MeshLambertMaterial({ color: 0x4b3723 });

    const body = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1, 2.2), fur);
    body.position.y = 1.2;
    body.castShadow = true;
    this.group.add(body);
    const collar = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.25, 0.4), band);
    collar.position.set(0, 1.4, 0.9);
    this.group.add(collar);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.6, 0.7), fur);
    head.position.set(0, 1.6, 1.3);
    head.castShadow = true;
    this.group.add(head);
    for (const [px, pz] of [[-0.4, 0.7], [0.4, 0.7], [-0.4, -0.7], [0.4, -0.7]]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.7, 0.2), dark);
      leg.position.set(px, 0.35, pz);
      this.group.add(leg);
      this.legs.push(leg);
    }
    for (const s of [-0.25, 0.25]) {
      const horn = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.4, 6), dark);
      horn.position.set(s, 2.0, 1.2);
      this.group.add(horn);
    }

    const label = this.makeLabel(name, color);
    label.position.y = 2.9;
    this.group.add(label);
    this.target.set(0, 1.2, 8);
    this.group.position.copy(this.target);
    scene.add(this.group);
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
    this.target.set(s.x, s.y - 1.1, s.z);
    this.targetYaw = s.yaw;
    this.score = s.score;
  }

  update(dt: number, speed: number) {
    const k = 1 - Math.exp(-10 * dt);
    this.group.position.lerp(this.target, k);
    let d = this.targetYaw - this.group.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.group.rotation.y += d * k;
    if (speed > 0.8) {
      this.legT += dt * speed * 1.6;
      this.legs.forEach((leg, i) => {
        leg.rotation.x = Math.sin(this.legT + (i % 2) * Math.PI) * 0.5;
      });
    }
  }

  dispose(scene: THREE.Scene) {
    scene.remove(this.group);
  }
}

export class NetManager {
  room: Room | null = null;
  roomCode = '';
  myName = 'Jimmy';
  myColor = 0xffcc00;
  onEvent: ((e: NetEventMsg, fromName: string) => void) | null = null;
  onPeers: (() => void) | null = null;
  onRemoteLeave: ((peerId: string) => void) | null = null;

  private cowAction: { send: (s: CowNetState) => Promise<void> } | null = null;
  private helloAction: { send: (p: PlayerProfile) => Promise<void> } | null = null;
  private eventAction: { send: (e: NetEventMsg) => Promise<void> } | null = null;
  private profiles = new Map<string, PlayerProfile & { score: number }>();

  get id(): string {
    return selfId;
  }

  get connected(): boolean {
    return this.room !== null;
  }

  peerCount(): number {
    if (!this.room) return 1;
    return Object.keys(this.room.getPeers()).length + 1;
  }

  join(code: string, name: string, color: number): void {
    void this.leave();
    this.roomCode = code.trim().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16) || 'rampage';
    this.myName = name.trim().slice(0, 12) || 'Jimmy';
    this.myColor = color;
    this.profiles.clear();
    this.room = joinRoom({ appId: APP_ID }, 'cow-' + this.roomCode);

    const cowAction = this.room.makeAction<CowNetState>('cow');
    const helloAction = this.room.makeAction<PlayerProfile>('hello');
    const eventAction = this.room.makeAction<NetEventMsg>('event');
    this.cowAction = cowAction;
    this.helloAction = helloAction;
    this.eventAction = eventAction;

    cowAction.onMessage = (s, ctx) => {
      if (this.handleCow) this.handleCow(s, ctx.peerId);
    };
    helloAction.onMessage = (p, ctx) => {
      this.profiles.set(ctx.peerId, { name: p.name, color: p.color, score: 0 });
      this.helloAction?.send({ name: this.myName, color: this.myColor }).catch(() => {});
      if (this.onPeers) this.onPeers();
    };
    eventAction.onMessage = (e, ctx) => {
      const pr = this.profiles.get(ctx.peerId);
      if (this.onEvent) this.onEvent(e, pr ? pr.name : '?');
    };
    this.room.onPeerJoin = () => {
      this.helloAction?.send({ name: this.myName, color: this.myColor }).catch(() => {});
      if (this.onPeers) this.onPeers();
    };
    this.room.onPeerLeave = (peerId: string) => {
      this.profiles.delete(peerId);
      if (this.onRemoteLeave) this.onRemoteLeave(peerId);
      if (this.onPeers) this.onPeers();
    };
    if (this.onPeers) this.onPeers();
  }

  private handleCow: ((s: CowNetState, peerId: string) => void) | null = null;

  onCowState(cb: (s: CowNetState, peerId: string) => void): void {
    this.handleCow = cb;
  }

  sendState(s: CowNetState): void {
    if (this.cowAction) this.cowAction.send(s).catch(() => {});
  }

  sendBoom(text: string, x: number, y: number, z: number): void {
    if (this.eventAction) this.eventAction.send({ type: 'boom', text, x, y, z }).catch(() => {});
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

  scoreboard(myScore: number): ScoreEntry[] {
    const list: ScoreEntry[] = [{ id: selfId, name: this.myName, color: this.myColor, score: myScore, me: true }];
    for (const [id, p] of this.profiles) {
      list.push({ id, name: p.name, color: p.color, score: p.score, me: false });
    }
    list.sort((a, b) => b.score - a.score);
    return list;
  }

  async leave(): Promise<void> {
    this.profiles.clear();
    if (this.room) {
      const r = this.room;
      this.room = null;
      this.cowAction = null;
      this.helloAction = null;
      this.eventAction = null;
      try {
        await r.leave();
      } catch {
        /* ignora */
      }
    }
    if (this.onPeers) this.onPeers();
  }
}
