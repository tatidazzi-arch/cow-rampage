import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { worldRand } from './rng';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';

export interface Tree {
  id: number;
  x: number;
  z: number;
  radius: number;
  topY: number;
  scale: number;
  trunk: THREE.Object3D;
  canopy: THREE.Object3D;
  body: RAPIER.RigidBody;
}

export interface Building {
  id: number;
  x: number;
  z: number;
  halfW: number;
  halfD: number;
  height: number;
  mesh: THREE.Object3D;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
}

export interface Cannon {
  id: number;
  x: number;
  z: number;
  group: THREE.Group;
  barrel: THREE.Mesh;
  body: RAPIER.RigidBody;
  loadedNPC: number | null;
}

export const WORLD_SIZE = 2000;

// ---- Ilha (mapa desenhado): blob redondo com baia no norte (-Z) ----
export const ISLAND_R = 1500;
const BAY_ANGLE = -Math.PI / 2;
const BAY_DEPTH = 340;
const BAY_SIGMA = 0.16;
// picos gêmeos do norte (desenho) + costa leste reta A-B
const PEAK_W = BAY_ANGLE - 0.38;
const PEAK_E = BAY_ANGLE + 0.38;
const PEAK_H = 220;
const PEAK_SIGMA = 0.13;
const LA = { x: 550, z: -1000 };
const LB = { x: 1500, z: 300 };

export function angDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Raio até o segmento A-B na direção theta (costa leste reta), ou null. */
function lineRadius(theta: number): number | null {
  const dx = Math.cos(theta), dz = Math.sin(theta);
  const ex = LB.x - LA.x, ez = LB.z - LA.z;
  const den = ex * dz - dx * ez;
  if (Math.abs(den) < 1e-9) return null;
  const t = (ex * LA.z - LA.x * ez) / den;
  const u = (dx * LA.z - dz * LA.x) / den;
  if (t <= 0 || u < 0 || u > 1) return null;
  return t;
}

/** Raio da costa no angulo theta. withBay=false ignora a baia (muro fecha a boca). */
export function islandRadius(theta: number, withBay: boolean): number {
  let r = ISLAND_R * (1 + 0.12 * Math.sin(2 * theta + 1.3) + 0.08 * Math.sin(3 * theta + 0.5) + 0.05 * Math.sin(5 * theta + 2.1));
  const dw = angDiff(theta, PEAK_W);
  r += PEAK_H * Math.exp(-(dw * dw) / (2 * PEAK_SIGMA * PEAK_SIGMA));
  const de = angDiff(theta, PEAK_E);
  r += PEAK_H * Math.exp(-(de * de) / (2 * PEAK_SIGMA * PEAK_SIGMA));
  if (withBay) {
    const d = angDiff(theta, BAY_ANGLE);
    r -= BAY_DEPTH * Math.exp(-(d * d) / (2 * BAY_SIGMA * BAY_SIGMA));
  }
  const lr = lineRadius(theta);
  if (lr !== null && lr < r) r = lr;
  return r;
}

// ---- Segunda ilha (redonda, da fazenda) + ponte ----
export const BALL = { x: 0, z: -1850, r: 420 };
export const BRIDGE = { x0: -4, x1: 4, z0: -1440, z1: -1080 };

// ---- Distritos do mapa desenhado ----
export const FARM = { x: 0, z: -1850, r: 60 };
export const DAM_RECT = { x0: -440, x1: -80, z0: -520, z1: -320 };
export const CITY = { x: 0, z: 150, r: 450 };
/** Nascimento da vaca (pasto aberto da fazenda, longe das construções). */
export const SPAWN = { x: -40, z: -1810 };
export const MANSION = { x: -850, z: -100 };
export const CEMETERY = { x: -450, z: -50, r: 25 };
export const FOREST = { x: 800, z: 200, r: 150 };
export const GOATS = { x: 950, z: 600, r: 40 };
export const MINE = { x: -700, z: 800, r: 70 };

export class World {
  buildings: Building[] = [];
  trees: Tree[] = [];
  cannons: Cannon[] = [];
  groundBody: RAPIER.RigidBody;
  wallCount = 0;
  cliffCount = 0;
  buoyCount = 0;
  buoyPos: { x: number; z: number }[] = [];
  /** Registro de props dos distritos (para testes e missões): {name, x, z} */
  props: { name: string; x: number; z: number }[] = [];
  /** Vigas animadas das bombas de petróleo */
  pumps: { beam: THREE.Group; phase: number }[] = [];
  private pumpT = 0;
  /** Animados do mapa-guia: moinho, carros, fumaça, fogueira */
  windmillBlades: THREE.Group | null = null;
  cars: { mesh: THREE.Group; axis: 'x' | 'z'; dir: number; speed: number; min: number; max: number }[] = [];
  smoke: { mesh: THREE.Mesh; speed: number; maxY: number }[] = [];
  fireLight: THREE.PointLight | null = null;
  private animT = 0;
  /** Template da Gleditsia (clone por árvore) + métricas em espaço unitário */
  readonly treeInfo: { loaded: boolean; meshes: number; mats: string[]; parseMs: number; verts: number; tTraverseMs: number; tMetricsMs: number } = { loaded: false, meshes: 0, mats: [], parseMs: 0, verts: 0, tTraverseMs: 0, tMetricsMs: 0 };
  /** Grama bermuda espalhada (instanced) */
  readonly grassInfo: { loaded: boolean; instances: number; verts: number; mats: string[]; sample: { x: number; z: number }[]; spawnCount: number } = { loaded: false, instances: 0, verts: 0, mats: [], sample: [], spawnCount: 0 };
  private treeTemplate: THREE.Group | null = null;
  private treeLoading: Promise<void> | null = null;
  private treeMetrics = { trunkTop: 0.42, trunkR: 0.03, canopyY: 0.68, canopyR: 0.3 };

  private idCounter = 1;

  private scene: THREE.Scene;
  private world: RAPIER.World;
  private showLoading: (pct: number, label: string) => void;

  constructor(
    scene: THREE.Scene,
    world: RAPIER.World,
    showLoading: (pct: number, label: string) => void,
  ) {
    this.scene = scene;
    this.world = world;
    this.showLoading = showLoading;
    this.groundBody = this.buildGround();
  }

  nextId(): number {
    return this.idCounter++;
  }

  isOnIsland(x: number, z: number, margin: number): boolean {
    const th = Math.atan2(z, x);
    if (Math.hypot(x, z) < islandRadius(th, true) - margin) return true;
    return Math.hypot(x - BALL.x, z - BALL.z) < BALL.r - margin;
  }

  /** true se o ponto cai dentro de algum distrito (com construções). */
  clearOfDistricts(x: number, z: number, includeCity: boolean): boolean {
    if (Math.hypot(x - FARM.x, z - FARM.z) < FARM.r + 4) return true;
    if (x > DAM_RECT.x0 - 4 && x < DAM_RECT.x1 + 4 && z > DAM_RECT.z0 - 4 && z < DAM_RECT.z1 + 4) return true;
    if (includeCity && Math.hypot(x - CITY.x, z - CITY.z) < CITY.r) return true;
    if (Math.hypot(x - MANSION.x, z - MANSION.z) < 40) return true;
    if (Math.hypot(x - CEMETERY.x, z - CEMETERY.z) < CEMETERY.r + 4) return true;
    if (Math.hypot(x - GOATS.x, z - GOATS.z) < GOATS.r + 2) return true;
    if (Math.hypot(x - MINE.x, z - MINE.z) < MINE.r + 2) return true;
    return false;
  }

  private fixedBody(x: number, z: number): RAPIER.RigidBody {
    return this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, 0, z));
  }

  private solidBox(body: RAPIER.RigidBody, ox: number, oy: number, oz: number, hx: number, hy: number, hz: number): void {
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(ox, oy, oz), body);
  }

  private logProp(name: string, x: number, z: number): void {
    this.props.push({ name, x, z });
  }

  private buildGround(): RAPIER.RigidBody {
    // agua ao redor
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(10000, 10000),
      new THREE.MeshLambertMaterial({ color: 0x2a6fb5 }),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.y = -0.6;
    this.scene.add(water);

    this.buildTerrainMesh();
    this.buildRoads();
    this.buildBoundaryWalls();
    this.buildCliffs();
    this.buildBuoys();

    // collider trimesh (heightfield quebra nesta versao do Rapier;
// usa a MESMA geometria do visual = zero divergência)
    const terrGeo = this.buildTerrainMesh();
    const tp = terrGeo.getAttribute('position') as THREE.BufferAttribute;
    const ti = terrGeo.getIndex()!;
    const body = this.fixedBody(0, -200);
    this.world.createCollider(
      RAPIER.ColliderDesc.trimesh(tp.array as Float32Array, ti.array as Uint32Array), body);
    return body;
  }

  /** Altura do terreno (mesma usada na malha, no collider e nos spawns). */
  groundHeight(x: number, z: number): number {
    const wild = this.wildHeight(x, z);
    const m = this.flatMask(x, z);
    let h = wild + (0.1 - wild) * m;
    // mesa da mansão (topo plano r90)
    const dm = Math.hypot(x - MANSION.x, z - MANSION.z);
    h = 80 + (h - 80) * smoothstep(90, 260, dm);
    // vulcão + cratera (minas)
    const dv = Math.hypot(x - MINE.x, z - MINE.z);
    h += 100 * Math.exp(-(dv * dv) / (2 * 120 * 120));
    h -= 45 * Math.exp(-(dv * dv) / (2 * 32 * 32));
    // afunda na costa
    const th = Math.atan2(z, x);
    const r = Math.hypot(x, z);
    const edge = smoothstep(0, 25, islandRadius(th, true) - r);
    h = h * edge + (-3) * (1 - edge);
    // ilha redonda (por cima: o que for maior vale)
    const rb = Math.hypot(x - BALL.x, z - BALL.z);
    const edgeB = smoothstep(0, 20, BALL.r - rb);
    const hBall = 0.1 * edgeB + (-3) * (1 - edgeB);
    return Math.max(h, hBall);
  }

  private wildHeight(x: number, z: number): number {
    // base 6.5: varia de 0 a 13 — sempre emerso (agua em -0.6)
    return 6.5
      + 3.5 * Math.sin(x * 0.011 + 1.7) * Math.sin(z * 0.013 + 0.4)
      + 2 * Math.sin(x * 0.023 + 0.3) * Math.sin(z * 0.019 + 2.2)
      + 1 * Math.sin(x * 0.051 + 4.1) * Math.sin(z * 0.047 + 1.2);
  }

  /** 1 = totalmente plano (0.1). Cidade, fazenda, estradas, distritos suaves. */
  private flatMask(x: number, z: number): number {
    let m = 0;
    m = Math.max(m, 1 - smoothstep(CITY.r, CITY.r + 60, Math.hypot(x - CITY.x, z - CITY.z)));
    m = Math.max(m, 1 - smoothstep(300, 360, Math.hypot(x - BALL.x, z - BALL.z)));
    if (Math.abs(x) < 14 && z > -1090 && z < 1160) m = 1;
    if (Math.abs(z) < 14 && x > -1405 && x < 1155) m = 1;
    if (Math.abs(x) < 12 && z > -1450 && z < -1070) m = 1;
    if (x > DAM_RECT.x0 - 20 && x < DAM_RECT.x1 + 20 && z > DAM_RECT.z0 - 20 && z < DAM_RECT.z1 + 20) m = 1;
    const dc = Math.hypot(x - CEMETERY.x, z - CEMETERY.z);
    m = Math.max(m, (1 - smoothstep(CEMETERY.r, CEMETERY.r + 30, dc)) * 0.85);
    const dg = Math.hypot(x - GOATS.x, z - GOATS.z);
    m = Math.max(m, (1 - smoothstep(GOATS.r, GOATS.r + 30, dg)) * 0.85);
    return Math.min(1, m);
  }

  private buildTerrainMesh(): THREE.BufferGeometry {
    const N = 384;
    const SIZE = 7000, CZ = -200;
    const geo = new THREE.PlaneGeometry(SIZE, SIZE, N - 1, N - 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    const rock = new THREE.Color(0x7a6a55);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i) + CZ;
      const h = this.groundHeight(x, z);
      pos.setY(i, h);
      const m = this.flatMask(x, z);
      const e = 4;
      const sx = (this.groundHeight(x + e, z) - this.groundHeight(x - e, z)) / (2 * e);
      const sz = this.groundHeight(x, z + e) - this.groundHeight(x, z - e);
      const slope = Math.min(1, (Math.abs(sx) + Math.abs(sz)) / 2);
      if (h < -0.6) c.setHex(0x8a7a55);
      else if (Math.hypot(x - CITY.x, z - CITY.z) < CITY.r + 30) {
        c.setHex(0x8f9078); // chão urbano da cidade (não areia!)
        c.multiplyScalar(0.92 + 0.16 * Math.sin(x * 0.11 + z * 0.13));
      } else if (h < 0.5 && m < 0.5) c.setHex(0xd9c27a); // praia (só fora do plano)
      else {
        c.setHex(0x4a8c2a);
        c.multiplyScalar(0.9 + 0.2 * Math.sin(x * 0.05 + z * 0.07));
        const rocky = Math.min(1, Math.max(0, (slope - 0.5) * 2) + Math.max(0, h - 30) / 40);
        if (rocky > 0) c.lerp(rock, Math.min(1, rocky));
      }
      const dv = Math.hypot(x - MINE.x, z - MINE.z);
      if (dv < 150) c.lerp(new THREE.Color(0x3a3230), (1 - dv / 150) * 0.7);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    mesh.position.set(0, 0, CZ);
    mesh.receiveShadow = true;
    this.scene.add(mesh);
    return geo;
  }

