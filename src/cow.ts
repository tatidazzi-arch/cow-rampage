import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { COW_SCALE, loadCowAssets, spawnCowModel } from './cowmodel';
import { tintCowModel } from './skins';
import type { Skin } from './skins';

export { COW_SCALE };
/** Metade da altura do collider (pes ficam em center - HALF_H). */
const HALF_H = 1.1 * COW_SCALE;

export class Cow {
  group: THREE.Group;
  body: RAPIER.RigidBody;
  legs: THREE.Mesh[] = [];
  head!: THREE.Mesh;
  tail!: THREE.Mesh;
  yaw = 0;
  grounded = true;
  jumpCount = 0;
  maxJumps = 5;
  flipT = 0;
  private flipCD = 0;

  // Modelo FBX (carregado de forma assincrona; procedural fica de fallback)
  modelReady = false;
  private mixer: THREE.AnimationMixer | null = null;
  private clips: Record<string, THREE.AnimationClip> = {};
  private currentClip = '';
  private skin: Skin = { id: 'comum', name: '', price: 0, tint: 0xffffff };

  constructor(scene: THREE.Scene, world: RAPIER.World, spawnX = 0, spawnZ = 0) {
    this.group = new THREE.Group();
    this.buildMesh();
    this.buildGadgets();

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawnX, HALF_H + 1.0, spawnZ)
      .setCanSleep(false)
      .setLinearDamping(0.5)
      .lockRotations();
    this.body = world.createRigidBody(bodyDesc);
    // Box no tamanho real da vaca 2x: largura 1.4, altura 4.4, comprimento 4.6
    // Box arredondado no tamanho real: desliza nos cantos em vez de enganchar
    const colliderDesc = RAPIER.ColliderDesc.roundCuboid(0.4, HALF_H - 0.3, 1.15 * COW_SCALE - 0.3, 0.3);
    world.createCollider(colliderDesc, this.body);

    scene.add(this.group);

