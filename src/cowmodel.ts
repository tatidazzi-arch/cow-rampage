import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

/** Escala da vaca: 2 = 200% do tamanho original. */
export const COW_SCALE = 2;
/** Altura do centro do corpo até os pés (a vaca local usa no collider). */
export const COW_HALF_H = 1.1 * COW_SCALE;

const MODEL_BASE = 'models/cow';

export interface CowModelAssets {
  /** Grupo interno já normalizado (pés na origem). Serve de molde p/ clonar. */
  template: THREE.Group;
  clips: Record<string, THREE.AnimationClip>;
}

export interface SpawnedCowModel {
  model: THREE.Group;
  mixer: THREE.AnimationMixer;
  clips: Record<string, THREE.AnimationClip>;
}

let assetsPromise: Promise<CowModelAssets> | null = null;

/** Carrega o FBX uma única vez e compartilha entre todas as vacas
 *  (a local + as remotas do multiplayer). */
export function loadCowAssets(): Promise<CowModelAssets> {
  if (!assetsPromise) assetsPromise = buildCowAssets();
  return assetsPromise;
}

async function buildCowAssets(): Promise<CowModelAssets> {
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
  inner.updateMatrixWorld(true);

  // Normaliza o tamanho: comprimento horizontal vira 2.3 * escala (bate com o collider).
  const targetLen = 2.3 * COW_SCALE;
  const box = new THREE.Box3().setFromObject(inner);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const longest = Math.max(size.x, size.z);
  const s = longest > 0 ? targetLen / longest : 1;
  inner.scale.setScalar(s);
  // Recentraliza no XZ e coloca os pes (min Y) na origem do grupo.
  inner.position.set(-center.x * s, -box.min.y * s, -center.z * s);
  inner.updateMatrixWorld(true);

  const clips: Record<string, THREE.AnimationClip> = {};
  const files: Record<string, string> = {
    idle: 'A_Cow_Idle_01.fbx',
    walk: 'A_Cow_Walk_01.fbx',
    run: 'A_Cow_Run_01.fbx',
    eat: 'A_Cow_Eating_01.fbx',
    idlebreak: 'A_Cow_IdleBreak_01.fbx',
  };
  for (const [name, file] of Object.entries(files)) {
    try {
      const anim = await loader.loadAsync(`${MODEL_BASE}/${file}`);
      if (anim.animations.length > 0) {
        clips[name] = anim.animations[0];
      }
    } catch (err) {
      console.warn(`Animacao ${name} nao carregou:`, err);
    }
  }
  return { template: inner, clips };
}

/** Clona o modelo pra uma vaca (cada clone tem seu esqueleto e mixer). */
export function spawnCowModel(assets: CowModelAssets): SpawnedCowModel {
  const model = cloneSkinned(assets.template) as THREE.Group;
  const mixer = new THREE.AnimationMixer(model);
  return { model, mixer, clips: assets.clips };
}
