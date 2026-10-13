import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { worldRand } from './rng';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { playSfx, speakComplaint } from './sound';

export type NPCState = 'walk' | 'fallen' | 'stunned' | 'carried' | 'launched' | 'inCannon' | 'levitate';

export interface NPCPhysics {
  id: number;
  mesh: THREE.Group;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  kind: 'normal' | 'business' | 'zane' | 'goat';
  state: NPCState;
  stateTimer: number;
  walkDir: number;
  speed: number;
  /** destino secreto (ninguém vê): anda até lá e sorteia outro */
  tx: number;
  tz: number;
  /** mixer da animação de andar (só walkers; congela se não está andando) */
  mixer?: THREE.AnimationMixer | null;
  /** levitação da bíblia: timer de faísca */
  levT: number;
  /** cooldown de reclamação em voz (0 = pode reclamar) */
  sayT: number;
  /** vendedor da loja (não anda, não pode ser pego nem atacado) */
  vendor?: boolean;
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

  // Caçador (bounty.glb): 1 geometria + 4 tintas compartilhadas (sem cabelo, sem terno)
  private static bountyGeo: THREE.BufferGeometry | null = null;
  private static bountyMats: THREE.Material[] = [];
  private static bountyLoading: Promise<void> | null = null;
  private static fallbackMat: THREE.MeshLambertMaterial | null = null;
  // Zane (zane.fbx): template com esqueleto, clonado por NPC (sem barba/pelos)
  private static zaneTemplate: THREE.Group | null = null;
  private static zaneLoading: Promise<void> | null = null;
  // Walker (walking.fbx): humano com animação de andar, clonado por NPC
  private static walkerTemplate: THREE.Group | null = null;
  private static walkerLoading: Promise<void> | null = null;
  private static walkerClip: THREE.AnimationClip | null = null;
  // 1 material pra TODOS os procedurais (cor vai por vértice) = poucas trocas de estado
  private static sharedVertexMat: THREE.MeshLambertMaterial | null = null;

