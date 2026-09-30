import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

const MODEL_BASE = 'models/cow';

/** Escala da vaca: 2 = 200% do tamanho original. */
export const COW_SCALE = 2;
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

  constructor(scene: THREE.Scene, world: RAPIER.World, spawnX = 0, spawnZ = 0) {
    this.group = new THREE.Group();
    this.buildMesh();

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

  private async loadModel(): Promise<void> {
    try {
      const loader = new FBXLoader();
      const model = await loader.loadAsync(`${MODEL_BASE}/SK_Cow.fbx`);

      const texLoader = new THREE.TextureLoader();
      const map = await texLoader.loadAsync(`${MODEL_BASE}/T_Cow_B.png`);
      map.colorSpace = THREE.SRGBColorSpace;
      const normalMap = await texLoader.loadAsync(`${MODEL_BASE}/T_Cow_N.png`);
      const roughnessMap = await texLoader.loadAsync(`${MODEL_BASE}/T_Cow_R.png`);
      const mat = new THREE.MeshStandardMaterial({
        map,
        normalMap,
        roughnessMap,
        roughness: 1.0,
        metalness: 0.0,
      });

      model.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.castShadow = true;
          const sm = o as THREE.SkinnedMesh;
          if (sm.isSkinnedMesh) {
            sm.material = mat;
            sm.frustumCulled = false;
          }
        }
      });

      // O FBX ja vem com a frente em +Z (conversao do Unreal); o jogo usa +Z.
// Nao girar: girar aqui faz a vaca andar de lado.
      const inner = new THREE.Group();
      inner.add(model);
      inner.rotation.y = 0;
      inner.updateMatrixWorld(true);

      // Normaliza o tamanho: comprimento horizontal vira 2.3 * escala (bate com o collider).
      const targetLen = 2.3 * COW_SCALE;
      const box = new THREE.Box3().setFromObject(inner);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const longest = Math.max(size.x, size.z);
      const s = longest > 0 ? targetLen / longest : 1;

      const wrap = new THREE.Group();
      wrap.add(inner);
      inner.scale.setScalar(s);
      // Recentraliza no XZ e coloca os pes (min Y) na origem do grupo.
      inner.position.set(-center.x * s, -box.min.y * s, -center.z * s);
      this.group.add(wrap);

      // Esconde a vaca procedural (fallback) agora que o modelo real chegou.
      for (const child of [...this.group.children]) {
        if (child !== wrap) child.visible = false;
      }

      this.mixer = new THREE.AnimationMixer(model);
      await this.loadAnims(loader);
      this.modelReady = true;
      this.playClip('idle', 1);
    } catch (err) {
      console.warn('Modelo FBX da vaca nao carregou, usando procedural:', err);
    }
  }

  private async loadAnims(loader: FBXLoader): Promise<void> {
    const files: Record<string, string> = {
      idle: 'A_Cow_Idle_01.fbx',
      walk: 'A_Cow_Walk_01.fbx',
      run: 'A_Cow_Run_01.fbx',
    };
    for (const [name, file] of Object.entries(files)) {
      try {
        const anim = await loader.loadAsync(`${MODEL_BASE}/${file}`);
        if (anim.animations.length > 0) {
          this.clips[name] = anim.animations[0];
        }
      } catch (err) {
        console.warn(`Animacao ${name} nao carregou:`, err);
      }
    }
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
      this.playClip('idle', 1);
      return;
    }
    if (speed > 6.5) {
      const ts = Math.max(0.8, Math.min(1.5, speed / 8));
      this.playClip('run', ts);
    } else if (speed > 0.8) {
      const ts = Math.max(0.7, Math.min(1.4, speed / 4));
      this.playClip('walk', ts);
    } else {
      this.playClip('idle', 1);
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
