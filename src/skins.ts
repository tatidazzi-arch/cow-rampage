import * as THREE from 'three';

export interface Skin {
  id: string;
  name: string;
  /** preço em DINCOW (0 = de graça) */
  price: number;
  /** matiz multiplicada na textura da vaca */
  tint: number;
  /** metalness/roughness/env (só a de ouro usa) */
  metal?: number;
  rough?: number;
  env?: number;
}

export const SKINS: Skin[] = [
  { id: 'comum', name: 'Vaca Comum', price: 0, tint: 0xffffff },
  { id: 'preta', name: 'Vaca Sombria', price: 150, tint: 0x777788 },
  { id: 'rosa', name: 'Vaca Morango', price: 250, tint: 0xff9ecf },
  { id: 'zumbi', name: 'Vaca Zumbi', price: 300, tint: 0x86d986 },
  { id: 'ouro', name: 'Vaca de Ouro', price: 400, tint: 0xffd24a, metal: 0.95, rough: 0.15, env: 1.6 },
];

const OWNED_KEY = 'cowrampage.skins.owned';
const SELECTED_KEY = 'cowrampage.skins.selected';
const WALLET_KEY = 'cowrampage.dincow';

function readStr(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStr(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* sem persistência */
  }
}

export function skinById(id: string): Skin {
  return SKINS.find((s) => s.id === id) ?? SKINS[0]!;
}

export function getOwned(): string[] {
  try {
    const raw = readStr(OWNED_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    const owned = Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
    if (!owned.includes('comum')) owned.unshift('comum');
    return owned;
  } catch {
    return ['comum'];
  }
}

export function isOwned(id: string): boolean {
  return getOwned().includes(id);
}

export function addOwned(id: string): void {
  const owned = getOwned();
  if (!owned.includes(id)) {
    owned.push(id);
    writeStr(OWNED_KEY, JSON.stringify(owned));
  }
}

export function getSelectedId(): string {
  const id = readStr(SELECTED_KEY) ?? 'comum';
  return isOwned(id) ? id : 'comum';
}

export function setSelectedId(id: string): void {
  if (isOwned(id)) writeStr(SELECTED_KEY, id);
}

/** Carteira persistente de DINCOW (ganha jogando, gasta na loja). */
export function getWallet(): number {
  const raw = readStr(WALLET_KEY);
  const v = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

export function addDincow(n: number): number {
  const w = getWallet() + Math.max(0, Math.floor(n));
  writeStr(WALLET_KEY, String(w));
  return w;
}

/** Retorna false se não tem saldo. */
export function spendDincow(n: number): boolean {
  const w = getWallet();
  if (w < n) return false;
  writeStr(WALLET_KEY, String(w - n));
  return true;
}

/** Tinta o modelo FBX (clona materiais pra não vazar pros outros). */
export function tintCowModel(root: THREE.Object3D, skin: Skin): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const sm = o as THREE.SkinnedMesh;
    if (!sm.isSkinnedMesh) return;
    if (!sm.userData['tinted']) {
      sm.material = (sm.material as THREE.Material).clone();
      sm.userData['tinted'] = true;
    }
    const mat = sm.material as THREE.MeshStandardMaterial;
    mat.color.set(skin.tint);
    mat.metalness = skin.metal ?? 0;
    mat.roughness = skin.rough ?? 1;
    mat.envMapIntensity = skin.env ?? 1;
  });
}