    void this.loadModel();
  }

  /** Aparelhos das costas: sela, jetpack de bomba atômica e bíblia. */
  private gadgets: Record<string, THREE.Group> = {};
  private flame: THREE.Mesh | null = null;

  private buildGadgets(): void {
    // sela: manta no dorso
    const saddle = new THREE.Group();
    const blanket = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 0.2, 2.2),
      new THREE.MeshLambertMaterial({ color: 0x8a4a2a }),
    );
    blanket.position.set(0, 3.3, -0.2);
    saddle.add(blanket);
    // jetpack: 2 cilindros + faixas vermelhas (bomba atômica!)
    const pack = new THREE.Group();
    const tubeMat = new THREE.MeshLambertMaterial({ color: 0x555560 });
    const bandMat = new THREE.MeshLambertMaterial({ color: 0xcc2222 });
    for (const s of [-0.55, 0.55]) {
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 1.3, 10), tubeMat);
      tube.position.set(s, 3.7, -1.4);
      tube.castShadow = true;
      pack.add(tube);
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.37, 0.37, 0.2, 10), bandMat);
      band.position.set(s, 3.9, -1.4);
      pack.add(band);
    }
    const flame = new THREE.Mesh(
      new THREE.ConeGeometry(0.5, 1.4, 8),
      new THREE.MeshBasicMaterial({ color: 0xff8830 }),
    );
    flame.position.set(0, 2.5, -1.4);
    flame.rotation.x = Math.PI;
    flame.visible = false;
    pack.add(flame);
    this.flame = flame;
    // bíblia: livro marrom + páginas
    const book = new THREE.Group();
    const cover = new THREE.Mesh(
      new THREE.BoxGeometry(0.7, 0.18, 0.9),
      new THREE.MeshLambertMaterial({ color: 0x5a3218 }),
    );
    cover.position.set(0, 3.4, 0.3);
    book.add(cover);
    const pages = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 0.08, 0.8),
      new THREE.MeshLambertMaterial({ color: 0xf5ecd0 }),
    );
    pages.position.set(0, 3.48, 0.3);
    book.add(pages);
    this.gadgets = { sela: saddle, jetpack: pack, biblia: book };
    for (const [id, g] of Object.entries(this.gadgets)) {
      g.visible = id === 'sela';
      this.group.add(g);
    }
  }

  /** Mostra só o aparelho equipado. */
  setGadgetVisual(id: string): void {
    for (const [k, g] of Object.entries(this.gadgets)) g.visible = k === id;
  }

  /** Chama do jetpack (só com jetpack equipado). */
  setFlame(on: boolean): void {
    if (this.flame) this.flame.visible = on;
  }

  private async loadModel(): Promise<void> {
    try {
      const assets = await loadCowAssets();
      const spawned = spawnCowModel(assets);

      const wrap = new THREE.Group();
      wrap.add(spawned.model);
      this.group.add(wrap);

      // Esconde a vaca procedural (fallback) agora que o modelo real chegou.
      for (const child of [...this.group.children]) {
        if (child !== wrap) child.visible = false;
      }

      this.mixer = spawned.mixer;
      this.clips = spawned.clips;
      this.modelReady = true;
      tintCowModel(spawned.model, this.skin);
      this.playClip('idle', 1);
    } catch (err) {
      console.warn('Modelo FBX da vaca nao carregou, usando procedural:', err);
    }
  }

  /** Aplica a skin (tinta o FBX; se ainda não carregou, vale quando chegar). */
  setSkin(skin: Skin): void {
    this.skin = skin;
    if (this.modelReady) tintCowModel(this.group, skin);
  }

  private playClip(name: string, timeScale: number): void {
    if (!this.mixer || !this.clips[name]) return;
    if (this.currentClip !== name) {
      const next = this.mixer.clipAction(this.clips[name]);
      next.reset();
      const prev = this.currentClip && this.clips[this.currentClip]
        ? this.mixer.clipAction(this.clips[this.currentClip])
        : null;
      if (prev) {
        prev.crossFadeTo(next, 0.25, false);
      }
      next.play();
      this.currentClip = name;
    }
    const action = this.mixer.existingAction(this.clips[name]);
    if (action) action.setEffectiveTimeScale(timeScale);
  }

  /** Chamado todo frame pelo Game: avanca o mixer e escolhe idle/walk/run. */
  update(dt: number, speed: number, airborne: boolean): void {
    if (this.mixer) this.mixer.update(dt);
    this.flipCD -= dt;
    if (this.flipT > 0) {
      this.flipT += dt / 0.7;
      if (this.flipT >= 1) {
        this.flipT = 0;
        this.flipCD = 1.0;
        this.group.rotation.x = 0;
      } else {
        this.group.rotation.x = -Math.PI * 2 * this.flipT;
      }
    }
    if (!this.modelReady) return;
    if (airborne) {
      this.idleTime = 0;
      this.oneShotT = 0;
      this.playClip('idle', 1);
      return;
    }
    if (speed > 6.5) {
      this.idleTime = 0;
      this.oneShotT = 0;
      const ts = Math.max(0.8, Math.min(1.5, speed / 8));
      this.playClip('run', ts);
    } else if (speed > 0.8) {
      this.idleTime = 0;
      this.oneShotT = 0;
      const ts = Math.max(0.7, Math.min(1.4, speed / 4));
      this.playClip('walk', ts);
    } else {
      this.playIdleVariety(dt);
    }
  }

  /** Parada: idle, e de vez em quando pasta (eat) ou descansa (idlebreak). */
  private idleTime = 0;
  private oneShotT = 0;

  private playIdleVariety(dt: number): void {
    if (this.oneShotT > 0) {
      this.oneShotT -= dt;
      if (this.oneShotT <= 0) {
        this.oneShotT = 0;
        this.playClip('idle', 1);
      }
      return;
    }
    if (this.currentClip === 'idlebreak' || this.currentClip === 'eat') {
      this.playClip('idle', 1);
      return;
    }
    this.playClip('idle', 1);
    this.idleTime += dt;
    if (this.idleTime > 8 + Math.random() * 10) {
      this.idleTime = 0;
      const pick = Math.random() < 0.5 ? 'eat' : 'idlebreak';
      const clip = this.clips[pick];
      if (clip) {
        this.oneShotT = clip.duration > 0 ? clip.duration : 3;
        this.playClip(pick, 1);
      } else {
        this.idleTime = 4; // tenta de novo em breve
      }
    }
  }

  private buildMesh() {
    const bodyMat = new THREE.MeshLambertMaterial({ color: 0xebe6dc });
    const bellyMat = new THREE.MeshLambertMaterial({ color: 0xfff5c8 });
    const snoutMat = new THREE.MeshLambertMaterial({ color: 0xe1c3af });
    const hornMat = new THREE.MeshLambertMaterial({ color: 0xc8b48c });
    const earMat = new THREE.MeshLambertMaterial({ color: 0xe6dcd2 });
    const legMat = new THREE.MeshLambertMaterial({ color: 0xc3b9a5 });
    const hoofMat = new THREE.MeshLambertMaterial({ color: 0x4b3723 });
    const tailMat = new THREE.MeshLambertMaterial({ color: 0x64503a });
    const spotMat = new THREE.MeshLambertMaterial({ color: 0x372819 });
    const eyeWhiteMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const pupilMat = new THREE.MeshLambertMaterial({ color: 0x281908 });

    const body = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1, 2.2), bodyMat);
    body.position.y = 1.2;
    body.castShadow = true;
    this.group.add(body);

    const belly = new THREE.Mesh(new THREE.BoxGeometry(1, 0.6, 1.6), bellyMat);
    belly.position.set(0, 0.9, 0.1);
    this.group.add(belly);

    this.head = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.6, 0.7), bodyMat);
    this.head.position.set(0, 1.6, 1.3);
    this.head.castShadow = true;
    this.group.add(this.head);

    const snout = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.35), snoutMat);
    snout.position.set(0, 1.45, 1.75);
    this.group.add(snout);

    for (const s of [-0.2, 0.2]) {
      const eyeW = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 8), eyeWhiteMat);
      eyeW.position.set(s, 1.7, 1.55);
      this.group.add(eyeW);
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), pupilMat);
      pupil.position.set(s, 1.7, 1.62);
      this.group.add(pupil);
    }
    for (const s of [-0.25, 0.25]) {
      const horn = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.4, 6), hornMat);
      horn.position.set(s, 2.05, 1.2);
      horn.rotation.z = s > 0 ? -0.3 : 0.3;
      this.group.add(horn);
      const ear = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.08, 0.25), earMat);
      ear.position.set(s * 1.5, 1.75, 1.15);
      this.group.add(ear);
    }

    for (const [px, py, pz] of [[-0.4, 0.35, 0.7], [0.4, 0.35, 0.7], [-0.4, 0.35, -0.7], [0.4, 0.35, -0.7]]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.7, 0.2), legMat);
      leg.position.set(px, py, pz);
      leg.castShadow = true;
      this.group.add(leg);
      const hoof = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.15, 0.22), hoofMat);
      hoof.position.set(px, py - 0.4, pz);
      this.group.add(hoof);
      this.legs.push(leg);
    }

    this.tail = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.7, 6), tailMat);
    this.tail.position.set(0, 1.3, -1.3);
    this.tail.rotation.x = 0.3;
    this.group.add(this.tail);
    const tailTip = new THREE.Mesh(new THREE.SphereGeometry(0.08, 6, 6), tailMat);
    tailTip.position.set(0, -0.35, 0);
    this.tail.add(tailTip);

    for (const [sx, sr, sz] of [[-0.3, 0.12, 0.3], [0.25, 0.1, -0.2]]) {
      const spot = new THREE.Mesh(new THREE.SphereGeometry(sr, 6, 6), spotMat);
      spot.position.set(sx, 1.4, sz);
      spot.scale.y = 0.5;
      this.group.add(spot);
    }
  }

  get y(): number {
    return this.body.translation().y;
  }

  setVelocity(x: number, y: number, z: number) {
    this.body.setLinvel({ x, y, z }, true);
  }

  applyJump(vy: number) {
    const v = this.body.linvel();
    this.body.setLinvel({ x: v.x, y: vy, z: v.z }, true);
  }

  teleport(x: number, y: number, z: number) {
    this.body.setTranslation({ x, y, z }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  }

  resetJumps() {
    this.jumpCount = 0;
  }

  /** Mortal pra trás (tecla R). */
  startFlip() {
    if (this.flipT === 0 && this.flipCD <= 0) {
      this.flipT = 0.001;
    }
  }

  syncMesh() {
    const t = this.body.translation();
    this.group.position.set(t.x, t.y - HALF_H, t.z);
    this.group.rotation.y = this.yaw;
  }
}
