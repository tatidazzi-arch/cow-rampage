import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { worldRand } from './rng';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';

export type NPCState = 'walk' | 'fallen' | 'stunned' | 'carried' | 'launched' | 'inCannon';

export interface NPCPhysics {
  id: number;
  mesh: THREE.Group;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  kind: 'normal' | 'business' | 'goat';
  state: NPCState;
  stateTimer: number;
  walkDir: number;
  speed: number;
  skinSeat: {
    shirt: THREE.Color;
    skin: THREE.Color;
    hair: THREE.Color;
    pants: THREE.Color;
  };
}

const SHIRT_COLORS = [0xc83232, 0x3264c8, 0x32b432, 0xc8c832, 0xb432b4, 0x32c8c8, 0xff8c2d, 0x6432c8, 0xff5555, 0x55ff55, 0x21a0a0, 0xb3452d];
const SKIN_COLORS = [0xffdcba, 0xf0c8a5, 0xdcb996, 0xc8aa8c, 0xffeedd];
const HAIR_COLORS = [0x372310, 0x914b23, 0x191919, 0xc3914b, 0x8b0000, 0x2f1f0f, 0x5c3a1e, 0x221a0f, 0xffd699, 0x9b6bf0, 0xe8c878, 0xc46a3d, 0xd94f70];
const PANT_COLORS = [0x2d2d8c, 0x1a1a4d, 0x3d3d2d, 0x2d1a1a, 0x4a3a2a, 0x1d3557, 0x2e3b2e];

// Sueter: cores quentinhas (35% dos NPCs normais usam)
export const SUETER_HEX = [0xc8c832, 0xff8c2d, 0xb3452d, 0xb432b4];

export function isSweater(npc: NPCPhysics): boolean {
  return npc.kind === 'normal' && SUETER_HEX.includes(npc.skinSeat.shirt.getHex());
}

export class NPCFactory {
  private idCounter = 1;

  // Modelo "business" (FBX): template clonado para 1/4 dos NPCs
  private businessTemplate: THREE.Group | null = null;
  private businessLoading: Promise<void> | null = null;
  readonly businessInfo = { loaded: false, facing: '?', postFacing: '?' };

  create(scene: THREE.Scene, world: RAPIER.World, x: number, z: number, forceKind?: 'normal' | 'business' | 'goat'): NPCPhysics {
    const id = this.idCounter++;
    const shirt = worldRand() < 0.35
      ? new THREE.Color(SUETER_HEX[Math.floor(worldRand() * SUETER_HEX.length)])
      : new THREE.Color(SHIRT_COLORS[Math.floor(worldRand() * SHIRT_COLORS.length)]);
    const skin = new THREE.Color(SKIN_COLORS[Math.floor(worldRand() * SKIN_COLORS.length)]);
    const hair = new THREE.Color(HAIR_COLORS[Math.floor(worldRand() * HAIR_COLORS.length)]);
    const pants = new THREE.Color(PANT_COLORS[Math.floor(worldRand() * PANT_COLORS.length)]);

    const npcKind = forceKind ?? (id % 4 === 1 ? 'business' : 'normal');
    const mesh = npcKind === 'goat' ? this.buildGoatMesh() : this.buildMesh(shirt, skin, hair, pants);
    mesh.position.set(x, 0, z);
    scene.add(mesh);

    // Marcador dourado ▼ sobre homens de sueter (só normais; terno não conta)
    if (npcKind === 'normal' && SUETER_HEX.includes(shirt.getHex())) {
      const marker = new THREE.Mesh(
        new THREE.ConeGeometry(0.16, 0.4, 4),
        new THREE.MeshBasicMaterial({ color: 0xffcc00 }),
      );
      marker.rotation.x = Math.PI;
      marker.position.set(0, 2.75, 0);
      marker.visible = false;
      mesh.add(marker);
      mesh.userData['sweaterMarker'] = marker;
    }

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, 1.0, z)
      .setCanSleep(false)
      .setLinearDamping(0.5)
      .setAngularDamping(1.0)
      .lockRotations();
    const body = world.createRigidBody(bodyDesc);
    // altura total 1.72 (fundo bate nos pes) e raio cobre os bracos
    const colliderDesc = RAPIER.ColliderDesc.capsule(0.41, 0.45);
    const collider = world.createCollider(colliderDesc, body);

