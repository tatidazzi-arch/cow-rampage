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
  private world: RAPIER.World;
  private collider: RAPIER.Collider;
  legs: THREE.Mesh[] = [];
  head!: THREE.Mesh;
  tail!: THREE.Mesh;
  yaw = 0;
  grounded = true;
  jumpCount = 0;
  maxJumps = 5;
  flipT = 0;
  private flipCD = 0;

  // --- De barriga pra cima (queda de muito alto) ---
  /** > 0 = caída de barriga pra cima (segundos restantes) */
  bellyUpT = 0;
  /** > 0 = atordoada (chute!): desliza sem controle nem freio */
  stunT = 0;
  private readonly bellyTotal = 2.2;
  private bellyPhase = 0;
  private bellyAngle = 0;
  /** altura visual do modelo (medida no load; cai pro padrão se falhar) */
  private modelTop = 2.2 * 2;

  // Modelo FBX (carregado de forma assincrona; procedural fica de fallback)
  modelReady = false;
  private mixer: THREE.AnimationMixer | null = null;
  private clips: Record<string, THREE.AnimationClip> = {};
  private currentClip = '';
  private skin: Skin = { id: 'comum', name: '', price: 0, tint: 0xffffff };

  constructor(scene: THREE.Scene, world: RAPIER.World, spawnX = 0, spawnZ = 0) {
    this.world = world;
    this.group = new THREE.Group();
    this.buildMesh();
    this.buildGadgets();

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawnX, HALF_H + 1.0, spawnZ)
      .setCanSleep(false)
      .setLinearDamping(0.5)
      .lockRotations();
    this.body = world.createRigidBody(bodyDesc);
    // Box no tamanho real da vaca 2x (provisório: vira hull do modelo no load)
    // Box arredondado no tamanho real: desliza nos cantos em vez de enganchar
    const colliderDesc = RAPIER.ColliderDesc.roundCuboid(0.4, HALF_H - 0.3, 1.15 * COW_SCALE - 0.3, 0.3);
    this.collider = world.createCollider(colliderDesc, this.body);

    scene.add(this.group);

    void this.loadModel();
  }

  /** Aparelhos das costas: sela, jetpack de bomba atômica e bíblia. */
  private gadgets: Record<string, THREE.Group> = {};
  private flame: THREE.Mesh | null = null;
  /** Sela: grupo, prontidão e o osso da coluna que ela segue. */
  private saddleGroup: THREE.Group | null = null;
  /** Pose de queda (fall.glb, estática) — aparece enquanto a vaca cai. */
  private fallMesh: THREE.Mesh | null = null;
  private fallMat: THREE.MeshLambertMaterial | null = null;
  private fallSaddlePos = new THREE.Vector3();
  private fallSaddleRot = new THREE.Quaternion();
  private modelMesh: THREE.Object3D | null = null;
  /** Maior dimensão do modelo da vaca (pra pose de queda ter o mesmo tamanho). */
  private modelMaxDim = 0;
  private modelRoot: THREE.Object3D | null = null;
  private saddleReady = false;
  private saddleBone: THREE.Bone | null = null;
  private saddleBase = new THREE.Vector3();
  private saddleBoneBase = new THREE.Vector3();

  private buildGadgets(): void {
    // sela: manta no dorso
    const saddle = new THREE.Group();
    const blanket = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 0.2, 2.2),
      new THREE.MeshLambertMaterial({ color: 0x8a4a2a }),
    );
    blanket.position.set(0, 3.3, -0.2);
    saddle.add(blanket);
    // jetpack: bomba atômica de verdade (nuke.obj) + faixas vermelhas
    const pack = new THREE.Group();
    const tubeMat = new THREE.MeshLambertMaterial({ color: 0x555560 });
    const bandMat = new THREE.MeshLambertMaterial({ color: 0xcc2222 });
    const tubes: THREE.Mesh[] = [];
    for (const s of [-0.55, 0.55]) {
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 1.3, 10), tubeMat);
      tube.position.set(s, 3.7, -1.4);
      tube.castShadow = true;
      pack.add(tube);
      tubes.push(tube);
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.37, 0.37, 0.2, 10), bandMat);
      band.position.set(s, 3.9, -1.4);
      pack.add(band);
      tubes.push(band);
    }
    const flame = new THREE.Mesh(
      new THREE.ConeGeometry(0.5, 1.4, 8),
      new THREE.MeshBasicMaterial({ color: 0xff8830 }),
    );
    flame.position.set(0, 2.0, -1.2);
    // escapamento pra TRÁS (foguete empurra pra frente)
    flame.rotation.x = -Math.PI / 2 - 0.35;
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
    this.saddleGroup = saddle;
    for (const [id, g] of Object.entries(this.gadgets)) {
      g.visible = id === 'sela';
      this.group.add(g);
    }
    // carrega a bomba de verdade e troca os cilindros (fallback fica se falhar)
    void this.loadNuke(pack, tubes);
    // sela de couro de verdade no lugar da manta (fallback fica se falhar)
    void this.loadSaddle(saddle, blanket);
  }

  /** Sela de couro (saddle.glb, 0.9MB) no lugar da manta. */
  private async loadSaddle(saddle: THREE.Group, fallback: THREE.Mesh): Promise<void> {
    try {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const gltf = await new GLTFLoader().loadAsync('models/cow/saddle/saddle.glb');
      const model = gltf.scene;
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      // eixo comprido ao longo da espinha (+Z)
      const inner = new THREE.Group();
      inner.add(model);
      // o modelo vem com o POMO (frente da sela) virado pra trás: gira 180°
      inner.rotation.y = Math.PI;
      // o GLB otimizado veio sem textura: retexturiza com o couro (leve)
      {
        const loader = new THREE.TextureLoader();
        const leather = loader.load('models/cow/saddle/leather.jpg');
        leather.colorSpace = THREE.SRGBColorSpace;
        const leatherN = loader.load('models/cow/saddle/leather_n.jpg');
        model.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          for (const mm of mats) {
            const mat = mm as THREE.MeshStandardMaterial;
            if (!mat || !('map' in mat)) continue;
            mat.map = leather;
            if ('normalMap' in mat) mat.normalMap = leatherN;
            mat.needsUpdate = true;
          }
        });
      }
      const longest = Math.max(size.x, size.z);
      // modelo do Tripo vem gigante: 55% do tamanho (sela ~1.2m, não 2.2m)
      const s = longest > 0 ? (2.2 / longest) * 0.55 : 1;
      inner.scale.setScalar(s);
      // recentraliza DEPOIS de girar (girar 180° espelha x/z: se centralizar
      // antes, a sela sai do lugar)
      inner.updateMatrixWorld(true);
      const rotBox = new THREE.Box3().setFromObject(inner);
      const rc = rotBox.getCenter(new THREE.Vector3());
      inner.position.set(-rc.x, 0, -rc.z);
      inner.updateMatrixWorld(true);
      inner.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.castShadow = true;
      });
      const bb = new THREE.Box3().setFromObject(inner);
      // assenta o TERÇO de baixo no dorso (estribos pendem pros lados da
      // barriga; alinhar pelo mínimo flutua a sela por causa das correias)
      const third = bb.min.y + (bb.max.y - bb.min.y) * 0.3;
      inner.position.y = 1.5 - third;
      inner.position.z += 0; // a posição no dorso é calculada pela geometria
      // almofada do assento (o couro do modelo vem com o assento aberto: via
      // e aparece um buraco no meio da sela) — mesmo material do couro
      {
        inner.updateMatrixWorld(true);
        const cbb = new THREE.Box3().setFromObject(inner);
        const leatherMap = (() => {
          let m: THREE.Texture | null = null;
          model.traverse((o) => {
            const mm = o as THREE.Mesh;
            if (m || !mm.isMesh) return;
            const mats = Array.isArray(mm.material) ? mm.material : [mm.material];
            for (const x of mats) {
              const mat = x as THREE.MeshStandardMaterial;
              if (mat && mat.map) { m = mat.map; break; }
            }
          });
          return m;
        })();
        const cushion = new THREE.Mesh(
          new THREE.SphereGeometry(1, 16, 12),
          new THREE.MeshLambertMaterial({ color: 0xb59a7a, map: leatherMap ?? undefined }),
        );
        // converte o topo do couro (mundo) pro espaço local do inner (com escala)
        // assento: mais abaixo do topo (o topo é a crista/amarra do couro)
        const seatY = cbb.min.y + (cbb.max.y - cbb.min.y) * 0.62;
        const top = inner.worldToLocal(new THREE.Vector3(0, seatY, 0));
        cushion.position.copy(top);
        const span = inner.worldToLocal(new THREE.Vector3(0, cbb.max.y, 0.3)).distanceTo(top);
        const wide = inner.worldToLocal(new THREE.Vector3(0.35, cbb.max.y, 0)).distanceTo(top);
        cushion.scale.set(Math.max(0.12, wide * 0.7), Math.max(0.05, span * 0.35), Math.max(0.12, span * 0.8));
        inner.add(cushion);
      }
      saddle.add(inner);
      fallback.visible = false;
      this.saddleReady = true;
      // se a vaca real já carregou, prende a sela no osso da coluna agora
      if (this.modelRoot) this.attachSaddleToSpine();
      console.log(`[sela] couro carregado: ${(size.x * s).toFixed(1)}x${(size.y * s).toFixed(1)}x${(size.z * s).toFixed(1)}m`);
    } catch (err) {
      console.warn('Sela de couro nao carregou, mantendo manta:', err);
    }
  }

  /** A sela segue o osso da coluna: sobe/desce com a animação (idle, caminhada,
   *  corrida) sem inclinar e sem girar ao redor do osso (ficava torta).
   *  A posição é calculada pela GEOMETRIA (45% do dorso, da garupa pro focinho),
   *  não pelo osso — senão caía na cernelha. */
  private attachSaddleToSpine(): void {
    const saddle = this.saddleGroup;
    const root = this.modelRoot;
    if (!saddle || !root || this.saddleBone) return;
    root.updateMatrixWorld(true);
    this.group.updateMatrixWorld(true);
    // pontas do corpo pelos OSSOS (cauda -> focinho): o bbox do modelo engana
    // (as patas de trás esticam o z mínimo e jogam a sela pro lado errado)
    let tailZ = 1e9, noseZ = -1e9;
    const bv = new THREE.Vector3();
    root.traverse((o) => {
      const b = o as THREE.Bone;
      if (!b.isBone) return;
      bv.set(0, 0, 0).applyMatrix4(b.matrixWorld);
      const lz = this.group.worldToLocal(bv).z;
      if (lz < tailZ) tailZ = lz;
      if (lz > noseZ) noseZ = lz;
    });
    if (tailZ > noseZ) { tailZ = -1; noseZ = 1; }
    const targetZ = tailZ + (noseZ - tailZ) * 0.45;
    // osso de coluna mais próximo do ponto certo
    const cands: { b: THREE.Bone; d: number; y: number }[] = [];
    root.traverse((o) => {
      const b = o as THREE.Bone;
      if (!b.isBone) return;
      if (!/spine|chest|back/i.test(b.name)) return;
      const l = this.group.worldToLocal(b.getWorldPosition(new THREE.Vector3()));
      cands.push({ b, d: Math.abs(l.z - targetZ), y: l.y });
    });
    if (cands.length === 0) {
      console.log('[sela] sem osso de coluna: sela fica solta');
      return;
    }
    cands.sort((a, c) => a.d - c.d);
    const bone = cands[0]!.b;
    const boneLocal = this.group.worldToLocal(bone.getWorldPosition(new THREE.Vector3()));
    void boneLocal;
    // sela no ponto certo do dorso (a altura vem do couro, já posicionado)
    saddle.position.set(0, 0, targetZ);
    this.saddleBone = bone;
    this.saddleBase.copy(saddle.position);
    this.saddleBoneBase.copy(root.worldToLocal(bone.getWorldPosition(new THREE.Vector3())));
    console.log(`[sela] no dorso (z=${targetZ.toFixed(2)}) seguindo ${bone.name}`);
  }

  /** Aplica o deslocamento do osso na sela (a cada frame). */
  private updateSaddleFollow(): void {
    const saddle = this.saddleGroup;
    const root = this.modelRoot;
    const bone = this.saddleBone;
    if (!saddle || !root || !bone) return;
    bone.updateWorldMatrix(true, false);
    const now = root.worldToLocal(bone.getWorldPosition(new THREE.Vector3()));
    saddle.position.copy(this.saddleBase).add(now.sub(this.saddleBoneBase));
  }

  /** Bomba atômica do pack do usuário no lugar dos cilindros. */
  private async loadNuke(pack: THREE.Group, fallback: THREE.Mesh[]): Promise<void> {
    try {
      const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js');
      const model = await new OBJLoader().loadAsync('models/nuke/nuke.obj');
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const longest = Math.max(size.x, size.y, size.z);
      const s = longest > 0 ? 2.0 / longest : 1;
      const gunmetal = new THREE.MeshLambertMaterial({ color: 0x3a3f45 });
      const inner = new THREE.Group();
      inner.add(model);
      inner.scale.setScalar(s);
      inner.position.set(-center.x * s, -center.y * s, -center.z * s);
      inner.updateMatrixWorld(true);
      inner.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.material = gunmetal;
          m.castShadow = true;
        }
      });
      const wrap = new THREE.Group();
      wrap.add(inner);
      // deitada no dorso (eixo comprido ao longo da espinha, ~2m)
      wrap.position.set(0, 0, 0);
      // mede no referencial LOCAL (sem pai): setFromObject usa o MUNDO, então
      // medir depois do pack.add misturava a altura da vaca no offset e a bomba
      // afundava ~1m (ficava embaixo do dorso)
      wrap.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(wrap);
      // dorso quase plano em 1.95-2.01 no trecho da bomba: base encostando.
      // centro deslocado pra frente: nariz perto da cabeça
      const baseY = 1.95;
      const bombZ = 0.2;
      wrap.position.set(0, baseY - bb.min.y, bombZ);
      pack.add(wrap);
      for (const t of fallback) t.visible = false;
    } catch (err) {
      console.warn('Bomba nao carregou, usando cilindros:', err);
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
      this.modelRoot = wrap;
      // hitbox = a própria vaca (convex hull do modelo em pose de descanso;
      // trimesh não vale em corpo dinâmico, hull é o equivalente válido)
      this.swapToHull(spawned.model);

      // Esconde a vaca procedural (fallback) agora que o modelo real chegou.
      // (a sela NÃO entra: ela é presa no osso, não some)
      for (const child of [...this.group.children]) {
        if (child !== wrap && child !== this.saddleGroup) child.visible = false;
      }

      this.mixer = spawned.mixer;
      this.clips = spawned.clips;
      this.modelMesh = spawned.model;
      // altura real do modelo (pro dorso encostar no chão quando deitada)
      const mbox = new THREE.Box3().setFromObject(spawned.model);
      const top = mbox.max.y;
      if (top > 0) this.modelTop = top;
      const msize = mbox.getSize(new THREE.Vector3());
      this.modelMaxDim = Math.max(msize.x, msize.y, msize.z);
      this.modelReady = true;
      tintCowModel(spawned.model, this.skin);
      this.playClip('idle', 1);
      // sela já carregada? prende no osso agora
      if (this.saddleReady) this.attachSaddleToSpine();
      void this.loadFallPose();
    } catch (err) {
      console.warn('Modelo FBX da vaca nao carregou, usando procedural:', err);
    }
  }

  /** Pose de queda (fall.glb, malha estática): aparece enquanto a vaca está
   *  caindo — com o MESMO material da vaca (T_Cow_B) e no MESMO tamanho. */
  private async loadFallPose(): Promise<void> {
    try {
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
      const gltf = await new GLTFLoader().loadAsync('models/cow/fall.glb');
      const model = gltf.scene;
      // as UVs desse mesh pegam o ÚTERO e os cascos do atlas da vaca (manchas
      // rosa/cinza no corpo): remapeia pra área só do pelo (u 0.02..0.60)
      model.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const uv = m.geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
        if (!uv) return;
        for (let i = 0; i < uv.count; i++) {
          uv.setX(i, 0.02 + uv.getX(i) * 0.58);
        }
        uv.needsUpdate = true;
      });
      // material da vaca (textura base; normal map fica de fora — as normais
      // do mesh low-poly nao casam com o atlas e o couro fica esquisito)
      const loader = new THREE.TextureLoader();
      const base = loader.load('models/cow/T_Cow_B.png');
      base.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.MeshLambertMaterial({ color: this.skin.tint, map: base });
      model.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.material = mat;
          m.castShadow = true;
        }
      });
      const mb = new THREE.Box3().setFromObject(model);
      const size = mb.getSize(new THREE.Vector3());
      // MESMO tamanho da vaca normal: iguala a maior dimensão do modelo
      const fallMax = Math.max(size.x, size.y, size.z);
      const cowMax = this.modelMaxDim > 0 ? this.modelMaxDim : 4.6;
      const s = fallMax > 0 ? cowMax / fallMax : 1;
      const wrap = new THREE.Group();
      wrap.add(model);
      wrap.scale.setScalar(s);
      const bb = new THREE.Box3().setFromObject(wrap);
      const c = bb.getCenter(new THREE.Vector3());
      wrap.position.set(-c.x, -bb.min.y, -c.z);
      wrap.visible = false;
      this.group.add(wrap);
      this.fallMesh = wrap as unknown as THREE.Mesh;
      this.fallMat = mat;
      // onde a sela fica na pose de queda: no DORSO da vaca tombada.
      // Na pose, a vaca está de cabeça pra baixo e o dorso aponta pro +X
      // (o útero/ventre fica pro -X). Medido no modelo:
      {
        const p = new THREE.Vector3(0.2, 0.42, 0.35); // x=lombar, y=meio, z=45% da cauda
        this.fallSaddlePos.set(
          p.x * s + wrap.position.x,
          p.y * s + wrap.position.y,
          p.z * s + wrap.position.z,
        );
        // a sela fica "deitada" no dorso (+X) e inclinada 45° pro lado certo
        this.fallSaddleRot = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, -Math.PI / 4));
      }
      console.log(`[vaca] pose de queda: ${(size.x * s).toFixed(1)}x${(size.y * s).toFixed(1)}x${(size.z * s).toFixed(1)}m (escala ${s.toFixed(2)})`);
    } catch (err) {
      console.warn('Pose de queda nao carregou:', err);
    }
  }

  /** Troca a caixa provisória pelo convex hull do modelo (espaço normalizado:
   *  pés em y=0, centrado no XZ — relativo ao PAI (mantém escala/offset do
   *  inner, tira só o giro/posição do grupo); pose de descanso, sem gadgets). */
  private swapToHull(model: THREE.Group): void {
    try {
      if (!model.parent) return;
      model.parent.updateMatrixWorld(true);
      const inv = new THREE.Matrix4().copy(model.parent.matrixWorld).invert();
      const m2 = new THREE.Matrix4();
      const v = new THREE.Vector3();
      const pts: number[] = [];
      let minY = 1e9, maxY = -1e9;
      let maxX = 0, maxZ = 0;
      model.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
        if (!pos) return;
        m2.multiplyMatrices(inv, m.matrixWorld);
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(m2);
          pts.push(v.x, v.y, v.z);
          if (v.y < minY) minY = v.y;
          if (v.y > maxY) maxY = v.y;
          const ax = Math.abs(v.x), az = Math.abs(v.z);
          if (ax > maxX) maxX = ax;
          if (az > maxZ) maxZ = az;
        }
      });
      // tampa até a altura da cabeça erguida (3.6): a pose de descanso tem a
      // cabeça baixa, mas parede alta (loja) precisa encostar em cima também,
      // senão a vaca escala o beiral. Borda arredondada desliza, não engancha.
      const TOP = 3.6;
      if (maxY < TOP) {
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) pts.push(sx * maxX, TOP, sz * maxZ);
        maxY = TOP;
      }
      if (pts.length < 12) return;
      // borda arredondada (igual o bevel da caixa antiga): desliza nos cantos
      const desc = RAPIER.ColliderDesc.roundConvexHull(new Float32Array(pts), 0.25);
      if (!desc) {
        console.warn('[vaca] hull falhou, mantendo caixa');
        return;
      }
      this.world.removeCollider(this.collider, true);
      // o border radius (0.25) INFLADURA a casca pra baixo: compensa pra os
      // pés visuais encostarem no chão (senão a vaca flutua 25cm).
      const BORDER = 0.25;
      this.collider = this.world.createCollider(
        desc.setTranslation(0, -HALF_H - minY + BORDER, 0), this.body);
      console.log(`[vaca] hull do modelo: y ${minY.toFixed(2)}..${maxY.toFixed(2)} (${(pts.length / 3).toFixed(0)} pts)`);
    } catch (err) {
      console.warn('[vaca] hull falhou, mantendo caixa:', err);
    }
  }

  /** Colisor vira sensor (fantasma): pra entrar no carro sem empurrar nada. */
  setGhost(on: boolean): void {
    this.collider.setSensor(on);
  }

  /** Aplica a skin (tinta o FBX; se ainda não carregou, vale quando chegar). */
  setSkin(skin: Skin): void {
    this.skin = skin;
    if (this.modelReady) tintCowModel(this.group, skin);
    if (this.fallMat) this.fallMat.color.set(skin.tint);
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
    this.updateSaddleFollow();
    // pose de queda (fall.glb) enquanto desce; o modelo animado some
    if (this.fallMesh) {
      const vy = this.body.linvel().y;
      const falling = airborne && vy < -1.5;
      this.fallMesh.visible = falling;
      if (this.modelMesh) this.modelMesh.visible = !falling;
      const saddle = this.saddleGroup;
      if (saddle) {
        if (falling) {
          // na queda a sela vai pro dorso da vaca tombada (e fica 45° torta)
          saddle.position.lerp(this.fallSaddlePos, Math.min(1, dt * 6));
          saddle.quaternion.slerp(this.fallSaddleRot, Math.min(1, dt * 6));
        } else {
          saddle.quaternion.slerp(new THREE.Quaternion(), Math.min(1, dt * 6));
        }
      }
    }
    this.flipCD -= dt;
    this.updateBelly(dt);
    if (this.bellyUpT > 0) {
      // caída de barriga pra cima: sem flip e sem andar, só balança até levantar
      if (this.modelReady) this.playClip('idle', 1);
      return;
    }
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

  /** Tomba de barriga pra cima (chamado pelo Game numa queda de muito alto). */
  startBellyUp() {
    if (this.bellyUpT > 0) return;
    this.bellyUpT = this.bellyTotal;
    this.bellyPhase = 0;
  }

  /** Levanta na hora (aperta pular depois de um tempo caída). */
  getUp() {
    this.bellyUpT = 0;
  }

  get bellyUp(): boolean {
    return this.bellyUpT > 0;
  }

  /** Rola pra 180° (barriga pra cima) e balança de um lado pro outro até levantar. */
  private updateBelly(dt: number): void {
    if (this.bellyUpT > 0) {
      this.bellyUpT -= dt;
      this.bellyPhase += dt * 7;
      const decay = Math.min(1, this.bellyUpT / this.bellyTotal + 0.25);
      const target = Math.PI + Math.sin(this.bellyPhase) * 0.45 * decay;
      this.bellyAngle += (target - this.bellyAngle) * Math.min(1, dt * 16);
      this.flipT = 0;
      this.group.rotation.x = 0;
    } else if (this.bellyAngle > 0.001) {
      // recuperação: volta suave pra de pé
      this.bellyAngle += (0 - this.bellyAngle) * Math.min(1, dt * 10);
      if (this.bellyAngle < 0.01) {
        this.bellyAngle = 0;
        this.group.rotation.z = 0;
        return;
      }
    } else {
      return;
    }
    this.group.rotation.z = this.bellyAngle;
  }

  syncMesh() {
    const t = this.body.translation();
    this.group.position.set(t.x, t.y - HALF_H + this.bellyLift(), t.z);
    this.group.rotation.y = this.yaw;
  }

  /** Deitada, o dorso encosta no chão: sobe o visual conforme rola até 180°. */
  private bellyLift(): number {
    if (this.bellyAngle <= 0.001) return 0;
    return (this.modelTop * (1 - Math.cos(this.bellyAngle))) / 2;
  }
}