private buildRoads() {
    const roadMat = new THREE.MeshLambertMaterial({ color: 0x444444 });
    const lineMat = new THREE.MeshLambertMaterial({ color: 0xffff88 });
    const walkMat = new THREE.MeshLambertMaterial({ color: 0xb8b8b8 });
    // N-S (x=0): z -1080..1150 (chega na ponte) ; E-W (z=0): x -1400..1150
    const r1 = new THREE.Mesh(new THREE.BoxGeometry(6, 0.1, 2230), roadMat);
    r1.position.set(0, 0.1, 35);
    r1.receiveShadow = true;
    this.scene.add(r1);
    const r2 = new THREE.Mesh(new THREE.BoxGeometry(2550, 0.1, 6), roadMat);
    r2.position.set(-125, 0.1, 0);
    r2.receiveShadow = true;
    this.scene.add(r2);
    // calçadas das avenidas
    for (const s of [-4.5, 4.5]) {
      const s1 = new THREE.Mesh(new THREE.BoxGeometry(3, 0.12, 2230), walkMat);
      s1.position.set(s, 0.12, 35);
      s1.receiveShadow = true;
      this.scene.add(s1);
      const s2 = new THREE.Mesh(new THREE.BoxGeometry(2550, 0.12, 3), walkMat);
      s2.position.set(-125, 0.12, s);
      s2.receiveShadow = true;
      this.scene.add(s2);
    }
    // faixas: 1 InstancedMesh (~800 faixas em 1 draw call; E-W usa a mesma geo girada)
    {
      const mats: THREE.Matrix4[] = [];
      const m4 = new THREE.Matrix4();
      for (let i = -1080; i <= 1150; i += 6) {
        m4.makeTranslation(0, 0.16, i);
        mats.push(m4.clone());
      }
      for (let i = -1400; i <= 1150; i += 6) {
        m4.makeRotationY(Math.PI / 2);
        m4.setPosition(i, 0.16, 0);
        mats.push(m4.clone());
      }
      const lines = new THREE.InstancedMesh(new THREE.BoxGeometry(0.3, 0.12, 2), lineMat, mats.length);
      mats.forEach((mm, idx) => lines.setMatrixAt(idx, mm));
      lines.instanceMatrix.needsUpdate = true;
      lines.receiveShadow = true;
      this.scene.add(lines);
    }
  }

  /** Anel de muros invisiveis na costa (segue a baia; abre gap na ponte). */
  private buildBoundaryWalls() {
    const N = 64;
    for (let i = 0; i < N; i++) {
      const thm = ((i + 0.5) / N) * Math.PI * 2;
      const r = islandRadius(thm, true) + 5;
      const x = Math.cos(thm) * r;
      const z = Math.sin(thm) * r;
      const segLen = (2 * Math.PI * ISLAND_R) / N + 4;
      // gap da ponte: pula segmentos que cruzam o corredor x=±8 na regiao da baia
      if (z < -950 && Math.abs(x) < segLen / 2 + 10) continue;
      const yaw = -thm - Math.PI / 2;
      const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(x, 4, z);
      const body = this.world.createRigidBody(bodyDesc);
      const col = RAPIER.ColliderDesc.cuboid(segLen / 2, 10, 1.2).setRotation({
        x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2),
      });
      this.world.createCollider(col, body);
      this.wallCount++;
    }
    // anel na ilha redonda (gap na chegada da ponte)
    const NB = 24;
    for (let i = 0; i < NB; i++) {
      const thm = ((i + 0.5) / NB) * Math.PI * 2;
      const x = BALL.x + Math.cos(thm) * (BALL.r + 5);
      const z = BALL.z + Math.sin(thm) * (BALL.r + 5);
      const segLen = (2 * Math.PI * BALL.r) / NB + 4;
      if (z > -1500 && z < -1300 && Math.abs(x) < segLen / 2 + 10) continue;
      const yaw = -thm - Math.PI / 2;
      const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(x, 4, z);
      const body = this.world.createRigidBody(bodyDesc);
      const col = RAPIER.ColliderDesc.cuboid(segLen / 2, 10, 1.2).setRotation({
        x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2),
      });
      this.world.createCollider(col, body);
      this.wallCount++;
    }
  }

  /** Penhascos nos trechos grossos do desenho (lados da baia). */
  private buildCliffs() {
    const rockMat = new THREE.MeshLambertMaterial({ color: 0x7a7a7a });
    const arcs: Array<[number, number, number]> = [
      [-2.7, -1.65, 80],
      [-1.5, -0.95, 50],
    ];
    for (const [a0, a1, n] of arcs) {
      for (let i = 0; i < n; i++) {
        const th = a0 + ((i + 0.5) / n) * (a1 - a0);
        const r = islandRadius(th, true) - 50;
        const x = Math.cos(th) * r;
        const z = Math.sin(th) * r;
        const w = 20 + worldRand() * 12;
        const h = 20 + worldRand() * 20;
        const d = 16 + worldRand() * 10;
        const gy = this.groundHeight(x, z);
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), rockMat);
        mesh.position.set(x, gy + h / 2 - 2, z);
        mesh.rotation.y = (worldRand() - 0.5) * 0.3;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.scene.add(mesh);
        const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(x, 0, z);
        const body = this.world.createRigidBody(bodyDesc);
        const col = RAPIER.ColliderDesc.cuboid(w / 2, h / 2, d / 2)
          .setTranslation(0, gy + h / 2 - 2, 0);
        this.world.createCollider(col, body);
        this.cliffCount++;
      }
    }
  }

  /** Boias marcando o limite da agua. */
  private buildBuoys() {
    const N = 160;
    for (let i = 0; i < N; i++) {
      const th = (i / N) * Math.PI * 2;
      const r = islandRadius(th, true) + 1.5;
      const bx = Math.cos(th) * r;
      const bz = Math.sin(th) * r;
      if (Math.abs(bx) < 6 && bz < -1000) continue; // nao entra na ponte
      const color = i % 2 === 0 ? 0xff3333 : 0xffffff;
      const b = new THREE.Mesh(
        new THREE.SphereGeometry(0.5, 8, 6),
        new THREE.MeshLambertMaterial({ color }),
      );
      b.position.set(bx, -0.1, bz);
      this.scene.add(b);
      this.buoyCount++;
      this.buoyPos.push({ x: bx, z: bz });
    }
    // anel na ilha redonda (pula a chegada da ponte)
    const NB = 64;
    for (let i = 0; i < NB; i++) {
      const th = (i / NB) * Math.PI * 2;
      const bx = BALL.x + Math.cos(th) * (BALL.r + 1.5);
      const bz = BALL.z + Math.sin(th) * (BALL.r + 1.5);
      if (Math.abs(bx) < 6 && bz > -1600) continue;
      const color = i % 2 === 0 ? 0xff3333 : 0xffffff;
      const b = new THREE.Mesh(
        new THREE.SphereGeometry(0.5, 8, 6),
        new THREE.MeshLambertMaterial({ color }),
      );
      b.position.set(bx, -0.1, bz);
      this.scene.add(b);
      this.buoyCount++;
      this.buoyPos.push({ x: bx, z: bz });
    }
  }

  /** Templates dos 8 prédios OBJ (medidos uma vez, clonados). */
  private buildingTemplates: { group: THREE.Group; halfW: number; halfD: number; height: number; minY: number }[] = [];
  private buildingLoading: Promise<void> | null = null;

  private buildingMat(name: string): THREE.Material {
    const nm = name.toLowerCase();
    let color = 0x9a9a9a;
    if (/glass/.test(nm)) color = 0x3c5069;
    else if (/light_gray/.test(nm)) color = 0xbcbcbc;
    else if (/gray/.test(nm)) color = 0x8a8a8a;
    else if (/black/.test(nm)) color = 0x1a1a1a;
    else if (/mirror/.test(nm)) color = 0xaaccee;
    else if (/white/.test(nm)) color = 0xe8e4da;
    else if (/grass/.test(nm)) color = 0x3d7a22;
    else if (/frontcolor|color_d/.test(nm)) color = 0xa06838;
    return new THREE.MeshLambertMaterial({ color });
  }

  private async ensureBuildingTemplates(): Promise<void> {
    if (this.buildingTemplates.length > 0 || this.buildingLoading) {
      if (this.buildingLoading) await this.buildingLoading;
      return;
    }
    this.buildingLoading = this.loadBuildingTemplates().catch((err) => {
      console.warn('Modelos de prédio não carregaram, usando procedural:', err);
    });
    await this.buildingLoading;
  }

  private async loadBuildingTemplates(): Promise<void> {
    const loader = new OBJLoader();
    const files = ['01', '02', '03', '04', '05', '06', '08', '10'];
    for (const f of files) {
      const url = `models/buildings/${f}.obj`;
      const text = await (await fetch(url)).text();
      // blocos `o` -> nomes usemtl em ordem (para mapear os grupos)
      const blocks: string[][] = [];
      for (const chunk of text.split(/^o /m)) {
        const names = [...chunk.matchAll(/^usemtl (.+)$/gm)].map((mm) => mm[1].trim());
        if (names.length > 0) blocks.push(names);
      }
      const model = await loader.loadAsync(url);
      let meshCount = 0;
      const groupNames: string[] = [];
      let bi = 0;
const towerBox = new THREE.Box3();
      const partLog: string[] = [];
      model.updateMatrixWorld(true);
      model.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.castShadow = true;
        m.receiveShadow = true;
        const names = blocks[bi++] ?? ['default'];
        const mats = names.map((n) => this.buildingMat(n));
        m.material = mats.length > 1 ? mats : mats[0]!;
        meshCount++;
        groupNames.push(names.join('+'));
        // bbox por grupo de material (placas de chão/rua não entram no collider)
        const gp = m.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
        const gi = m.geometry.index;
        const vCount = gp ? gp.count : 0;
        const gg = m.geometry.groups.length > 0 ? m.geometry.groups : [{ start: 0, count: vCount, materialIndex: 0 }];
        const v = new THREE.Vector3();
        gg.forEach((gr) => {
          const nm = names[gr.materialIndex ?? 0] ?? names[0] ?? '?';
          const b = new THREE.Box3();
          if (gp) {
            const end = Math.min(gr.start + gr.count, gi ? gi.count : vCount);
            for (let k = gr.start; k < end; k++) {
              const vi = gi ? gi.getX(k) : k;
              v.fromBufferAttribute(gp, vi).applyMatrix4(m.matrixWorld);
              b.expandByPoint(v);
            }
          }
          if (!b.isEmpty()) {
            const bs = b.getSize(new THREE.Vector3());
            partLog.push(`${nm}:${Math.round(bs.x)}x${Math.round(bs.y)}x${Math.round(bs.z)}`);
            const flatPlate = bs.y < 3 && Math.max(bs.x, bs.z) > 30;
            if (!/grass|ground|base|plane|terrain|road|sidewalk|asphalt|groundcover|vegetation/i.test(nm) && !flatPlate) {
              towerBox.union(b);
            }
          }
        });
      });
      model.updateMatrixWorld(true);
      const box = towerBox.isEmpty() ? new THREE.Box3().setFromObject(model) : towerBox;
      const size = box.getSize(new THREE.Vector3());
      console.log(`[building] ${f}.obj meshes=${meshCount} size=${size.x.toFixed(1)}x${size.y.toFixed(1)}x${size.z.toFixed(1)} parts=${partLog.join('|').slice(0, 400)}`);
      this.buildingTemplates.push({
        group: model as unknown as THREE.Group,
        halfW: size.x / 2, halfD: size.z / 2, height: size.y, minY: box.min.y,
      });
    }
  }

  async buildBuildings(count: number) {
    await this.ensureBuildingTemplates();
    let built = 0;
    // grade espaçada (torres gigantes); ruas cortam nos eixos
    const step = 200;
    for (let gx = CITY.x - CITY.r; gx <= CITY.x + CITY.r && built < count; gx += step) {
      for (let gz = CITY.z - CITY.r; gz <= CITY.z + CITY.r && built < count; gz += step) {
        const bx = gx + (worldRand() - 0.5) * 60;
        const bz = gz + (worldRand() - 0.5) * 60;
        if (this.tryBuildingSpot(bx, bz, count)) built++;
      }
    }
    // completa com aleatórios
    let attempts = 0;
    while (built < count && attempts < count * 40) {
      attempts++;
      const tha = worldRand() * Math.PI * 2;
      const rr = Math.sqrt(worldRand()) * CITY.r;
      const bx = CITY.x + Math.cos(tha) * rr;
      const bz = CITY.z + Math.sin(tha) * rr;
      if (this.tryBuildingSpot(bx, bz, count)) built++;
    }
  }

  /** Prédio de modelo: escala pra altura sorteada, collider box na medida. */
  private tryModelBuilding(bx: number, bz: number, target: number): boolean {
    const tpl = this.buildingTemplates[Math.floor(worldRand() * this.buildingTemplates.length)];
    if (!tpl || tpl.height <= 0) return false;
    const bh = 80 + worldRand() * 120; // torres de 80-200m
    const s = bh / tpl.height;
    let halfW = tpl.halfW * s;
    let halfD = tpl.halfD * s;
    const rotIdx = Math.floor(worldRand() * 4);
    if (rotIdx % 2 === 1) { const t = halfW; halfW = halfD; halfD = t; }
    if (Math.abs(bx) < halfW + 5 && bz > -1085 && bz < 1155) return false;
    if (Math.abs(bz) < halfD + 5 && bx > -1405 && bx < 1155) return false;
    if (Math.abs(bx) < 450 && Math.abs(bz - CITY.z) < 450) {
      const rx = Math.abs(bx - Math.round(bx / 100) * 100);
      const rz = Math.abs((bz - CITY.z) - Math.round((bz - CITY.z) / 100) * 100);
      if (rx < halfW + 4 || rz < halfD + 4) return false;
    }
    for (const b of this.buildings) {
      const dx = Math.abs(bx - b.x);
      const dz = Math.abs(bz - b.z);
      if (dx < b.halfW + halfW + 4 && dz < b.halfD + halfD + 4) return false;
    }
    const g = new THREE.Group();
    g.add(tpl.group.clone(true));
    g.position.set(bx, -tpl.minY * s, bz);
    g.scale.setScalar(s);
    g.rotation.y = rotIdx * Math.PI / 2;
    // sombra só perto do centro (além de 200m não projeta: economiza o shadow map)
    if (Math.hypot(bx - CITY.x, bz - CITY.z) > 200) {
      g.traverse((o) => {
        const mm = o as THREE.Mesh;
        if (mm.isMesh) mm.castShadow = false;
      });
    }
    this.scene.add(g);
    const body = this.fixedBody(bx, bz);
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(halfW, bh / 2, halfD).setTranslation(0, bh / 2, 0), body);
    this.buildings.push({
      id: this.nextId(), x: bx, z: bz, halfW, halfD, height: bh,
      mesh: g, body, collider,
    });
    this.showLoading(10 + (this.buildings.length / target) * 40, 'Construindo cidade...');
    return true;
  }

  private tryBuildingSpot(bx: number, bz: number, target: number): boolean {
    const bColors = [0xb5af9f, 0xa5a098, 0xcdc6c0, 0x918a84, 0xc3bcb6, 0xafa8a2, 0xd2c8c3];
    const roofColors = [0x7d5540, 0x644632, 0x8c5f41];
    if (Math.hypot(bx, bz - 8) < 14) return false;
    if (Math.hypot(bx - CITY.x, bz - CITY.z) > CITY.r) return false;
    if (!this.isOnIsland(bx, bz, 14)) return false;
    if (this.clearOfDistricts(bx, bz, false)) return false;
    // modelo 3D (com fallback procedural se não carregou)
    if (this.buildingTemplates.length > 0) {
      return this.tryModelBuilding(bx, bz, target);
    }
    const bw = 4 + worldRand() * 8;
    const bd = 4 + worldRand() * 8;
    if (Math.abs(bx) < bw / 2 + 5 && bz > -1085 && bz < 1155) return false;
    if (Math.abs(bz) < bd / 2 + 5 && bx > -1405 && bx < 1155) return false;
    // ruas menores da cidade (grade de 100m)
    if (Math.abs(bx) < 450 && Math.abs(bz - CITY.z) < 450) {
      const rx = Math.abs(bx - Math.round(bx / 400) * 400);
      const rz = Math.abs((bz - CITY.z) - Math.round((bz - CITY.z) / 400) * 400);
      if (rx < bw / 2 + 4 || rz < bd / 2 + 4) return false;
    }
    for (const b of this.buildings) {
      const dx = Math.abs(bx - b.x);
      const dz = Math.abs(bz - b.z);
      if (dx < b.halfW + bw / 2 + 4 && dz < b.halfD + bd / 2 + 4) return false;
    }
    const bh = 6 + worldRand() * 20;
      const color = bColors[Math.floor(worldRand() * bColors.length)];
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(bw, bh, bd),
        new THREE.MeshLambertMaterial({ color }),
      );
      mesh.position.set(bx, bh / 2, bz);
      const nearCity = Math.hypot(bx - CITY.x, bz - CITY.z) <= 200;
      mesh.castShadow = nearCity;
      mesh.receiveShadow = true;
      this.scene.add(mesh);

      const roof = new THREE.Mesh(
        new THREE.BoxGeometry(bw + 0.5, 0.4, bd + 0.5),
        new THREE.MeshLambertMaterial({ color: roofColors[Math.floor(worldRand() * roofColors.length)] }),
      );
      roof.position.set(bx, bh + 0.2, bz);
      roof.castShadow = nearCity;
      this.scene.add(roof);

      this.addWindows(bx, bh, bz, bw, bd);

      // entrada: porta virada pra rua principal mais próxima
      const faceX = Math.abs(bx) <= Math.abs(bz);
      const sx = faceX ? -Math.sign(bx) || 1 : 0;
      const sz = faceX ? 0 : -Math.sign(bz) || 1;
      const doorFrame = new THREE.Mesh(new THREE.BoxGeometry(2.6, 3.4, 0.24),
        new THREE.MeshLambertMaterial({ color: 0x6a6a6a }));
      doorFrame.position.set(bx + sx * (bw / 2 + 0.02), 1.7, bz + sz * (bd / 2 + 0.02));
      doorFrame.rotation.y = faceX ? Math.PI / 2 : 0;
      this.scene.add(doorFrame);
      const doorM = new THREE.Mesh(new THREE.BoxGeometry(1.8, 2.8, 0.3),
        new THREE.MeshLambertMaterial({ color: 0x2a1f14 }));
      doorM.position.set(bx + sx * (bw / 2 + 0.05), 1.4, bz + sz * (bd / 2 + 0.05));
      doorM.rotation.y = faceX ? Math.PI / 2 : 0;
      this.scene.add(doorM);

      const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(bx, 0, bz);
      const body = this.world.createRigidBody(bodyDesc);
      const colliderDesc = RAPIER.ColliderDesc.cuboid(bw / 2, bh / 2, bd / 2);
      const collider = this.world.createCollider(colliderDesc, body);

      this.buildings.push({
        id: this.nextId(), x: bx, z: bz, halfW: bw / 2, halfD: bd / 2, height: bh,
        mesh, body, collider,
      });
      this.showLoading(10 + (this.buildings.length / target) * 40, 'Construindo cidade...');
      return true;
  }

  private addWindows(bx: number, bh: number, bz: number, bw: number, bd: number) {
    // 1 InstancedMesh por prédio (acesa/apagada por cor de instância; sem sombra)
    const lit = new THREE.Color(0xffffaa);
    const dark = new THREE.Color(0x3c5069);
    const mats: THREE.Matrix4[] = [];
    const cols: THREE.Color[] = [];
    const m4 = new THREE.Matrix4();
    for (let fy = 2; fy < bh - 1; fy += 4) {
      for (let fx = -bw / 2 + 1; fx < bw / 2; fx += 3.2) {
        for (const fd of [-bd / 2 - 0.01, bd / 2 + 0.01]) {
          const isLit = worldRand() > 0.35;
          m4.makeTranslation(bx + fx, fy, bz + fd);
          mats.push(m4.clone());
          cols.push(isLit ? lit : dark);
        }
      }
    }
    if (mats.length === 0) return;
    const wins = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.8, 1.2, 0.05),
      new THREE.MeshLambertMaterial({ color: 0xffffff }),
      mats.length,
    );
    mats.forEach((mm, idx) => {
      wins.setMatrixAt(idx, mm);
      wins.setColorAt(idx, cols[idx]);
    });
    wins.instanceMatrix.needsUpdate = true;
    if (wins.instanceColor) wins.instanceColor.needsUpdate = true;
    wins.receiveShadow = false;
    this.scene.add(wins);
  }

  async buildTrees(count: number) {
    await this.ensureTreeTemplate();
    let built = 0;
    let attempts = 0;
    while (built < count && attempts < count * 20) {
      attempts++;
      const tx = (worldRand() - 0.5) * WORLD_SIZE * 1.9;
      const tz = (worldRand() - 0.5) * WORLD_SIZE * 1.9;

      // longe de estradas e do centro
      const onNSRoad = Math.abs(tx) < 3.5 && tz > -1085 && tz < 1155;
      const onEWRoad = Math.abs(tz) < 3.5 && tx > -1405 && tx < 1155;
      if (onNSRoad || onEWRoad) continue;
      if (Math.abs(tx) < 6 && Math.abs(tz) < 6) continue;
      if (!this.isOnIsland(tx, tz, 3)) continue;
      if (this.clearOfDistricts(tx, tz, false)) continue;
      if (this.tryPlantTree(tx, tz, false)) {
        built++;
        this.showLoading(60 + built / count * 20, 'Plantando arvores...');
      }
    }
    this.flushTreeInstances(true);
  }

  /** Mata densa da floresta: procedural escuro instanciado (2 draws p/ 150 árvores). */
  async buildForestPatch(cx: number, cz: number, r: number, count: number) {
    await this.ensureTreeTemplate();
    const trunks: THREE.Matrix4[] = [];
    const canopies: THREE.Matrix4[] = [];
    const colors: THREE.Color[] = [];
    const m4pos = new THREE.Vector3();
    const m4quat = new THREE.Quaternion();
    const m4scl = new THREE.Vector3();
    const m4eul = new THREE.Euler();
    const col = new THREE.Color();
    let built = 0;
    let attempts = 0;
    while (built < count && attempts < count * 30) {
      attempts++;
      const th = worldRand() * Math.PI * 2;
      const rr = Math.sqrt(worldRand()) * r;
      const tx = cx + Math.cos(th) * rr;
      const tz = cz + Math.sin(th) * rr;
      if (!this.isOnIsland(tx, tz, 3)) continue;
      let inBuilding = false;
      for (const b of this.buildings) {
        if (Math.abs(tx - b.x) < b.halfW + 1.5 && Math.abs(tz - b.z) < b.halfD + 1.5) { inBuilding = true; break; }
      }
      if (inBuilding) continue;
      const gy = this.groundHeight(tx, tz);
      const th2 = 2 + worldRand() * 3;
      const cr = 1.5 + worldRand() * 2;
      const g = 25 + Math.floor(worldRand() * 25);
      m4pos.set(tx, gy + th2 / 2, tz);
      m4eul.set(0, 0, 0);
      m4quat.setFromEuler(m4eul);
      m4scl.set(1, th2, 1);
      trunks.push(new THREE.Matrix4().compose(m4pos.clone(), m4quat.clone(), m4scl.clone()));
      m4pos.set(tx, gy + th2 + cr * 0.6, tz);
      m4scl.set(cr, cr, cr);
      canopies.push(new THREE.Matrix4().compose(m4pos.clone(), m4quat.clone(), m4scl.clone()));
      colors.push(col.setRGB(0.1, g / 255, 0.12).clone());
      const body = this.fixedBody(tx, tz);
      this.world.createCollider(RAPIER.ColliderDesc.capsule(Math.max(0.2, th2 / 2), 0.28)
        .setTranslation(0, gy + th2 / 2, 0), body);
      this.world.createCollider(RAPIER.ColliderDesc.ball(cr * 0.75)
        .setTranslation(0, gy + th2 + cr * 0.6, 0)
        .setSensor(true), body);
      this.trees.push({ id: this.nextId(), x: tx, z: tz, radius: cr, topY: gy + th2 + cr * 0.6 + cr * 0.75, scale: 1, trunk: this.treeDummy, canopy: this.treeDummy, body });
      built++;
    }
    if (trunks.length > 0) {
      const trunkIM = new THREE.InstancedMesh(
        new THREE.CylinderGeometry(0.15, 0.25, 1, 6),
        new THREE.MeshLambertMaterial({ color: 0x694b2d }), trunks.length);
      trunks.forEach((mm, i) => trunkIM.setMatrixAt(i, mm));
      trunkIM.instanceMatrix.needsUpdate = true;
      trunkIM.castShadow = false;
      trunkIM.computeBoundingSphere();
      this.scene.add(trunkIM);
      const canopyIM = new THREE.InstancedMesh(
        new THREE.SphereGeometry(1, 8, 6),
        new THREE.MeshLambertMaterial({ color: 0xffffff }), canopies.length);
      canopies.forEach((mm, i) => {
        canopyIM.setMatrixAt(i, mm);
        canopyIM.setColorAt(i, colors[i]!);
      });
      canopyIM.instanceMatrix.needsUpdate = true;
      if (canopyIM.instanceColor) canopyIM.instanceColor.needsUpdate = true;
      canopyIM.castShadow = false;
      canopyIM.computeBoundingSphere();
      this.scene.add(canopyIM);
    }
  }

  private async ensureTreeTemplate(): Promise<void> {
    if (this.treeTemplate || this.treeLoading) {
      if (this.treeLoading) await this.treeLoading;
      return;
    }
    this.treeLoading = this.loadTreeTemplate().catch((err) => {
      console.warn('Modelo de arvore nao carregou, usando procedural:', err);
    });
    await this.treeLoading;
  }

  private async loadTreeTemplate(): Promise<void> {
    const t0 = performance.now();
    let model: THREE.Object3D;
    try {
      model = await this.loadAcerModel();
    } catch (err) {
      console.warn('Acer nao carregou, usando gleditsia:', err);
      model = await this.loadGleditsiaModel();
    }
    this.treeInfo.parseMs = Math.round(performance.now() - t0);
    const tTrav = performance.now();

    // normaliza: altura 1, pes em 0, centrado
    const all = new THREE.Box3().setFromObject(model);
    const size = all.getSize(new THREE.Vector3());
    const center = all.getCenter(new THREE.Vector3());
    const s = size.y > 0 ? 1 / size.y : 1;
    const inner = new THREE.Group();
    inner.add(model);
    const wrap = new THREE.Group();
    wrap.add(inner);
    inner.scale.setScalar(s);
    inner.position.set(-center.x * s, -all.min.y * s, -center.z * s);
    wrap.updateMatrixWorld(true);
    this.treeInfo.tTraverseMs = Math.round(performance.now() - tTrav);
    const tMet = performance.now();

    // métricas por vértice (malha fundida: tronco embaixo, copa em cima)
    const v = new THREE.Vector3();
    const BINS = 24;
    const binMax: number[] = new Array(BINS).fill(0);
    wrap.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (!pos) return;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
        const r = Math.hypot(v.x, v.z);
        const b = Math.max(0, Math.min(BINS - 1, Math.floor(v.y * BINS)));
        binMax[b] = Math.max(binMax[b] ?? 0, r);
      }
    });
    const lowR = Math.max(binMax[0] ?? 0, binMax[1] ?? 0, binMax[2] ?? 0, binMax[3] ?? 0, binMax[4] ?? 0);
    const trunkR = Math.max(0.02, lowR * 1.4);
    let trunkTop = 0.4;
    for (let b = 2; b < BINS; b++) {
      if ((binMax[b] ?? 0) > trunkR * 2.5) { trunkTop = b / BINS; break; }
    }
    trunkTop = Math.max(0.25, Math.min(0.6, trunkTop));
    let canopyR = 0.25;
    for (let b = Math.floor(trunkTop * BINS); b < BINS; b++) {
      canopyR = Math.max(canopyR, binMax[b] ?? 0);
    }
    canopyR = Math.max(0.25, canopyR * 0.6);
    this.treeMetrics.trunkTop = trunkTop;
    this.treeMetrics.trunkR = trunkR;
    this.treeMetrics.canopyY = (trunkTop + 1) / 2;
    this.treeMetrics.canopyR = canopyR;

    // dizima só a gleditsia (a acer já vem dizimada do conversor)
    if (this.treeNeedsDecimate) {
      wrap.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) this.decimateGeometry(m.geometry, 12);
      });
    }

    this.treeTemplate = wrap;
    this.treeInfo.tMetricsMs = Math.round(performance.now() - tMet);
    this.treeInfo.loaded = true;
  }

  private treeNeedsDecimate = false;

  /** Acer do pack do usuário (tronco marrom + copa verde). */
  private async loadAcerModel(): Promise<THREE.Object3D> {
    const gltf = await new GLTFLoader().loadAsync('models/tree/acer.glb');
    const model = gltf.scene;
    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6b4a2f });
    const leafMat = new THREE.MeshLambertMaterial({ color: 0x2e6b22, side: THREE.DoubleSide });
    let verts = 0;
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.material = m.name === 'trunk' ? trunkMat : leafMat;
      m.castShadow = true;
      const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (pos) verts += pos.count;
      this.treeInfo.meshes++;
    });
    this.treeInfo.verts = verts;
    this.treeInfo.mats = ['acer-trunk', 'acer-leaf'];
    this.treeNeedsDecimate = false;
    return model;
  }

  /** Gleditsia original (fallback se a acer falhar). */
  private async loadGleditsiaModel(): Promise<THREE.Object3D> {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync('models/tree/tree.glb');
    const model = gltf.scene;

    // O conversor nao embutiu as texturas: atribui manualmente (mapeamento do pack).
    const texLoader = new THREE.TextureLoader();
    const [barkMap, leafMap, flowerMap, branchMap, leafAlpha, flowerAlpha] = await Promise.all([
      texLoader.loadAsync('models/tree/gleditsia triacanthos bark2 a1.jpg').catch(() => null),
      texLoader.loadAsync('models/tree/gleditsia triacanthos leaf color b1.jpg').catch(() => null),
      texLoader.loadAsync('models/tree/gleditsia triacanthos flowers color.jpg').catch(() => null),
      texLoader.loadAsync('models/tree/gleditsia triacanthos bark reflect.jpg').catch(() => null),
      texLoader.loadAsync('models/tree/gleditsia triacanthos leaf mask.jpg').catch(() => null),
      texLoader.loadAsync('models/tree/gleditsia triacanthos flowers mask.jpg').catch(() => null),
    ]);
    const colorMaps: Record<string, THREE.Texture | null> = {
      Material__6: barkMap, Material__8: leafMap, Material__14: flowerMap, Material__5: branchMap,
    };
    const alphaMaps: Record<string, THREE.Texture | null> = {
      Material__8: leafAlpha, Material__14: flowerAlpha,
    };

    let verts = 0;
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = true;
      const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (pos) verts += pos.count;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        const std = mat as THREE.MeshStandardMaterial;
        const name = mat.name || '';
        if (colorMaps[name] && !std.map) std.map = colorMaps[name];
        if (std.map) std.map.colorSpace = THREE.SRGBColorSpace;
        if (alphaMaps[name]) {
          std.alphaMap = alphaMaps[name];
          std.transparent = false;
          std.alphaTest = 0.45;
          std.side = THREE.DoubleSide;
        }
      }
      const allNames = mats.map((mm) => mm.name || '?').join(',');
      if (!this.treeInfo.mats.includes(allNames)) this.treeInfo.mats.push(allNames);
      this.treeInfo.meshes++;
    });
    this.treeInfo.verts = verts;
    this.treeNeedsDecimate = true;
    return model;
  }

  /** Fila de árvores pra instanciar (1 InstancedMesh por mesh do template). */
  private treeQueue: { tx: number; tz: number; s: number; rot: number; gy: number }[] = [];
  private readonly treeDummy = new THREE.Group();

  /** Planta um clone do modelo (altura 4.5-8m, giro aleatório). */
  private plantModelTree(tx: number, tz: number): boolean {
    if (!this.treeTemplate) return false;
    const s = 4.5 + worldRand() * 3.5;
    const gy = this.groundHeight(tx, tz);
    const rot = worldRand() * Math.PI * 2;
    this.treeQueue.push({ tx, tz, s, rot, gy });

    const m = this.treeMetrics;
    const body = this.fixedBody(tx, tz);
    const trunkHalf = (m.trunkTop * s) / 2;
    this.world.createCollider(
      RAPIER.ColliderDesc.capsule(Math.max(0.1, trunkHalf), Math.max(0.12, m.trunkR * s))
        .setTranslation(0, gy + trunkHalf, 0), body);
    this.world.createCollider(
      RAPIER.ColliderDesc.ball(Math.max(0.5, m.canopyR * s))
        .setTranslation(0, gy + m.canopyY * s, 0)
        .setSensor(true), body);

    this.trees.push({
      id: this.nextId(), x: tx, z: tz, radius: m.canopyR * s, topY: gy + s,
      scale: s, trunk: this.treeDummy, canopy: this.treeDummy, body,
    });
    return true;
  }

  /** Cria os InstancedMesh da fila (chamar ao fim de cada plantio).
   *  Agrupa por célula de 640m pra frustum culling voltar a funcionar. */
  private flushTreeInstances(castShadow: boolean): void {
    const queue = this.treeQueue;
    this.treeQueue = [];
    if (queue.length === 0 || !this.treeTemplate) return;
    this.treeTemplate.updateMatrixWorld(true);
    const parts: THREE.Mesh[] = [];
    this.treeTemplate.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) parts.push(m);
    });
    const CELL = 320;
    const cells = new Map<string, typeof queue>();
    for (const q of queue) {
      const key = Math.floor(q.tx / CELL) + ',' + Math.floor(q.tz / CELL);
      let arr = cells.get(key);
      if (!arr) {
        arr = [];
        cells.set(key, arr);
      }
      arr.push(q);
    }
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    const eul = new THREE.Euler();
    const treeM = new THREE.Matrix4();
    const finalM = new THREE.Matrix4();
    for (const cell of cells.values()) {
      for (const part of parts) {
        const im = new THREE.InstancedMesh(part.geometry, part.material, cell.length);
        cell.forEach((q, i) => {
          pos.set(q.tx, q.gy, q.tz);
          eul.set(0, q.rot, 0);
          quat.setFromEuler(eul);
          scl.set(q.s, q.s, q.s);
          treeM.compose(pos, quat, scl);
          // inclui o transform local da parte dentro do template
          finalM.multiplyMatrices(treeM, part.matrixWorld);
          im.setMatrixAt(i, finalM);
        });
        im.instanceMatrix.needsUpdate = true;
        im.castShadow = castShadow;
        im.computeBoundingSphere();
        this.scene.add(im);
      }
    }
  }

  private tryPlantTree(tx: number, tz: number, dark: boolean): boolean {
    for (const b of this.buildings) {
      if (Math.abs(tx - b.x) < b.halfW + 1.5 && Math.abs(tz - b.z) < b.halfD + 1.5) return false;
    }
    if (this.treeTemplate) return this.plantModelTree(tx, tz);
    const gy = this.groundHeight(tx, tz);
    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x694b2d });
    const th = 2 + worldRand() * 3;
    const cr = 1.5 + worldRand() * 2;
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.25, th, 6), trunkMat);
    trunk.position.set(tx, gy + th / 2, tz);
    trunk.castShadow = true;
    this.scene.add(trunk);

    const g = dark ? 25 + Math.floor(worldRand() * 25) : 40 + Math.floor(worldRand() * 60);
    const canopyMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(0.1, g / 255, 0.12) });
    const canopy = new THREE.Mesh(new THREE.SphereGeometry(cr, 8, 6), canopyMat);
    canopy.position.set(tx, gy + th + cr * 0.6, tz);
    canopy.castShadow = true;
    this.scene.add(canopy);

    const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(tx, 0, tz);
    const body = this.world.createRigidBody(bodyDesc);
    // tronco fino (antes o raio da copa criava uma parede invisivel no chao)
    const trunkCol = RAPIER.ColliderDesc.capsule(Math.max(0.2, th / 2), 0.28)
      .setTranslation(0, gy + th / 2, 0);
    this.world.createCollider(trunkCol, body);
    // copa: esfera so na altura certa (sensor: atravessavel, tronco bloqueia)
    const canopyCol = RAPIER.ColliderDesc.ball(cr * 0.75)
      .setTranslation(0, gy + th + cr * 0.6, 0)
      .setSensor(true);
    this.world.createCollider(canopyCol, body);

    this.trees.push({ id: this.nextId(), x: tx, z: tz, radius: cr, topY: gy + th + cr * 0.6 + cr * 0.75, scale: 1, trunk, canopy, body });
    return true;
  }

  buildCannons(count: number) {
    const baseMat = new THREE.MeshLambertMaterial({ color: 0x555555 });
    const barrelMat = new THREE.MeshLambertMaterial({ color: 0x444444 });
    const wheelMat = new THREE.MeshLambertMaterial({ color: 0x2a2a2a });
    const redMat = new THREE.MeshLambertMaterial({ color: 0xff2222 });
    for (let i = 0; i < count; i++) {
      let cx = 15, cz = -10;
      for (let a = 0; a < 50; a++) {
        const px = (worldRand() - 0.5) * 1200;
        const pz = (worldRand() - 0.5) * 1200;
        let nearBuilding = false;
        for (const b of this.buildings) {
          if (Math.abs(px - b.x) < b.halfW + 3 && Math.abs(pz - b.z) < b.halfD + 3) { nearBuilding = true; break; }
        }
        if (!nearBuilding && this.isOnIsland(px, pz, 5)) { cx = px; cz = pz; break; }
      }
      const group = new THREE.Group();
      const base = new THREE.Mesh(new THREE.BoxGeometry(2.5, 1, 2.5), baseMat);
      base.position.y = 0.5;
      base.castShadow = true;
      group.add(base);
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.4, 3.5, 8), barrelMat);
      barrel.rotation.x = Math.PI / 4;
      barrel.position.set(0, 1.5, -1.2);
      barrel.castShadow = true;
      group.add(barrel);
      for (const s of [-0.9, 0.9]) {
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.3, 12), wheelMat);
        wheel.rotation.x = Math.PI / 2;
        wheel.position.set(s, 0.3, 0);
        group.add(wheel);
      }
      const btn = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 8), redMat);
      btn.position.set(0, 0.9, -1.3);
      group.add(btn);

      group.position.set(cx, this.groundHeight(cx, cz), cz);
      this.scene.add(group);

      const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(cx, 0, cz);
      const body = this.world.createRigidBody(bodyDesc);
      const colliderDesc = RAPIER.ColliderDesc.cuboid(1.5, 1, 1.5)
        .setTranslation(0, this.groundHeight(cx, cz), 0);
      this.world.createCollider(colliderDesc, body);

      this.cannons.push({ id: this.nextId(), x: cx, z: cz, group, barrel, body, loadedNPC: null });
    }
    this.showLoading(90, 'Montando canhoes...');
  }

  // ================= DISTRITOS DO MAPA =================

  /** Ruas menores da cidade (grade de 400m, só no plano). */
  private buildCityStreets() {
    const mat = new THREE.MeshLambertMaterial({ color: 0x3d3d3d });
    const walkMat = new THREE.MeshLambertMaterial({ color: 0xb8b8b8 });
    // ruas + calçadas em 2 InstancedMesh (1 por material)
    const roadMats: THREE.Matrix4[] = [];
    const walkMats: THREE.Matrix4[] = [];
    const m4 = new THREE.Matrix4();
    for (let k = -1; k <= 1; k++) {
      m4.makeTranslation(k * 400, 0.07, CITY.z);
      roadMats.push(m4.clone());
      m4.makeRotationY(Math.PI / 2);
      m4.setPosition(CITY.x, 0.07, CITY.z + k * 400);
      roadMats.push(m4.clone());
      for (const s of [-4, 4]) {
        m4.makeTranslation(k * 400 + s, 0.12, CITY.z);
        walkMats.push(m4.clone());
        m4.makeRotationY(Math.PI / 2);
        m4.setPosition(CITY.x, 0.12, CITY.z + k * 400 + s);
        walkMats.push(m4.clone());
      }
    }
    const roads = new THREE.InstancedMesh(new THREE.BoxGeometry(5, 0.1, 600), mat, roadMats.length);
    roadMats.forEach((mm, idx) => roads.setMatrixAt(idx, mm));
    roads.instanceMatrix.needsUpdate = true;
    roads.receiveShadow = true;
    this.scene.add(roads);
    const walks = new THREE.InstancedMesh(new THREE.BoxGeometry(3, 0.12, 600), walkMat, walkMats.length);
    walkMats.forEach((mm, idx) => walks.setMatrixAt(idx, mm));
    walks.instanceMatrix.needsUpdate = true;
    walks.receiveShadow = true;
    this.scene.add(walks);
  }

  buildDistricts() {
    this.showLoading(92, 'Construindo distritos...');
    this.buildCityStreets();
    this.buildFarm();
    this.buildDam();
    this.buildBridge();
    this.buildCemetery();
    this.buildMansion();
    this.buildGoatCity();
    this.buildMine();
    this.buildSigns();
    this.buildTraffic();
    this.buildCampfire();
  }

  /** Fogueira na clareira da floresta (com luz tremeluzente). */
  private buildCampfire() {
    const cx = FOREST.x + 10, cz = FOREST.z + 15;
    const gy = this.groundHeight(cx, cz);
    const stoneMat = new THREE.MeshLambertMaterial({ color: 0x6a6a6a });
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const st = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.5), stoneMat);
      st.position.set(cx + Math.cos(a) * 1.4, gy + 0.2, cz + Math.sin(a) * 1.4);
      this.scene.add(st);
    }
    const logMat = new THREE.MeshLambertMaterial({ color: 0x4a2f1a });
    for (const a of [0.3, 2.4, 4.4]) {
      const log = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 2, 6), logMat);
      log.rotation.z = Math.PI / 2;
      log.rotation.y = a;
      log.position.set(cx, gy + 0.3, cz);
      this.scene.add(log);
    }
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.8, 6),
      new THREE.MeshBasicMaterial({ color: 0xf97316 }));
    flame.position.set(cx, gy + 1.1, cz);
    this.scene.add(flame);
    const ember = new THREE.Mesh(new THREE.ConeGeometry(0.35, 1.0, 6),
      new THREE.MeshBasicMaterial({ color: 0xfde047 }));
    ember.position.set(cx, gy + 1.0, cz);
    this.scene.add(ember);
    this.fireLight = new THREE.PointLight(0xff8030, 60, 30);
    this.fireLight.position.set(cx, gy + 2, cz);
    this.scene.add(this.fireLight);
    this.logProp('campfire', cx, cz);
  }

  /** Carros fantasma nas avenidas (sem colisão, só visual). */
  private buildTraffic() {
    const carColors = [0xef4444, 0x3b82f6, 0xf59e0b, 0x10b981, 0xffffff];
    const mkCar = (color: number): THREE.Group => {
      const car = new THREE.Group();
      const bodyM = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.8, 3.2),
        new THREE.MeshLambertMaterial({ color }));
      bodyM.position.y = 0.6;
      bodyM.castShadow = true;
      car.add(bodyM);
      const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.6, 1.6),
        new THREE.MeshLambertMaterial({ color: 0x111827 }));
      cabin.position.set(0, 1.2, -0.2);
      car.add(cabin);
      return car;
    };
    for (let i = 0; i < 5; i++) {
      const car = mkCar(carColors[i % carColors.length]);
      car.position.set(i % 2 === 0 ? -1.5 : 1.5, 0.1, -1000 + i * 420);
      if (i % 2 === 1) car.rotation.y = Math.PI;
      this.scene.add(car);
      this.cars.push({ mesh: car, axis: 'z', dir: i % 2 === 0 ? 1 : -1, speed: 10 + (i % 3) * 2, min: -1060, max: 1130 });
    }
    for (let i = 0; i < 5; i++) {
      const car = mkCar(carColors[(i + 2) % carColors.length]);
      car.rotation.y = Math.PI / 2;
      car.position.set(-1300 + i * 520, 0.1, i % 2 === 0 ? -1.5 : 1.5);
      this.scene.add(car);
      this.cars.push({ mesh: car, axis: 'x', dir: i % 2 === 0 ? 1 : -1, speed: 10 + (i % 3) * 2, min: -1380, max: 1130 });
    }
    this.logProp('traffic', 0, 0);
  }

  /** Dizima geometria mantendo 1 a cada `factor` triângulos (grupos preservados). */
  private decimateGeometry(geo: THREE.BufferGeometry, factor: number): THREE.BufferGeometry {
    if (factor <= 1) return geo;
    const index = geo.index;
    if (index) {
      const src = index.array;
      const groups = geo.groups.length > 0 ? geo.groups : [{ start: 0, count: src.length, materialIndex: 0 }];
      const kept: number[] = [];
      const newGroups: { start: number; count: number; materialIndex: number }[] = [];
      for (const gr of groups) {
        const start = kept.length;
        for (let t = 0; t < gr.count; t += 3 * factor) {
          kept.push(src[gr.start + t]!, src[gr.start + t + 1]!, src[gr.start + t + 2]!);
        }
        newGroups.push({ start, count: kept.length - start, materialIndex: gr.materialIndex ?? 0 });
      }
      geo.setIndex(kept);
      geo.clearGroups();
      for (const ng of newGroups) geo.addGroup(ng.start, ng.count, ng.materialIndex);
      return geo;
    }
    const posAttr = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!posAttr) return geo;
    const triCount = Math.floor(posAttr.count / 3);
    for (const name of Object.keys(geo.attributes)) {
      const attr = geo.getAttribute(name) as THREE.BufferAttribute;
      const itemSize = attr.itemSize;
      const arr = attr.array as Float32Array;
      const out = new Float32Array(Math.ceil(triCount / factor) * 3 * itemSize);
      let w = 0;
      for (let t = 0; t < triCount; t += factor) {
        for (let k = 0; k < 3 * itemSize; k++) out[w++] = arr[t * 3 * itemSize + k]!;
      }
      geo.setAttribute(name, new THREE.BufferAttribute(out.slice(0, w), itemSize));
    }
    return geo;
  }

  /** Grama bermuda em touceiras nos pontos de interesse (instanced por hub, com culling). */
  async buildGrass(_count: number) {
    void _count;
    try {
      const loader = new FBXLoader();
      const model = await loader.loadAsync('models/grass/bermuda+grass.fbx');

      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      // normaliza o tufo pra ~0.5m de altura
      const s = size.y > 0 ? 0.5 / size.y : 1;
      const norm = new THREE.Matrix4()
        .makeScale(s, s, s)
        .setPosition(-center.x * s, -box.min.y * s, -center.z * s);

      const sources: { geo: THREE.BufferGeometry; mat: THREE.Material | THREE.Material[] }[] = [];
      let verts = 0;
      const matNames: string[] = [];
      model.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const geo = this.decimateGeometry(m.geometry.clone().applyMatrix4(norm), 36);
        const gp = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
        if (gp) {
          const idx = geo.index;
          verts += idx ? idx.count : gp.count;
        }
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        // ignora os materiais do Arnold (vêm cinza): verde de verdade por nome
        const ownMats: THREE.Material[] = mats.map((mat) => {
          const nm = (mat.name || '').toLowerCase();
          let color = 0x55aa33;
          if (/yellow/.test(nm)) color = 0xa8b83c;
          else if (/burn/.test(nm)) color = 0xb89a4a;
          else if (/green/.test(nm)) color = 0x4a9c2d;
          const lm = new THREE.MeshLambertMaterial({ color });
          lm.side = THREE.DoubleSide;
          return lm;
        });
        for (const mat of mats) {
          const nm = mat.name || '?';
          if (!matNames.includes(nm)) matNames.push(nm);
        }
        sources.push({ geo, mat: ownMats.length > 1 ? ownMats : ownMats[0]! });
      });
      console.log(`[grass] meshes=${sources.length} verts/tufo=${verts} size=${size.x.toFixed(1)}x${size.y.toFixed(1)}x${size.z.toFixed(1)} mats=${matNames.join(',')}`);

      // grade de touceiras pequenas por célula (com culling por célula)
      type Spot = { x: number; z: number; sxz: number; sy: number; rot: number };
      const cells = new Map<string, Spot[]>();
      const STEP = 320;
      for (let gx = -1520; gx <= 1520; gx += STEP) {
        for (let gz = -2320; gz <= 1520; gz += STEP) {
          const key = gx + ',' + gz;
          const spots: Spot[] = [];
          let guard = 0;
          while (spots.length < 16 && guard++ < 250) {
            const th = worldRand() * Math.PI * 2;
            const rr = Math.sqrt(worldRand()) * (STEP * 0.72);
            const x = gx + Math.cos(th) * rr;
            const z = gz + Math.sin(th) * rr;
            if (!this.isOnIsland(x, z, 2)) continue;
            if (Math.abs(x) < 7 && z > -1085 && z < 1155) continue;
            if (Math.abs(z) < 7 && x > -1405 && x < 1155) continue;
            if (x > DAM_RECT.x0 && x < DAM_RECT.x1 && z > DAM_RECT.z0 && z < DAM_RECT.z1) continue;
            let inBuilding = false;
            for (const b of this.buildings) {
              if (Math.abs(x - b.x) < b.halfW + 2 && Math.abs(z - b.z) < b.halfD + 2) { inBuilding = true; break; }
            }
            if (inBuilding) continue;
            spots.push({ x, z, sxz: 0.3 + worldRand() * 0.2, sy: 1.6 + worldRand() * 0.8, rot: worldRand() * Math.PI * 2 });
          }
          if (spots.length > 0) cells.set(key, spots);
        }
      }
      // anel garantido ao redor do spawn (pra ver de cara), fora da rua
      {
        const spots: Spot[] = [];
        let guard = 0;
        while (spots.length < 10 && guard++ < 100) {
          const th = worldRand() * Math.PI * 2;
          const rr = 8 + worldRand() * 17;
          const x = SPAWN.x + Math.cos(th) * rr;
          const z = SPAWN.z + Math.sin(th) * rr;
          if (Math.abs(x) < 7) continue;
          if (Math.abs(z) < 7) continue;
          spots.push({ x, z, sxz: 0.3 + worldRand() * 0.2, sy: 1.6 + worldRand() * 0.8, rot: worldRand() * Math.PI * 2 });
        }
        if (spots.length > 0) cells.set('spawn', spots);
      }
      this.grassInfo.spawnCount = cells.get('spawn')?.length ?? 0;
      const dummy = new THREE.Object3D();
      const col = new THREE.Color();
      let total = 0;
      for (const spots of cells.values()) {
        for (const src of sources) {
          const im = new THREE.InstancedMesh(src.geo, src.mat, Math.max(spots.length, 1));
          im.count = spots.length;
          spots.forEach((p, i) => {
            dummy.position.set(p.x, this.groundHeight(p.x, p.z) + 0.05, p.z);
            dummy.rotation.set(0, p.rot, 0);
            dummy.scale.set(p.sxz, p.sy, p.sxz);
            dummy.updateMatrix();
            im.setMatrixAt(i, dummy.matrix);
            im.setColorAt(i, col.setHSL(0.25 + worldRand() * 0.08, 0.35 + worldRand() * 0.25, 0.72 + worldRand() * 0.26));
          });
          im.instanceMatrix.needsUpdate = true;
          if (im.instanceColor) im.instanceColor.needsUpdate = true;
          im.castShadow = false;
          im.receiveShadow = true;
          im.computeBoundingSphere();
          this.scene.add(im);
        }
        total += spots.length;
      }
      this.grassInfo.loaded = true;
      this.grassInfo.instances = total;
      this.grassInfo.verts = verts;
      this.grassInfo.mats = matNames;
      this.grassInfo.sample = [];
      {
        let k = 0;
        for (const spots of cells.values()) {
          for (const p of spots) {
            if (k++ % 7 === 0) this.grassInfo.sample.push({ x: p.x, z: p.z });
          }
        }
      }
      console.log(`[grass] plantados=${total}`);
    } catch (err) {
      console.warn('Grama nao carregou:', err);
    }
  }

  /** Cerca branca retangular (trilhos + mourões). Retorna corpo fixo com colliders. */
  private buildFenceRect(cx: number, cz: number, w: number, d: number): void {
    const fenceMat = new THREE.MeshLambertMaterial({ color: 0xf0ead8 });
    const body = this.fixedBody(cx, cz);
    const sides: Array<[number, number, number, number]> = [
      [0, -d / 2, w, 0], [0, d / 2, w, 0], [-w / 2, 0, d, 1], [w / 2, 0, d, 1],
    ];
    for (const [ox, oz, len, vertical] of sides) {
      const lx = vertical === 1 ? 0.12 : len;
      const lz = vertical === 1 ? len : 0.12;
      for (const hy of [0.55, 0.95]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(lx, 0.12, lz), fenceMat);
        rail.position.set(cx + ox, hy, cz + oz);
        rail.castShadow = true;
        this.scene.add(rail);
      }
      const nPosts = Math.max(2, Math.round(len / 2));
      for (let i = 0; i <= nPosts; i++) {
        const t = nPosts === 0 ? 0 : (i / nPosts - 0.5) * len;
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.1, 0.16), fenceMat);
        post.position.set(cx + ox + (vertical === 1 ? 0 : t), 0.55, cz + oz + (vertical === 1 ? t : 0));
        this.scene.add(post);
      }
      this.solidBox(body, ox, 0.55, oz, (vertical === 1 ? 0.12 : len) / 2, 0.5, (vertical === 1 ? len : 0.12) / 2);
    }
  }

  private buildFarm() {
    const redMat = new THREE.MeshLambertMaterial({ color: 0xa83232 });
    const roofMat = new THREE.MeshLambertMaterial({ color: 0x6e2a2a });
    const whiteMat = new THREE.MeshLambertMaterial({ color: 0xf5f0e0 });
    // celeiro (ilha redonda)
    const barn = new THREE.Mesh(new THREE.BoxGeometry(12, 6, 10), redMat);
    barn.position.set(-100, 3, -1900);
    barn.castShadow = true; barn.receiveShadow = true;
    this.scene.add(barn);
    const broof = new THREE.Mesh(new THREE.ConeGeometry(9.5, 4, 4), roofMat);
    broof.position.set(-100, 8, -1900);
    broof.rotation.y = Math.PI / 4;
    broof.castShadow = true;
    this.scene.add(broof);
    const door = new THREE.Mesh(new THREE.BoxGeometry(3, 4, 0.2), whiteMat);
    door.position.set(-100, 2, -1894.9);
    this.scene.add(door);
    const barnBody = this.fixedBody(-100, -1900);
    this.solidBox(barnBody, 0, 5, 0, 6, 5, 5);
    this.logProp('barn', -100, -1900);
    // silo
    const siloMat = new THREE.MeshLambertMaterial({ color: 0xb8bcc0 });
    const silo = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 12, 12), siloMat);
    silo.position.set(80, 6, -1940);
    silo.castShadow = true;
    this.scene.add(silo);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(3.3, 2, 12), roofMat);
    cap.position.set(80, 13, -1940);
    this.scene.add(cap);
    const siloBody = this.fixedBody(80, -1940);
    this.world.createCollider(RAPIER.ColliderDesc.cylinder(6, 3).setTranslation(0, 6, 0), siloBody);
    this.logProp('silo', 80, -1940);
    // currais
    this.buildFenceRect(120, -1800, 12, 12);
    this.buildFenceRect(-180, -1780, 12, 12);
    this.logProp('farmfence', 120, -1800);
    // fardos de feno
    const hayMat = new THREE.MeshLambertMaterial({ color: 0xd8b93c });
    const hayBody = this.fixedBody(0, -1850);
    let placed = 0, guard = 0;
    while (placed < 6 && guard++ < 60) {
      const hx = (worldRand() - 0.5) * 160;
      const hz = -1850 + (worldRand() - 0.5) * 160;
      if (!this.isOnIsland(hx, hz, 3)) continue;
      if (Math.hypot(hx - SPAWN.x, hz - SPAWN.z) < 6) continue;
      if (Math.hypot(hx + 100, hz + 1900) < 15 || Math.hypot(hx - 80, hz + 1940) < 10) continue;
      const hay = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1.5, 10), hayMat);
      hay.rotation.z = Math.PI / 2;
      hay.position.set(hx, 1, hz);
      hay.castShadow = true;
      this.scene.add(hay);
      this.world.createCollider(RAPIER.ColliderDesc.ball(1).setTranslation(hx, 1, hz), hayBody);
      placed++;
    }
    this.logProp('hayfield', 0, -1850);
    // moinho de vento com pás animadas
    {
      const mx = 60, mz = -1820;
      const mgy = this.groundHeight(mx, mz);
      const whiteMat = new THREE.MeshLambertMaterial({ color: 0xf1f5f9 });
      const millBase = new THREE.Mesh(new THREE.CylinderGeometry(2, 3.5, 11, 8), whiteMat);
      millBase.position.set(mx, mgy + 5.5, mz);
      millBase.castShadow = true;
      this.scene.add(millBase);
      const millRoof = new THREE.Mesh(new THREE.ConeGeometry(2.6, 3, 8),
        new THREE.MeshLambertMaterial({ color: 0x7c2d12 }));
      millRoof.position.set(mx, mgy + 12.5, mz);
      this.scene.add(millRoof);
      const blades = new THREE.Group();
      blades.position.set(mx, mgy + 10.5, mz + 2.2);
      const bladeMat = new THREE.MeshLambertMaterial({ color: 0xe2e8f0 });
      for (let i = 0; i < 4; i++) {
        const blade = new THREE.Mesh(new THREE.BoxGeometry(0.8, 8, 0.1), bladeMat);
        blade.rotation.z = (Math.PI / 2) * i;
        blades.add(blade);
      }
      this.scene.add(blades);
      this.windmillBlades = blades;
      const mb = this.fixedBody(mx, mz);
      this.world.createCollider(
        RAPIER.ColliderDesc.cylinder(5.5, 3).setTranslation(0, mgy + 5.5, 0), mb);
      this.logProp('windmill', mx, mz);
    }
  }

  /** Ponte da barragem: liga a ilha redonda a principal (piso no nivel da rua). */
  private buildBridge() {
    const deckMat = new THREE.MeshLambertMaterial({ color: 0x777777 });
    const railMat = new THREE.MeshLambertMaterial({ color: 0xaa3333 });
    const cx = (BRIDGE.x0 + BRIDGE.x1) / 2;
    const cz = (BRIDGE.z0 + BRIDGE.z1) / 2;
    const len = BRIDGE.z1 - BRIDGE.z0;
    const deck = new THREE.Mesh(new THREE.BoxGeometry(8, 0.75, len), deckMat);
    deck.position.set(cx, -0.225, cz);
    deck.receiveShadow = true;
    this.scene.add(deck);
    const bBody = this.fixedBody(cx, cz);
    this.solidBox(bBody, 0, -0.225, 0, 4, 0.375, len / 2);
    // corrimãos (seguram a vaca na ponte)
    for (const s of [-1, 1]) {
      for (const hy of [0.7, 1.1]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.12, len), railMat);
        rail.position.set(cx + s * 3.9, hy, cz);
        this.scene.add(rail);
      }
      for (let z = BRIDGE.z0 + 2; z <= BRIDGE.z1 - 1; z += 4) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.2, 0.18), railMat);
        post.position.set(cx + s * 3.9, 0.6, z);
        this.scene.add(post);
      }
      this.solidBox(bBody, s * 3.9, 0.55, 0, 0.1, 0.55, len / 2);
    }
    this.logProp('bridge', cx, cz);
  }

  private buildDam() {
    const concMat = new THREE.MeshLambertMaterial({ color: 0x999999 });
    // espelho d agua do reservatorio
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(DAM_RECT.x1 - DAM_RECT.x0, DAM_RECT.z1 - DAM_RECT.z0),
      new THREE.MeshLambertMaterial({ color: 0x3a8fcf }),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.set(
      (DAM_RECT.x0 + DAM_RECT.x1) / 2, 0.25, (DAM_RECT.z0 + DAM_RECT.z1) / 2);
    this.scene.add(water);
    // barragem
    const cx = (DAM_RECT.x0 + DAM_RECT.x1) / 2;
    const wallW = DAM_RECT.x1 - DAM_RECT.x0 + 80;
    const wall = new THREE.Mesh(new THREE.BoxGeometry(wallW, 15, 12), concMat);
    wall.position.set(cx, 7.5, DAM_RECT.z1 + 6);
    wall.castShadow = true; wall.receiveShadow = true;
    this.scene.add(wall);
    const damBody = this.fixedBody(cx, DAM_RECT.z1 + 6);
    this.solidBox(damBody, 0, 7.5, 0, wallW / 2, 7.5, 6);
    // torres da comporta
    for (const s of [-1, 1]) {
      const tower = new THREE.Mesh(new THREE.BoxGeometry(9, 24, 9), concMat);
      tower.position.set(cx + s * (wallW / 2 - 6), 12, DAM_RECT.z1 + 6);
      tower.castShadow = true;
      this.scene.add(tower);
    }
    this.logProp('dam', cx, DAM_RECT.z1 + 6);
  }

  private buildCemetery() {
    const { x: cx, z: cz, r } = CEMETERY;
    const stoneMat = new THREE.MeshLambertMaterial({ color: 0x8f8f8f });
    const darkMat = new THREE.MeshLambertMaterial({ color: 0x5a5a5a });
    const body = this.fixedBody(cx, cz);
    let placed = 0, guard = 0;
    while (placed < 20 && guard++ < 300) {
      const th = worldRand() * Math.PI * 2;
      const rr = 5 + Math.sqrt(worldRand()) * (r - 6);
      const sx = cx + Math.cos(th) * rr;
      const sz = cz + Math.sin(th) * rr;
      if (Math.hypot(sx - (cx + 10), sz - (cz + 10)) < 7) continue; // fora do mausoléu
      const sgy = this.groundHeight(sx, sz);
      const stone = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.1, 0.25), stoneMat);
      stone.position.set(sx, sgy + 0.65, sz);
      stone.rotation.y = worldRand() * Math.PI;
      stone.castShadow = true;
      this.scene.add(stone);
      if (placed % 2 === 0) {
        const crossV = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.8, 0.18), darkMat);
        crossV.position.set(sx, sgy + 1.5, sz);
        this.scene.add(crossV);
        const crossH = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.2, 0.18), darkMat);
        crossH.position.set(sx, sgy + 1.6, sz);
        this.scene.add(crossH);
      }
      this.solidBox(body, sx - cx, sgy + 0.65, sz - cz, 0.45, 0.65, 0.3);
      placed++;
    }
    // arvores mortas
    const deadMat = new THREE.MeshLambertMaterial({ color: 0x4a3a2a });
    for (const [ox, oz] of [[-8, -6], [7, 5], [0, -11]]) {
      const tgy = this.groundHeight(cx + ox, cz + oz);
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.35, 5, 6), deadMat);
      trunk.position.set(cx + ox, tgy + 2.5, cz + oz);
      trunk.castShadow = true;
      this.scene.add(trunk);
      for (const [br, ba] of [[0.5, 0.4], [-0.6, 2.2], [0.2, 4.0]]) {
        const branch = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.1, 2.2, 5), deadMat);
        branch.position.set(cx + ox + Math.cos(ba) * 0.8, tgy + 4.2 + br, cz + oz + Math.sin(ba) * 0.8);
        branch.rotation.z = 0.9;
        branch.rotation.y = ba;
        this.scene.add(branch);
      }
      const tb = this.fixedBody(cx + ox, cz + oz);
      this.world.createCollider(
        RAPIER.ColliderDesc.capsule(2.2, 0.3).setTranslation(0, tgy + 2.5, 0), tb);
    }
    // mausoléu gótico
    {
      const mx = cx + 10, mz = cz + 10;
      const mgy = this.groundHeight(mx, mz);
      const maus = new THREE.Mesh(new THREE.BoxGeometry(7, 6, 7), stoneMat);
      maus.position.set(mx, mgy + 3, mz);
      maus.castShadow = true; maus.receiveShadow = true;
      this.scene.add(maus);
      const mroof = new THREE.Mesh(new THREE.ConeGeometry(5.5, 3.5, 4), darkMat);
      mroof.position.set(mx, mgy + 7.5, mz);
      mroof.rotation.y = Math.PI / 4;
      mroof.castShadow = true;
      this.scene.add(mroof);
      const mdoor = new THREE.Mesh(new THREE.BoxGeometry(2, 3.5, 0.2),
        new THREE.MeshLambertMaterial({ color: 0x0a0a0a }));
      mdoor.position.set(mx, mgy + 1.75, mz + 3.55);
      this.scene.add(mdoor);
      const mb = this.fixedBody(mx, mz);
      this.solidBox(mb, 0, mgy + 3, 0, 3.5, 3, 3.5);
      this.logProp('mausoleum', mx, mz);
    }
    this.logProp('cemetery', cx, cz);
  }

  private buildMansion() {
    const { x: cx, z: cz } = MANSION;
    const gy = this.groundHeight(cx, cz); // topo da mesa (~80)
    const whiteMat = new THREE.MeshLambertMaterial({ color: 0xf2ede0 });
    const trimMat = new THREE.MeshLambertMaterial({ color: 0x8a8a8a });
    const darkMat = new THREE.MeshLambertMaterial({ color: 0x223344 });
    const ironMat = new THREE.MeshLambertMaterial({ color: 0x222226 });
    // cercadão gigante com portão ao sul
    const FW = 140, FD = 110;
    const fenceBody = this.fixedBody(cx, cz);
    const railY = (ry: number) => gy + ry;
    for (const [ox, oz, len, vert] of [[0, -FD / 2, FW, 0], [-FW / 2, 0, FD, 1], [FW / 2, 0, FD, 1]] as Array<[number, number, number, number]>) {
      for (const hy of [1.2, 2.2]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(vert === 1 ? 0.18 : len, 0.15, vert === 1 ? len : 0.18), ironMat);
        rail.position.set(cx + ox, railY(hy), cz + oz);
        rail.castShadow = true;
        this.scene.add(rail);
      }
      const nPosts = Math.max(2, Math.round(len / 9));
      for (let i = 0; i <= nPosts; i++) {
        const t = (i / nPosts - 0.5) * len;
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2.8, 0.5), ironMat);
        post.position.set(cx + ox + (vert === 1 ? 0 : t), railY(1.4), cz + oz + (vert === 1 ? t : 0));
        post.castShadow = true;
        this.scene.add(post);
      }
      this.solidBox(fenceBody, ox, railY(1.4), oz, (vert === 1 ? 0.2 : len) / 2, 1.4, (vert === 1 ? len : 0.2) / 2);
    }
    // lado sul: dois lances com vão do portão (8m)
    for (const s of [-1, 1]) {
      const segLen = FW / 2 - 4;
      const ox = s * (4 + segLen / 2);
      for (const hy of [1.2, 2.2]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(segLen, 0.15, 0.18), ironMat);
        rail.position.set(cx + ox, railY(hy), cz + FD / 2);
        this.scene.add(rail);
      }
      this.solidBox(fenceBody, ox, railY(1.4), FD / 2, segLen / 2, 1.4, 0.1);
    }
    // Casa Branca: corpo + pórtico de colunas + janelas + porta
    const house = new THREE.Mesh(new THREE.BoxGeometry(30, 12, 18), whiteMat);
    house.position.set(cx, gy + 6, cz - 8);
    house.castShadow = true; house.receiveShadow = true;
    this.scene.add(house);
    const hBody = this.fixedBody(cx, cz - 8);
    this.solidBox(hBody, 0, gy + 6, 0, 15, 6, 9);
    const entab = new THREE.Mesh(new THREE.BoxGeometry(34, 1.5, 20), trimMat);
    entab.position.set(cx, gy + 12.5, cz - 8);
    this.scene.add(entab);
    for (let i = -2; i <= 2; i++) {
      const colM = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.8, 11, 10), whiteMat);
      colM.position.set(cx + i * 5, gy + 5.5, cz + 2.5);
      colM.castShadow = true;
      this.scene.add(colM);
    }
    for (const wx of [-10, -5, 5, 10]) {
      const win = new THREE.Mesh(new THREE.BoxGeometry(2.2, 3, 0.2), darkMat);
      win.position.set(cx + wx, gy + 7, cz + 1.1);
      this.scene.add(win);
    }
    const door = new THREE.Mesh(new THREE.BoxGeometry(3, 4.5, 0.3),
      new THREE.MeshLambertMaterial({ color: 0x4a2f1a }));
    door.position.set(cx, gy + 2.25, cz + 1.1);
    this.scene.add(door);
    for (let s = 0; s < 3; s++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(6 - s, 0.5, 2 + s * 1.2), trimMat);
      step.position.set(cx, gy + 0.25 + s * 0.4, cz + 3 + s * 0.8);
      this.scene.add(step);
    }
    // jardim: canteiros + fonte + lampiões
    const soilMat = new THREE.MeshLambertMaterial({ color: 0x4a3520 });
    const flowerMats = [0xd43a3a, 0xe8c832, 0xe88ac8].map((cc) => new THREE.MeshLambertMaterial({ color: cc }));
    for (const [bx, bz] of [[-30, 20], [-18, 20], [18, 20], [30, 20], [-30, 34], [30, 34]]) {
      const bed = new THREE.Mesh(new THREE.BoxGeometry(8, 0.6, 4), soilMat);
      bed.position.set(cx + bx, gy + 0.3, cz + bz);
      this.scene.add(bed);
      for (let f = 0; f < 6; f++) {
        const fl = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), flowerMats[f % flowerMats.length]);
        fl.position.set(cx + bx - 3 + f * 1.2, gy + 0.85, cz + bz);
        this.scene.add(fl);
      }
    }
    const basin = new THREE.Mesh(new THREE.CylinderGeometry(4, 4.5, 1.2, 14), trimMat);
    basin.position.set(cx, gy + 0.6, cz + 44);
    basin.castShadow = true;
    this.scene.add(basin);
    const fwater = new THREE.Mesh(new THREE.CircleGeometry(3.6, 14),
      new THREE.MeshLambertMaterial({ color: 0x3a8fcf }));
    fwater.rotation.x = -Math.PI / 2;
    fwater.position.set(cx, gy + 1.25, cz + 44);
    this.scene.add(fwater);
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.7, 3, 8), trimMat);
    pillar.position.set(cx, gy + 2, cz + 44);
    this.scene.add(pillar);
    const fBody = this.fixedBody(cx, cz + 44);
    this.world.createCollider(RAPIER.ColliderDesc.cylinder(0.6, 4).setTranslation(0, gy + 0.6, 0), fBody);
    for (const [lx, lz] of [[-12, 12], [12, 12], [-12, 44], [12, 44]]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 4, 6), ironMat);
      pole.position.set(cx + lx, gy + 2, cz + lz);
      this.scene.add(pole);
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.4, 8, 6),
        new THREE.MeshBasicMaterial({ color: 0xffe9a0 }));
      lamp.position.set(cx + lx, gy + 4.2, cz + lz);
      this.scene.add(lamp);
    }
    // tapete vermelho do portão até a porta
    const carpet = new THREE.Mesh(new THREE.BoxGeometry(4, 0.06, 46),
      new THREE.MeshLambertMaterial({ color: 0xaa2222 }));
    carpet.position.set(cx, gy + 0.14, cz + 32);
    this.scene.add(carpet);
    // piscina + heliponto
    const poolBase = new THREE.Mesh(new THREE.BoxGeometry(14, 0.8, 8),
      new THREE.MeshLambertMaterial({ color: 0xe2e8f0 }));
    poolBase.position.set(cx + 35, gy + 0.4, cz + 10);
    this.scene.add(poolBase);
    const poolWater = new THREE.Mesh(new THREE.PlaneGeometry(12, 6),
      new THREE.MeshLambertMaterial({ color: 0x06b6d4 }));
    poolWater.rotation.x = -Math.PI / 2;
    poolWater.position.set(cx + 35, gy + 0.85, cz + 10);
    this.scene.add(poolWater);
    this.logProp('pool', cx + 35, cz + 10);
    const heli = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, 0.3, 16),
      new THREE.MeshLambertMaterial({ color: 0x334155 }));
    heli.position.set(cx - 45, gy + 0.15, cz + 30);
    heli.receiveShadow = true;
    this.scene.add(heli);
    const hBar1 = new THREE.Mesh(new THREE.BoxGeometry(4, 0.05, 1),
      new THREE.MeshBasicMaterial({ color: 0xffffff }));
    hBar1.position.set(cx - 45, gy + 0.32, cz + 30);
    this.scene.add(hBar1);
    const hBar2 = new THREE.Mesh(new THREE.BoxGeometry(1, 0.05, 4),
      new THREE.MeshBasicMaterial({ color: 0xffffff }));
    hBar2.position.set(cx - 45, gy + 0.32, cz + 30);
    this.scene.add(hBar2);
    this.logProp('helipad', cx - 45, cz + 30);
    this.logProp('mansion', cx, cz);
  }

  private buildGoatCity() {
    const { x: cx, z: cz } = GOATS;
    const wallColors = [0xe8d8b0, 0xd0e8d0, 0xe8c0c0, 0xd0d0e8, 0xf0e8c8];
    const roofMat = new THREE.MeshLambertMaterial({ color: 0x7a4a2a });
    const spots: Array<[number, number]> = [[-10, -6], [8, -8], [-2, 8], [12, 6], [-12, 8], [20, 0], [-2, -14], [2, 14]];
    for (let i = 0; i < spots.length; i++) {
      const [ox, oz] = spots[i];
      const hx = cx + ox, hz = cz + oz;
      const hgy = this.groundHeight(hx, hz);
      const house = new THREE.Mesh(new THREE.BoxGeometry(4, 2.5, 3.5),
        new THREE.MeshLambertMaterial({ color: wallColors[i % wallColors.length] }));
      house.position.set(hx, hgy + 1.25, hz);
      house.castShadow = true; house.receiveShadow = true;
      this.scene.add(house);
      const roof = new THREE.Mesh(new THREE.ConeGeometry(3.4, 1.8, 4), roofMat);
      roof.position.set(hx, hgy + 3.4, hz);
      roof.rotation.y = Math.PI / 4;
      roof.castShadow = true;
      this.scene.add(roof);
      const doorM = new THREE.Mesh(new THREE.BoxGeometry(1, 1.8, 0.15),
        new THREE.MeshLambertMaterial({ color: 0x4a2f1a }));
      doorM.position.set(hx, hgy + 0.9, hz + 1.8);
      this.scene.add(doorM);
      const hb = this.fixedBody(hx, hz);
      this.solidBox(hb, 0, hgy + 2.2, 0, 2, 2.2, 1.75);
      this.logProp('goathouse', hx, hz);
    }
    this.buildFenceRect(cx - 6, cz - 12, 10, 8);
    this.buildFenceRect(cx + 8, cz + 14, 10, 8);
  }

  private buildMine() {
const { x: cx, z: cz } = MINE;
    // vulcão é o relevo (heightfield); aqui: lava que segue a cratera + petróleo + pedras
    const lavaGeo = new THREE.CircleGeometry(20, 24);
    {
      const lp = lavaGeo.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < lp.count; i++) {
        // após rotateX(-90): vértice (x,y) cai em (cx+x, cz-y)
        const gy = this.groundHeight(cx + lp.getX(i), cz - lp.getY(i));
        lp.setZ(i, gy + 0.5);
      }
      lavaGeo.computeVertexNormals();
    }
    const lava = new THREE.Mesh(lavaGeo,
      new THREE.MeshBasicMaterial({ color: 0xff5a1a, side: THREE.DoubleSide }));
    lava.rotation.x = -Math.PI / 2;
    lava.position.set(cx, 0, cz);
    this.scene.add(lava);
    const coreGeo = new THREE.CircleGeometry(10, 16);
    {
      const lp = coreGeo.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < lp.count; i++) {
        const gy = this.groundHeight(cx + lp.getX(i), cz - lp.getY(i));
        lp.setZ(i, gy + 0.8);
      }
      coreGeo.computeVertexNormals();
    }
    const core = new THREE.Mesh(coreGeo,
      new THREE.MeshBasicMaterial({ color: 0xffd23f, side: THREE.DoubleSide }));
    core.rotation.x = -Math.PI / 2;
    core.position.set(cx, 0, cz);
    this.scene.add(core);
    const ventH = this.groundHeight(cx, cz);
    const lavaLight = new THREE.PointLight(0xff4500, 4000, 120);
    lavaLight.position.set(cx, ventH + 8, cz);
    this.scene.add(lavaLight);
    this.logProp('lava', cx, cz);
    // fumaça subindo do vulcão
    {
      const smokeMat = new THREE.MeshLambertMaterial({ color: 0x555555, transparent: true, opacity: 0.55 });
      for (let i = 0; i < 12; i++) {
        const puff = new THREE.Mesh(new THREE.SphereGeometry(2 + worldRand() * 2, 7, 6), smokeMat);
        const py = ventH + 4 + worldRand() * 22;
        puff.position.set(cx + (worldRand() - 0.5) * 8, py, cz + (worldRand() - 0.5) * 8);
        this.scene.add(puff);
        this.smoke.push({ mesh: puff, speed: 3 + worldRand() * 3, maxY: ventH + 28 });
      }
    }
    // torres de perfuração
    {
      const beamMat = new THREE.MeshLambertMaterial({ color: 0x451a03 });
      const mkDerrick = (dx: number, dz: number, h: number) => {
        const dgy = this.groundHeight(cx + dx, cz + dz);
        const dg = new THREE.Group();
        for (let k = 0; k < 4; k++) {
          const a = (Math.PI / 2) * k;
          const post = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.9, h, 4), beamMat);
          post.position.set(Math.cos(a) * 5, h / 2, Math.sin(a) * 5);
          post.rotation.z = Math.cos(a) * 0.12;
          post.rotation.x = Math.sin(a) * 0.12;
          post.castShadow = true;
          dg.add(post);
        }
        for (let b = 1; b < 4; b++) {
          const ring = new THREE.Mesh(new THREE.BoxGeometry(10.5 - b * 2, 0.8, 10.5 - b * 2), beamMat);
          ring.position.y = (h / 4) * b;
          dg.add(ring);
        }
        const pulley = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 1, 8), beamMat);
        pulley.rotation.z = Math.PI / 2;
        pulley.position.y = h + 1;
        dg.add(pulley);
        dg.position.set(cx + dx, dgy, cz + dz);
        this.scene.add(dg);
        const db = this.fixedBody(cx + dx, cz + dz);
        this.solidBox(db, 0, dgy + h / 2, 0, 5, h / 2, 5);
      };
      mkDerrick(-90, -40, 30);
      mkDerrick(-60, 60, 25);
      this.logProp('derrick', cx - 90, cz - 40);
    }
    // máquinas de extrair petróleo (vigas animadas no updatePumps)
    const pumpBaseMat = new THREE.MeshLambertMaterial({ color: 0x8a2f23 });
    const pumpDarkMat = new THREE.MeshLambertMaterial({ color: 0x2e2e2e });
    const angles = [0.4, 1.8, 3.3, 4.9];
    for (let pi = 0; pi < angles.length; pi++) {
      const pa = angles[pi];
      const px = cx + Math.cos(pa) * (130 + (pi % 2) * 40);
      const pz = cz + Math.sin(pa) * (130 + (pi % 2) * 40);
      const gy = this.groundHeight(px, pz);
      const yaw = Math.atan2(-px, -pz) + Math.PI / 2;
      const pump = new THREE.Group();
      const base = new THREE.Mesh(new THREE.BoxGeometry(3, 1, 4), pumpBaseMat);
      base.position.y = 0.5;
      base.castShadow = true;
      pump.add(base);
      for (const s of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.4, 4, 0.4), pumpDarkMat);
        leg.position.set(s * 0.8, 2.5, -0.5);
        leg.rotation.x = 0.35;
        pump.add(leg);
      }
      const beamG = new THREE.Group();
      beamG.position.set(0, 4.2, -0.5);
      const beam = new THREE.Mesh(new THREE.BoxGeometry(6, 0.5, 0.5), pumpBaseMat);
      beam.position.set(1, 0, 0);
      beam.castShadow = true;
      beamG.add(beam);
      const horse = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 0.7), pumpDarkMat);
      horse.position.set(3.6, -0.4, 0);
      beamG.add(horse);
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 5, 6), pumpDarkMat);
      rod.position.set(3.6, -3, 0);
      beamG.add(rod);
      pump.add(beamG);
      pump.position.set(px, gy, pz);
      pump.rotation.y = yaw;
      this.scene.add(pump);
      const pb = this.fixedBody(px, pz);
      this.solidBox(pb, 0, gy + 1, 0, 1.5, 1, 2);
      this.pumps.push({ beam: beamG, phase: pi * 1.7 });
      this.logProp('oilpump', px, pz);
    }
    // vagonete + trilhos no pátio
    const yaw = Math.atan2(-cx, -cz);
    const ex = cx + Math.sin(yaw) * 150;
    const ez = cz + Math.cos(yaw) * 150;
    const egy = this.groundHeight(ex, ez);
    const cart = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1, 2),
      new THREE.MeshLambertMaterial({ color: 0x3a3a3a }));
    cart.position.set(ex + Math.sin(yaw) * 18, egy + 0.6, ez + Math.cos(yaw) * 18);
    cart.rotation.y = yaw;
    cart.castShadow = true;
    this.scene.add(cart);
    const cartBody = this.fixedBody(cart.position.x, cart.position.z);
    this.solidBox(cartBody, 0, egy + 0.6, 0, 0.75, 0.6, 1);
    const railMat = new THREE.MeshLambertMaterial({ color: 0x555555 });
    for (const s of [-0.5, 0.5]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.1, 40), railMat);
      rail.position.set(
        ex + Math.sin(yaw) * 26 + Math.cos(yaw) * s, egy + 0.15, ez + Math.cos(yaw) * 26 - Math.sin(yaw) * s);
      rail.rotation.y = yaw;
      this.scene.add(rail);
    }
    // pedras grandes
    const bigRockMat = new THREE.MeshLambertMaterial({ color: 0x7d6a55 });
    for (const [ox, oz, rr] of [[-42, 18, 7], [36, -30, 9], [12, 42, 6]] as Array<[number, number, number]>) {
      const rgy = this.groundHeight(cx + ox, cz + oz);
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(rr, 0), bigRockMat);
      rock.position.set(cx + ox, rgy + rr * 0.7, cz + oz);
      rock.castShadow = true;
      this.scene.add(rock);
      const rb = this.fixedBody(cx + ox, cz + oz);
      this.world.createCollider(RAPIER.ColliderDesc.ball(rr * 0.85).setTranslation(0, rgy + rr * 0.7, 0), rb);
    }
    this.logProp('mine', cx, cz);
  }

  /** Anima bombas, moinho, carros, fumaça e fogueira. Chamado todo frame. */
  updateAnims(dt: number): void {
    this.pumpT += dt;
    for (const p of this.pumps) {
      p.beam.rotation.z = Math.sin(this.pumpT * 2 + p.phase) * 0.35;
    }
    this.animT += dt;
    if (this.windmillBlades) this.windmillBlades.rotation.z += dt * 1.8;
    for (const c of this.cars) {
      if (c.axis === 'z') {
        c.mesh.position.z += c.speed * c.dir * dt;
        if (c.mesh.position.z > c.max) c.mesh.position.z = c.min;
        if (c.mesh.position.z < c.min) c.mesh.position.z = c.max;
      } else {
        c.mesh.position.x += c.speed * c.dir * dt;
        if (c.mesh.position.x > c.max) c.mesh.position.x = c.min;
        if (c.mesh.position.x < c.min) c.mesh.position.x = c.max;
      }
    }
    for (const s of this.smoke) {
      s.mesh.position.y += s.speed * dt;
      s.mesh.rotation.y += dt * 0.4;
      if (s.mesh.position.y > s.maxY) s.mesh.position.y -= 22;
    }
    if (this.fireLight) {
      this.fireLight.intensity = 1.1 + Math.sin(this.animT * 9) * 0.35;
    }
  }

  private makeSignTexture(lines: string[]): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 192;
    const g = c.getContext('2d')!;
    g.fillStyle = '#6b4a2b';
    g.fillRect(0, 0, 512, 192);
    g.strokeStyle = '#3d2a17';
    g.lineWidth = 12;
    g.strokeRect(6, 6, 500, 180);
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    lines.forEach((ln, i) => {
      g.font = `bold ${ln.length > 14 ? 44 : 64}px Arial`;
      g.fillText(ln, 256, (192 * (i + 1)) / (lines.length + 1));
    });
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  private makeSign(lines: string[], x: number, z: number, yaw: number, signBody: RAPIER.RigidBody): void {
    const group = new THREE.Group();
    const woodMat = new THREE.MeshLambertMaterial({ color: 0x5a4028 });
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 3, 8), woodMat);
    pole.position.y = 1.5;
    pole.castShadow = true;
    group.add(pole);
    const board = new THREE.Mesh(new THREE.BoxGeometry(4.4, 1.7, 0.15), woodMat);
    board.position.y = 3.4;
    board.castShadow = true;
    group.add(board);
    const tex = this.makeSignTexture(lines);
    const faceMat = new THREE.MeshLambertMaterial({ map: tex });
    for (const s of [1, -1]) {
      const face = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 1.55), faceMat);
      face.position.set(0, 3.4, s * 0.085);
      face.rotation.y = s > 0 ? 0 : Math.PI;
      group.add(face);
    }
    group.position.set(x, this.groundHeight(x, z), z);
    group.rotation.y = yaw;
    this.scene.add(group);
    this.solidBox(signBody, x, this.groundHeight(x, z) + 1.6, z, 2.2, 1.6, 0.6);
    this.logProp('sign', x, z);
  }

  private buildSigns() {
    const faceCenter = (x: number, z: number): number => Math.atan2(-x, -z);
    const signBody = this.fixedBody(0, 0);
    this.makeSign(['FAZENDA'], 80, -1520, faceCenter(80, -1520), signBody);
    this.makeSign(['REPRESA'], -20, -300, faceCenter(-20, -300), signBody);
    this.makeSign(['CIDADE'], 60, -60, Math.PI, signBody);
    this.makeSign(['MANSÃO DO', 'PRESIDENTE RAMPIG'], -700, -100, faceCenter(-700, -100), signBody);
    this.makeSign(['CEMITÉRIO'], -450, 150, 0, signBody);
    this.makeSign(['FLORESTA'], 420, 200, Math.PI / 2, signBody);
    this.makeSign(['CIDADE DAS', 'CABRAS'], 750, 500, faceCenter(750, 500), signBody);
    this.makeSign(['MINAS'], -535, 612, faceCenter(-535, 612), signBody);
    this.makeSign(['PONTE'], 80, -1060, Math.PI, signBody);
  }
}