  create(scene: THREE.Scene, world: RAPIER.World, x: number, z: number, forceKind?: 'normal' | 'business' | 'zane' | 'goat'): NPCPhysics {
    const id = this.idCounter++;
    const shirt = worldRand() < 0.35
      ? new THREE.Color(SUETER_HEX[Math.floor(worldRand() * SUETER_HEX.length)])
      : new THREE.Color(SHIRT_COLORS[Math.floor(worldRand() * SHIRT_COLORS.length)]);
    const skin = new THREE.Color(SKIN_COLORS[Math.floor(worldRand() * SKIN_COLORS.length)]);
    const hair = new THREE.Color(HAIR_COLORS[Math.floor(worldRand() * HAIR_COLORS.length)]);
    const pants = new THREE.Color(PANT_COLORS[Math.floor(worldRand() * PANT_COLORS.length)]);

    // ~20% detalhados (zane raro + caçador), 80% procedural colorido de antes
    const npcKind = forceKind ?? (id % 34 === 1 ? 'zane' : id % 6 === 1 ? 'business' : 'normal');
    // ~1/6 dos normais usa o Walker (continua 'normal': missão do suéter vale)
    const useWalker = npcKind === 'normal' && id % 6 === 3 && NPCFactory.walkerTemplate;
    const mesh = npcKind === 'goat' ? this.buildGoatMesh()
      : npcKind === 'zane' ? this.buildZaneMesh()
      : npcKind === 'business' ? this.buildBountyMesh()
      : useWalker ? this.buildWalkerMesh()
      : this.buildProceduralMesh(shirt, skin, hair, pants);
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
      tx: x, tz: z,
      levT: 0,
      sayT: 0,
      skinSeat: { shirt, skin, hair, pants },
    };
    // walker com animação: mixer próprio, clipe em loop (só anda no 'walk')
    if (useWalker && NPCFactory.walkerClip) {
      const mixer = new THREE.AnimationMixer(mesh);
      mixer.clipAction(NPCFactory.walkerClip).play();
      npc.mixer = mixer;
    } else {
      npc.mixer = null;
    }
    return npc;
  }

  /** Pré-carrega o caçador (chamar antes de criar NPCs). */
  async preload(): Promise<void> {
    if (NPCFactory.bountyGeo || NPCFactory.bountyLoading) {
      if (NPCFactory.bountyLoading) await NPCFactory.bountyLoading;
      return;
    }
    NPCFactory.bountyLoading = this.loadBounty().catch((err) => {
      console.warn('Modelo bounty nao carregou, usando fallback:', err);
    });
    await NPCFactory.bountyLoading;
  }

  private async loadBounty(): Promise<void> {
    const gltf = await new GLTFLoader().loadAsync('models/npc/bounty.glb');
    const parts: { geo: THREE.BufferGeometry; mat: THREE.Material }[] = [];
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || parts.length > 0) return; // 1 mesh só
      const mm = Array.isArray(m.material) ? m.material[0] : m.material;
      parts.push({
        geo: m.geometry.clone().applyMatrix4(m.matrixWorld),
        mat: mm ?? new THREE.MeshStandardMaterial({ color: 0x222222 }),
      });
    });
    if (parts.length === 0) return;
    const geo = parts[0]!.geo;
    const baseMat = parts[0]!.mat;
    // normaliza: altura 2.15, pés em -0.14, centrado (frente +Z, igual ao terno)
    geo.computeBoundingBox();
    const bb = geo.boundingBox!;
    const s = (bb.max.y - bb.min.y) > 0 ? 2.15 / (bb.max.y - bb.min.y) : 1;
    geo.scale(s, s, s);
    geo.computeBoundingBox();
    const b2 = geo.boundingBox!;
    geo.translate(-(b2.min.x + b2.max.x) / 2, -0.14 - b2.min.y, -(b2.min.z + b2.max.z) / 2);
    NPCFactory.bountyGeo = geo;
    const mat = baseMat as THREE.Material;
    // 4 tintas compartilhadas (preto original + coloridos escuros)
    NPCFactory.bountyMats = [0xffffff, 0xff8888, 0x88aaff, 0x88ff88].map((tint) => {
      const c = mat.clone();
      const std = c as THREE.MeshStandardMaterial;
      if (std.color) std.color.setHex(tint);
      return c;
    });
  }

  /** Humanoide = caçador (1 mesh, sem cabelo). Fallback = caixa escura sem cabelo. */
  private buildBountyMesh(): THREE.Group {
    const g = new THREE.Group();
    const geo = NPCFactory.bountyGeo;
    const mats = NPCFactory.bountyMats;
    if (geo && mats.length > 0) {
      const mesh = new THREE.Mesh(geo, mats[Math.floor(worldRand() * mats.length)]!);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      g.add(mesh);
    } else {
      if (!NPCFactory.fallbackMat) {
        NPCFactory.fallbackMat = new THREE.MeshLambertMaterial({ color: 0x222226 });
      }
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.9, 0.35), NPCFactory.fallbackMat);
      m.position.y = 0.81; // pés em -0.14
      g.add(m);
    }
    return g;
  }

  /** Procedural colorido de antes (80% dos NPCs, COM cabelo). */
  private buildProceduralMesh(
    shirt: THREE.Color,
    skin: THREE.Color,
    hair: THREE.Color,
    pants: THREE.Color,
  ): THREE.Group {
    const mesh = this.buildMesh(shirt, skin, hair, pants);
    this.mergeProcedural(mesh);
    return mesh;
  }

  /** Funde as partes procedurais em 1 mesh (cor por vértice, 1 material global). */
  private mergeProcedural(group: THREE.Group): void {
    if (!NPCFactory.sharedVertexMat) {
      NPCFactory.sharedVertexMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    }
    group.updateMatrixWorld(true);
    const geos: THREE.BufferGeometry[] = [];
    group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mat = m.material as THREE.MeshLambertMaterial | undefined;
      const color = mat && mat.color ? mat.color as THREE.Color : new THREE.Color(0xffffff);
      const g = m.geometry.clone().applyMatrix4(m.matrixWorld);
      const pos = g.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (!pos) return;
      const arr = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        arr[i * 3] = color.r;
        arr[i * 3 + 1] = color.g;
        arr[i * 3 + 2] = color.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      geos.push(g);
    });
    for (const child of [...group.children]) group.remove(child);
    if (geos.length === 0) return;
    const merged = mergeGeometries(geos, false);
    if (!merged) {
      console.warn('mergeProcedural falhou, mantendo partes');
      return;
    }
    const mesh = new THREE.Mesh(merged, NPCFactory.sharedVertexMat);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
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

  /** Pré-carrega o Zane (chamar antes de criar NPCs, junto do preload). */
  async preloadZane(): Promise<void> {
    if (NPCFactory.zaneTemplate || NPCFactory.zaneLoading) {
      if (NPCFactory.zaneLoading) await NPCFactory.zaneLoading;
      return;
    }
    NPCFactory.zaneLoading = this.loadZane().catch((err) => {
      console.warn('Modelo zane nao carregou, usando fallback:', err);
    });
    await NPCFactory.zaneLoading;
  }

  /** Zane sem barba/pelos (fora Male_Bushy, Stubble_Neck) e sem língua/dentes
   *  (invisíveis). Mantém SkinnedMesh + esqueleto (as roupas precisam dos ossos);
   *  como nunca anima, cada clone só herda a pose de descanso. (GLB já dizimado.) */
  private async loadZane(): Promise<void> {
    const SKIP = new Set(['Male_Bushy', 'Stubble_Neck', 'CC_Base_Tongue', 'CC_Base_Teeth']);
    const gltf = await new GLTFLoader().loadAsync('models/npc/zane.glb');
    const model = gltf.scene;
    const kill: THREE.Object3D[] = [];
    model.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && SKIP.has(o.name)) kill.push(o);
    });
    for (const k of kill) k.parent?.remove(k);
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh && !(o as THREE.SkinnedMesh).isSkinnedMesh) return;
      // (GLB já vem dizimado do conversor; aqui só ajusta flags)
      m.castShadow = false;
      m.receiveShadow = false;
      m.frustumCulled = false;
    });
    // normaliza via wrapper (ossos intactos): altura 2.15, pés -0.14, centrado.
    // (bbox do FBX é instável, então mede por amostragem de vértices)
    model.updateMatrixWorld(true);
    let minX = 1e9, minY = 1e9, minZ = 1e9, maxX = -1e9, maxY = -1e9, maxZ = -1e9;
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (!pos) return;
      const me = m.matrixWorld.elements;
      for (let i = 0; i < pos.count; i += 8) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const wx = me[0]! * x + me[4]! * y + me[8]! * z + me[12]!;
        const wy = me[1]! * x + me[5]! * y + me[9]! * z + me[13]!;
        const wz = me[2]! * x + me[6]! * y + me[10]! * z + me[14]!;
        if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
        if (wy < minY) minY = wy; if (wy > maxY) maxY = wy;
        if (wz < minZ) minZ = wz; if (wz > maxZ) maxZ = wz;
      }
    });
    const h = maxY - minY;
    const s = h > 0 ? 2.15 / h : 1;
    const wrap = new THREE.Group();
    wrap.add(model);
    wrap.scale.setScalar(s);
    wrap.position.set(-((minX + maxX) / 2) * s, -0.14 - minY * s, -((minZ + maxZ) / 2) * s);
    wrap.updateMatrixWorld(true);
    NPCFactory.zaneTemplate = wrap;
  }

  /** Pré-carrega o Walker (chamar antes de criar NPCs, junto do preload). */
  async preloadWalker(): Promise<void> {
    if (NPCFactory.walkerTemplate || NPCFactory.walkerLoading) {
      if (NPCFactory.walkerLoading) await NPCFactory.walkerLoading;
      return;
    }
    NPCFactory.walkerLoading = this.loadWalker().catch((err) => {
      console.warn('Modelo walker nao carregou, usando fallback:', err);
    });
    await NPCFactory.walkerLoading;
  }

  /** Walker: normaliza via wrapper (altura 1.8, pés -0.14, centrado).
   *  Pose de descanso do primeiro frame (sem mixer: 50+ mixers pesaria). */
  private async loadWalker(): Promise<void> {
    const model = await new FBXLoader().loadAsync('models/npc/walking.fbx');
    let meshes = 0;
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh && !(o as THREE.SkinnedMesh).isSkinnedMesh) return;
      meshes++;
      m.castShadow = false;
      m.receiveShadow = false;
      m.frustumCulled = false;
      // FBX vem com transparent=true (vira fantasma): sólido de verdade
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mm of mats) {
        if (mm && (mm as THREE.Material).transparent) {
          (mm as THREE.Material).transparent = false;
          mm.needsUpdate = true;
        }
      }
    });
    model.updateMatrixWorld(true);
    let minX = 1e9, minY = 1e9, minZ = 1e9, maxX = -1e9, maxY = -1e9, maxZ = -1e9;
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (!pos) return;
      const me = m.matrixWorld.elements;
      for (let i = 0; i < pos.count; i += 8) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const wx = me[0]! * x + me[4]! * y + me[8]! * z + me[12]!;
        const wy = me[1]! * x + me[5]! * y + me[9]! * z + me[13]!;
        const wz = me[2]! * x + me[6]! * y + me[10]! * z + me[14]!;
        if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
        if (wy < minY) minY = wy; if (wy > maxY) maxY = wy;
        if (wz < minZ) minZ = wz; if (wz > maxZ) maxZ = wz;
      }
    });
    const h = maxY - minY;
    const s = h > 0 ? 1.8 / h : 1;
    const wrap = new THREE.Group();
    wrap.add(model);
    wrap.scale.setScalar(s);
    wrap.position.set(-((minX + maxX) / 2) * s, -0.14 - minY * s, -((minZ + maxZ) / 2) * s);
    wrap.updateMatrixWorld(true);
    const clips = model.animations ?? [];
    NPCFactory.walkerClip = clips.length > 0 ? clips[0]! : null;
    console.log(`[npc] walker: ${meshes} meshes, altura ${(h * s).toFixed(2)}m, anims=${clips.map((c) => `${c.name}:${c.duration.toFixed(2)}s`).join(',') || 'nenhuma'}`);
    NPCFactory.walkerTemplate = wrap;
  }

  /** Walker (clone com esqueleto próprio). Fallback = procedural. */
  private buildWalkerMesh(): THREE.Group {
    const tpl = NPCFactory.walkerTemplate;
    if (tpl) return cloneSkinned(tpl) as THREE.Group;
    return this.buildProceduralMesh(new THREE.Color(0x3264c8), new THREE.Color(0xffdcba),
      new THREE.Color(0x191919), new THREE.Color(0x2d2d8c));
  }

  /** Zane (clone com esqueleto próprio, sem cabelo). Fallback = caixa escura. */
  private buildZaneMesh(): THREE.Group {
    const tpl = NPCFactory.zaneTemplate;
    if (tpl) return cloneSkinned(tpl) as THREE.Group;
    const g = new THREE.Group();
    if (!NPCFactory.fallbackMat) {
      NPCFactory.fallbackMat = new THREE.MeshLambertMaterial({ color: 0x222226 });
    }
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.9, 0.35), NPCFactory.fallbackMat);
    m.position.y = 0.81;
    g.add(m);
    return g;
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

  /** Reclamações ao levar porrada da vaca (estilo Goat Simulator). */
  private static readonly COMPLAINTS = [
    'GO AWAY YOU FRICKING COW!!!!!!!',
    'HEY! WATCH IT!',
    'OW! MY EVERYTHING!',
    'I WAS JUST WALKING HERE!',
    'RUDE!!',
    'I PAY TAXES, YOU KNOW!',
    'WHY ALWAYS ME?!',
    'NOT AGAIN!!!',
    'SOMEBODY CALL SECURITY!',
    'MY LAWYER WILL HEAR ABOUT THIS!',
    'DO YOU MIND?!',
    'I HAVE A FAMILY!',
    "I'M TELLING MOM!",
    'COWS SAY MOO, NOT SORRY?!',
  ];

  /** NPC reclama EM VOZ ALTA (sem texto). Com cooldown por NPC + trava global
   *  de 1 fala por vez (senão 350 NPCs viram coral). */
  complain(npc: NPCPhysics, line?: string): void {
    if (npc.sayT > 0) return;
    // bode não fala inglês: bale
    if (npc.kind === 'goat') {
      playSfx('baa');
      npc.sayT = 4;
      return;
    }
    let text = line;
    if (!text) {
      const last = npc.mesh.userData['sayLast'] as string | undefined;
      let pick = NPCFactory.COMPLAINTS[Math.floor(Math.random() * NPCFactory.COMPLAINTS.length)]!;
      if (pick === last) {
        pick = NPCFactory.COMPLAINTS[(NPCFactory.COMPLAINTS.indexOf(pick) + 1) % NPCFactory.COMPLAINTS.length]!;
      }
      text = pick;
      npc.mesh.userData['sayLast'] = text;
    }
    speakComplaint(text);
    npc.sayT = 4;
  }

  /** Desconta o cooldown de fala. */
  tickSay(npc: NPCPhysics, dt: number): void {
    if (npc.sayT > 0) npc.sayT = Math.max(0, npc.sayT - dt);
  }

  /** Avança a animação de andar (só andando; segurado/caído congela). */
  tickAnim(npc: NPCPhysics, dt: number): void {
    if (npc.mixer && npc.state === 'walk') npc.mixer.update(dt);
  }

  syncMesh(npc: NPCPhysics) {
    const t = npc.body.translation();
    npc.mesh.position.set(t.x, t.y - 0.72, t.z);
    if (npc.state === 'walk') {
      // olha pra onde está INDO (não pro destino): sem andar de lado
      const v = npc.body.linvel();
      if (Math.hypot(v.x, v.z) > 0.5) npc.mesh.rotation.y = Math.atan2(v.x, v.z);
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