    const npc: NPCPhysics = {
      id,
      mesh, body, collider,
      kind: npcKind,
      state: 'walk', stateTimer: 0,
      walkDir: worldRand() > 0.5 ? 1 : -1,
      speed: 1.5 + worldRand() * 3,
      skinSeat: { shirt, skin, hair, pants },
    };
    if (npc.kind === 'business') this.ensureBusiness(npc);
    return npc;
  }

  /** Garante UMA carga do FBX business; quem chamar recebe o swap quando pronto. */
  private ensureBusiness(npc: NPCPhysics): void {
    if (this.businessTemplate) {
      this.applyBusiness(npc);
      return;
    }
    if (!this.businessLoading) {
      this.businessLoading = this.loadBusiness().catch((err) => {
        console.warn('Modelo business nao carregou, usando procedural:', err);
      });
    }
    void this.businessLoading.then(() => this.applyBusiness(npc));
  }

  private async loadBusiness(): Promise<void> {
    // OBJ (o FBX do pack e versao 6.1, que o Three nao le) + texturas do proprio pack
    const loader = new OBJLoader();
    const model = await loader.loadAsync('models/npc/Humano_01Business_01_30K.obj');

    const texLoader = new THREE.TextureLoader();
    const map = await texLoader.loadAsync('models/npc/Humano_01Business_01_Diffuse01.jpg');
    map.colorSpace = THREE.SRGBColorSpace;
    const normalMap = await texLoader.loadAsync('models/npc/Humano_01Business_01_Normal.jpg');
    const mat = new THREE.MeshStandardMaterial({
      map,
      normalMap,
      roughness: 0.85,
      metalness: 0.0,
    });
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.material = mat;
      }
    });

    // descobre a frente nativa (nariz = lado mais saliente na altura da cabeca)
    const native = this.measureFacing(model);
    this.businessInfo.facing = native;
    const yawMap: Record<string, number> = {
      '+Z': 0, '-Z': Math.PI, '+X': -Math.PI / 2, '-X': Math.PI / 2,
    };
    const inner = new THREE.Group();
    inner.add(model);
    inner.rotation.y = yawMap[native] ?? 0;
    inner.updateMatrixWorld(true);

    // normaliza: altura 2.15, pes em local -0.14 (igual ao procedural), centralizado
    const box = new THREE.Box3().setFromObject(inner);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const s = size.y > 0 ? 2.15 / size.y : 1;
    const wrap = new THREE.Group();
    wrap.add(inner);
    inner.scale.setScalar(s);
    inner.position.set(-center.x * s, -0.14 - box.min.y * s, -center.z * s);

    wrap.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.castShadow = true;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        const std = mat as THREE.MeshStandardMaterial;
        if (std.map) std.map.colorSpace = THREE.SRGBColorSpace;
      }
    });

    wrap.updateMatrixWorld(true);
    // peruca anti-calvície no terninho: mede o topo da cabeça e cobre
    {
      const v = new THREE.Vector3();
      let cx = 0, cz = 0, n = 0, top = -Infinity;
      wrap.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
        if (!pos) return;
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
          if (v.y < 1.7) continue;
          cx += v.x; cz += v.z; n++;
          if (v.y > top) top = v.y;
        }
      });
      if (n > 0) {
        cx /= n; cz /= n;
        let rr = 0.2;
        wrap.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
          if (!pos) return;
          for (let i = 0; i < pos.count; i++) {
            v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
            if (v.y < 1.7) continue;
            rr = Math.max(rr, Math.hypot(v.x - cx, v.z - cz));
          }
        });
        const wig = new THREE.Mesh(new THREE.SphereGeometry(rr * 1.25, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55),
          new THREE.MeshLambertMaterial({ color: 0x3a2a1a }));
        wig.position.set(cx, top - rr * 0.5, cz);
        wig.scale.y = 0.85;
        wrap.add(wig);
      }
    }
    this.businessTemplate = wrap;
    this.businessInfo.loaded = true;
    this.businessInfo.postFacing = this.measureFacing(wrap);
  }

  /** Mede para onde o modelo olha: lado do nariz na altura da cabeca. */
  private measureFacing(root: THREE.Object3D): string {
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    if (size.y <= 0) return '+Z';
    const alongX = size.z > size.x * 1.15;
    const headY = box.min.y + (box.max.y - box.min.y) * 0.82;
    const v = new THREE.Vector3();
    let min = Infinity, max = -Infinity, sum = 0, count = 0;
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (!pos) return;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
        if (v.y < headY) continue;
        const c = alongX ? v.x : v.z;
        if (c < min) min = c;
        if (c > max) max = c;
        sum += c;
        count++;
      }
    });
    if (count === 0) return '+Z';
    const c = sum / count;
    const sign = max - c >= c - min ? '+' : '-';
    return sign + (alongX ? 'X' : 'Z');
  }

  /** Troca o procedural pelo clone do business (mantem o Group = fisica/sync intactos). */
  private applyBusiness(npc: NPCPhysics): void {
    if (!this.businessTemplate || npc.kind !== 'business') return;
    if (npc.mesh.userData['isBusiness']) return;
    for (const child of [...npc.mesh.children]) {
      npc.mesh.remove(child);
    }
    npc.mesh.add(this.businessTemplate.clone(true));
    npc.mesh.userData['isBusiness'] = true;
  }

  /** Bode da cidade das cabras: pes em local -0.14, frente +Z (igual ao humanoide). */
  private buildGoatMesh(): THREE.Group {
    const g = new THREE.Group();
    const furMat = new THREE.MeshLambertMaterial({ color: 0xf2f2f2 });
    const darkMat = new THREE.MeshLambertMaterial({ color: 0x8a7a66 });
    const hornMat = new THREE.MeshLambertMaterial({ color: 0xd8cbaa });

    const bodyM = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.55, 1.1), furMat);
    bodyM.position.y = 0.42;
    bodyM.castShadow = true;
    g.add(bodyM);
    const patch = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.3, 0.5), darkMat);
    patch.position.set(0, 0.5, -0.15);
    g.add(patch);

    for (const [lx, lz] of [[-0.28, 0.35], [0.28, 0.35], [-0.28, -0.35], [0.28, -0.35]]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.06, 0.5, 6), darkMat);
      leg.position.set(lx, 0.11, lz);
      g.add(leg);
    }

    const head = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.38, 0.42), furMat);
    head.position.set(0, 0.82, 0.68);
    head.castShadow = true;
    g.add(head);
    const snout = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.2, 0.22), darkMat);
    snout.position.set(0, 0.74, 0.95);
    g.add(snout);
    for (const s of [-0.12, 0.12]) {
      const horn = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.28, 6), hornMat);
      horn.position.set(s, 1.1, 0.6);
      horn.rotation.x = -0.4;
      g.add(horn);
      const ear = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.06, 0.1), furMat);
      ear.position.set(s * 1.8, 0.9, 0.62);
      g.add(ear);
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.045, 6, 6), new THREE.MeshLambertMaterial({ color: 0x111111 }));
      eye.position.set(s, 0.86, 0.88);
      g.add(eye);
    }
    const beard = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.2, 6), darkMat);
    beard.position.set(0, 0.58, 0.85);
    beard.rotation.x = Math.PI;
    g.add(beard);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.25), furMat);
    tail.position.set(0, 0.6, -0.62);
    tail.rotation.x = -0.5;
    g.add(tail);

    return g;
  }

  private buildMesh(
    shirt: THREE.Color,
    skin: THREE.Color,
    hair: THREE.Color,
    pants: THREE.Color,
  ): THREE.Group {
    const g = new THREE.Group();

    const shirtMat = new THREE.MeshLambertMaterial({ color: shirt });
    const skinMat = new THREE.MeshLambertMaterial({ color: skin });
    const pantsMat = new THREE.MeshLambertMaterial({ color: pants });
    const hairMat = new THREE.MeshLambertMaterial({ color: hair });

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.34, 14, 12), skinMat);
    head.position.y = 1.85;
    head.castShadow = true;
    g.add(head);

    for (const s of [-0.12, 0.12]) {
      const eyeW = new THREE.Mesh(new THREE.SphereGeometry(0.065, 8, 8), new THREE.MeshLambertMaterial({ color: 0xffffff }));
      eyeW.position.set(s, 1.91, 0.31);
      g.add(eyeW);
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 8), new THREE.MeshLambertMaterial({ color: 0x111111 }));
      pupil.position.set(s, 1.91, 0.37);
      g.add(pupil);
    }
    const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.035, 0.02), new THREE.MeshLambertMaterial({ color: 0xb04a4a }));
    mouth.position.set(0, 1.71, 0.33);
    g.add(mouth);
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 6), skinMat);
    nose.position.set(0, 1.79, 0.38);
    g.add(nose);

    // --- CABELO (grande e visível de longe!) ---
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.44, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.6), hairMat);
    cap.position.y = 1.95;
    cap.scale.set(1, 0.95, 1);
    g.add(cap);
    for (const s of [-0.28, 0.28]) {
      const strand = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.75, 0.1), hairMat);
      strand.position.set(s, 1.35, -0.2);
      g.add(strand);
    }
    const fringe = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.18, 0.08), hairMat);
    fringe.position.set(0, 2.0, 0.32);
    g.add(fringe);

    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.11, 0.2, 8), skinMat);
    neck.position.y = 1.55;
    g.add(neck);

    const body = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.8, 0.35), shirtMat);
    body.position.y = 1.1;
    body.castShadow = true;
    g.add(body);

    const belt = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.08, 0.37), new THREE.MeshLambertMaterial({ color: 0x3a2a1a }));
    belt.position.y = 0.7;
    g.add(belt);
    const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.06, 0.04), new THREE.MeshLambertMaterial({ color: 0xccaa44 }));
    buckle.position.set(0, 0.7, 0.2);
    g.add(buckle);

    const pantsMesh = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.55, 0.33), pantsMat);
    pantsMesh.position.y = 0.38;
    g.add(pantsMesh);

    for (const s of [-0.38, 0.38]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.6, 0.14), shirtMat);
      arm.position.set(s, 1.0, 0);
      g.add(arm);
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.075, 6, 6), skinMat);
      hand.position.set(s, 0.65, 0);
      g.add(hand);
      const sleeve = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.14, 0.16), shirtMat);
      sleeve.position.set(s, 1.35, 0);
      g.add(sleeve);
    }

    g.userData.legs = [];
    for (const s of [-0.14, 0.14]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.55, 0.16), pantsMat);
      leg.position.set(s, 0.15, 0);
      g.add(leg);
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.12, 0.24), new THREE.MeshLambertMaterial({ color: 0x1a1a1a }));
      shoe.position.set(s, -0.08, 0.03);
      g.add(shoe);
      g.userData.legs.push(leg);
    }

    return g;
  }

  syncMesh(npc: NPCPhysics) {
    const t = npc.body.translation();
    npc.mesh.position.set(t.x, t.y - 0.72, t.z);
    if (npc.state === 'walk') {
      npc.mesh.rotation.y = npc.walkDir > 0 ? 0 : Math.PI;
    }
  }

  applyForce(npc: NPCPhysics, x: number, y: number, z: number) {
    npc.body.applyImpulse({ x, y, z }, true);
  }

  setState(npc: NPCPhysics, state: NPCState, timer = 0) {
    npc.state = state;
    npc.stateTimer = timer;
  }
}