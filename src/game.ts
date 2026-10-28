import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import RAPIER from '@dimforge/rapier3d-compat';
import { Input } from './input';
import { World, islandRadius, BALL, BRIDGE, CITY, SPAWN, MINE, MANSION, FOREST, GOATS } from './world';
import { Cow, COW_SCALE } from './cow';
import { NPCFactory, isSweater } from './npc';
import type { NPCPhysics } from './npc';
import { MissionManager } from './missions';
import { NetManager, RemoteCow } from './net';
import type { CowNetState } from './net';
import { worldRand } from './rng';
import { COW_HALF_H } from './cowmodel';
import {
  SKINS, addDincow, addOwned, getOwned, getSelectedId, getWallet,
  setSelectedId, skinById, spendDincow,
} from './skins';
import { isTouchDevice, setupTouchControls } from './touch';
import { isMuted, playSfx, resumeAudio, toggleMute } from './sound';
import { cleanName } from './profanity';
import { CowAI } from './ai';

/** Hash do commit injetado no build (vite.config). */
declare const __COMMIT__: string;

/** Cores do ciclo dia/noite (sem alocar por frame). */
const MOON_COL = new THREE.Color(0x8fa8ff);
const SUN_COL = new THREE.Color(0xfff2dd);
const SET_COL = new THREE.Color(0xff9448);
const FOG_DAY = new THREE.Color(0x87ceeb);
const FOG_NIGHT = new THREE.Color(0x0a1226);

export class Game {
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private lastTime = performance.now();
  private physics!: RAPIER.World;
  private input!: Input;
  private world!: World;
  private cow!: Cow;
  private npcFactory!: NPCFactory;
  private npcs: NPCPhysics[] = [];
  private net = new NetManager();
  private remoteCows = new Map<string, RemoteCow>();
  /** A IA (vaca preta e verde que fala por voz). */
  private cowAI: CowAI | null = null;
  private netActive = false;
  private netAcc = 0;

  private score = 0;
  private lastScore = 0;
  private quality: 'high' | 'low' = 'high';
  private sunLight: THREE.DirectionalLight | null = null;
  /** Cúpula do céu (gradiente + sol): segue a câmera, 1 draw call. */
  private skyDome: THREE.Mesh | null = null;
  private skyMat: THREE.ShaderMaterial | null = null;
  private hemiLight: THREE.HemisphereLight | null = null;
  private ambLight: THREE.AmbientLight | null = null;
  /** 3 postes de verdade (PointLights nos bulbos mais próximos, só à noite). */
  private lampLights: THREE.PointLight[] = [];
  private lampScanT = 0;
  /** Relógio do ciclo dia/noite (0 = 6h; volta completa em 6 min). */
  private dayT = 0.075;
  private static readonly DAY_LEN = 360;
  private dayNightTmp = new THREE.Color();
  private lastClock = '';
  private menuCamT = 0;
  private chaos = 0;
  private carrying: NPCPhysics | null = null;
  /** Carro que a vaca pegou (dirigindo): null = a pé. */
  private ridingCar: (typeof this.world.cars)[number] | null = null;
  private camDist = 16;
  private camYaw = 0;
  private camPitch = 0.45;
  private started = false;
  private physAcc = 0;
  /** maior velocidade de queda desde o último toque no chão (tombo) */
  private fallV = 0;
  /** Tempo de queda (s): a gravidade cresce quanto mais tempo se cai. */
  private fallT = 0;
  /** Gravidade base (aumentada) e quanto a queda acelera a queda. */
  private gravBase = 14;
  private gravRamp = 16;
  /** embalo pós-foguete: enquanto > 0, sem freio brusco (desliza até parar) */
  private coastT = 0;
  /** cooldown do atropelamento (evita reatingir todo frame encostado) */
  private carHitCD = 0;
  // --- Pool de partículas: 1 único InstancedMesh (antes: 1 Mesh+BoxGeometry por
  // faísca, criada a cada frame pelo jetpack e nunca liberada -> GC + vazamento GPU).
  private particleIM: THREE.InstancedMesh | null = null;
  private readonly pData: { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number }[] = [];
  private readonly P_MAX = 600;
  private pCursor = 0;
  private readonly _pMat = new THREE.Matrix4();
  private readonly _pCol = new THREE.Color();
  // --- Scratch reutilizável: zero alocação de Vector3/Ray por frame ---
  private readonly _fwd = new THREE.Vector3();
  private readonly _rgt = new THREE.Vector3();
  private readonly _move = new THREE.Vector3();
  private readonly _carryOff = new THREE.Vector3();
  private readonly _carryTgt = new THREE.Vector3();
  private readonly _camPos = new THREE.Vector3();
  private readonly _push = new THREE.Vector3();
  private downRay: RAPIER.Ray | null = null;
  private hudAcc = 0;
  /** modo debug (senha debugcow): hitboxes do Rapier desenhadas em azul, só perto da vaca */
  private debugHitboxes: THREE.LineSegments | null = null;
  private debugFpsEl: HTMLDivElement | null = null;
  private debugFpsAcc = 0;
  private debugFpsFrames = 0;
  private debugFpsShown = 0;
  /** buffer reaproveitado no recorte das linhas em volta da vaca */
  private debugBuffer = new Float32Array(0);
  private debugSegmentsDrawn = 0;
  /** wireframes dos prédios (trimesh): gerados 1x e cacheados, não a cada frame */
  private debugTrimeshGroup: THREE.Group | null = null;
  private debugTrimeshMat: THREE.LineBasicMaterial | null = null;
  private debugTrimeshCache = new Map<number, { obj: THREE.LineSegments | null; x: number; y: number; z: number; segs: number }>();
  private debugTrimeshQueue = new Set<number>();
  private debugTrimeshSegments = 0;
  private debugEvictAcc = 0;
  private missions = new MissionManager();
  private sweaterHintAt = 0;
  private wasSwimming = false;
  private swimSplashT = 0;

constructor() {}

  readonly loadTimes: Record<string, number> = {};

  async start() {
    const loading = this.createLoadingScreen();
    const t0 = performance.now();
    const mark = (k: string) => { this.loadTimes[k] = Math.round(performance.now() - t0); };
    try {
      await RAPIER.init();
      mark('rapier');
      loading(20, 'Carregando fisica Rapier...');
      this.setupScene(loading);
      this.setupInput();
      await this.buildWorld(loading);
      mark('world');
      this.setupHUD();
      loading(100, 'Pronto!');
      setTimeout(() => {
        const el = document.getElementById('loading');
        if (el) el.style.display = 'none';
      }, 150);
      this.animate();
    } catch (e) {
      console.error(e);
      const el = document.getElementById('loading');
      if (el) el.innerHTML = '<div style="color:#f55">Erro ao carregar: ' + (e as Error).message + '</div>';
    }
  }

  private createLoadingScreen(): (pct: number, label: string) => void {
    const el = document.createElement('div');
    el.id = 'loading';
    el.innerHTML = '<div>Carregando...</div><div class="bar"><div class="fill" id="loadfill"></div></div>';
    document.body.appendChild(el);
    return (pct) => {
      const fill = document.getElementById('loadfill');
      if (fill) (fill as HTMLElement).style.width = pct + '%';
    };
  }

  private setupScene(loading: (pct: number, label: string) => void) {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87ceeb);
    this.scene.fog = new THREE.Fog(0x87ceeb, 800, 2500);

    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 6000);

    this.renderer = new THREE.WebGLRenderer({ antialias: !isTouchDevice() });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    // reflexos pro metal (vaca de ouro): ambiente leve, 1x só
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      pmrem.dispose();
    } catch {
      /* sem reflexos */
    }
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    document.body.appendChild(this.renderer.domElement);
    this.initParticles();

    this.ambLight = new THREE.AmbientLight(0x606080, 0.6);
    this.scene.add(this.ambLight);
    const dl = new THREE.DirectionalLight(0xffdfb0, 1.25);
    dl.position.set(50, 21, 30);
    dl.castShadow = true;
    dl.shadow.mapSize.width = 1024;
    dl.shadow.mapSize.height = 1024;
    // Frustum JUSTO em volta do jogador (antes: ±250m fixo no centro do mapa ->
    // o shadow map inteiro era gasto longe e a sombra nem cobria o spawn). O sol
    // segue a vaca em updateSun(), então só o que está a <90m entra no passe de sombra.
    dl.shadow.camera.left = -90;
    dl.shadow.camera.right = 90;
    dl.shadow.camera.top = 90;
    dl.shadow.camera.bottom = -90;
    dl.shadow.camera.near = 1;
    dl.shadow.camera.far = 400;
    dl.shadow.bias = -0.0005;
    dl.shadow.normalBias = 0.02;
    dl.shadow.camera.updateProjectionMatrix();
    this.scene.add(dl);
    this.scene.add(dl.target);
    this.hemiLight = new THREE.HemisphereLight(0x87ceeb, 0x445522, 0.4);
    this.scene.add(this.hemiLight);
    for (let i = 0; i < 3; i++) {
      const pl = new THREE.PointLight(0xffc873, 0, 70, 1.8);
      this.scene.add(pl);
      this.lampLights.push(pl);
    }
    this.sunLight = dl;
    // Sol + atmosfera: cúpula com gradiente (zênite->horizonte), disco solar e
    // halo alinhados com a luz de verdade (mesma direção do updateSun).
    {
      // raio 1000: dentro do camera.far dinâmico (min ~1600 na cidade)
      const skyGeo = new THREE.SphereGeometry(1000, 24, 16);
      const sunDir = new THREE.Vector3(50, 21, 30).normalize();
      const skyMat = new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: { sunDir: { value: sunDir }, nightF: { value: 0 } },
        vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position);'
          + ' gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: [
          'varying vec3 vDir; uniform vec3 sunDir; uniform float nightF;',
          'void main() {',
          '  vec3 nd = normalize(vDir);',
          '  float h = clamp(nd.y, -1.0, 1.0);',
          '  float dayF = 1.0 - nightF;',
          '  vec3 zen = mix(vec3(0.008, 0.02, 0.07), vec3(0.20, 0.45, 0.85), dayF);',
          '  vec3 hor = mix(vec3(0.04, 0.07, 0.16), vec3(0.78, 0.88, 0.95), dayF);',
          '  vec3 col = mix(hor, zen, smoothstep(0.0, 0.6, h));',
          '  vec3 seam = mix(vec3(0.028, 0.049, 0.112), vec3(0.35, 0.55, 0.75), dayF);',
          '  col = mix(seam, col, smoothstep(-0.15, 0.02, h));',
          '  vec3 sd = normalize(sunDir);',
          '  float s = max(dot(nd, sd), 0.0);',
          '  float elev = abs(sd.y);',
          '  col += vec3(1.0, 0.5, 0.25) * pow(s, 6.0) * dayF * smoothstep(0.4, 0.0, elev);',
          '  col += vec3(1.0, 0.95, 0.85) * smoothstep(0.9993, 0.9997, s) * 4.0 * dayF;',
          '  col += vec3(1.0, 0.85, 0.6) * pow(s, 350.0) * 0.6 * dayF;',
          '  col += vec3(1.0, 0.9, 0.7) * pow(s, 8.0) * 0.12 * dayF;',
          '  vec3 md = -sd;',
          '  float m = max(dot(nd, md), 0.0);',
          '  col += vec3(0.85, 0.9, 1.0) * smoothstep(0.99965, 0.99985, m) * 1.6 * nightF;',
          '  col += vec3(0.5, 0.6, 0.9) * pow(m, 900.0) * 0.35 * nightF;',
          '  vec3 cell = floor(nd * 220.0);',
          '  float hs = fract(sin(dot(cell, vec3(12.9898, 78.233, 45.164))) * 43758.5453);',
          '  col += vec3(0.9, 0.93, 1.0) * step(0.9985, hs) * nightF * smoothstep(0.02, 0.25, h);',
          '  gl_FragColor = vec4(col, 1.0);',
          '}',
        ].join('\n'),
      });
      const sky = new THREE.Mesh(skyGeo, skyMat);
      sky.frustumCulled = false;
      this.scene.add(sky);
      this.skyDome = sky;
      this.skyMat = skyMat;
    }
    this.applyQuality();

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });

    loading(15, 'Criando cena...');
  }

  /** Configurações salvas (qualidade + sensibilidade). */
  private loadSettings() {
    try {
      const q = window.localStorage.getItem('cowrampage.quality');
      this.quality = q === 'low' ? 'low' : 'high';
      const s = Number.parseFloat(window.localStorage.getItem('cowrampage.sens') ?? '1');
      this.input.sensitivity = Number.isFinite(s) ? Math.min(2, Math.max(0.5, s)) : 1;
    } catch {
      this.quality = 'high';
    }
  }

  private applyQuality() {
    const low = this.quality === 'low';
    try {
      window.localStorage.setItem('cowrampage.quality', this.quality);
    } catch { /* ignora */ }
    if (this.sunLight) this.sunLight.castShadow = !low;
    this.renderer.shadowMap.enabled = !low;
    // BAIXA: sem sombras; ALTA: PCF (o PCFSoftShadowMap foi removido no three r186).
    this.renderer.shadowMap.type = low ? THREE.BasicShadowMap : THREE.PCFShadowMap;
    // recompila os shaders já criados (mundo pode já existir)
    const mats = new Set<THREE.Material>();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const mm = m.material as THREE.Material | THREE.Material[];
      if (Array.isArray(mm)) mm.forEach((x) => mats.add(x));
      else if (mm) mats.add(mm);
    });
    mats.forEach((m) => { m.needsUpdate = true; });
    this.refreshCfgMenu();
  }

  private setQuality(q: 'high' | 'low') {
    this.quality = q;
    this.applyQuality();
  }

  private setSensitivity(v: number) {
    if (!Number.isFinite(v)) return;
    this.input.sensitivity = Math.min(2, Math.max(0.5, v));
    try {
      window.localStorage.setItem('cowrampage.sens', String(this.input.sensitivity));
    } catch { /* ignora */ }
    this.refreshCfgMenu();
  }

  /** Liga/desliga o som (botão 🔊 do HUD ou tecla M). */
  private toggleSound() {
    const muted = toggleMute();
    const btn = document.getElementById('soundBtn');
    if (btn) btn.textContent = muted ? '🔇' : '🔊';
    if (!muted) playSfx('click');
  }

  private openCfgMenu() {
    document.getElementById('gamemenu')!.style.display = 'none';
    document.getElementById('configmenu')!.style.display = 'flex';
    this.refreshCfgMenu();
  }

  private closeCfgMenu() {
    document.getElementById('configmenu')!.style.display = 'none';
    document.getElementById('gamemenu')!.style.display = 'flex';
    this.refreshMenuWallet();
  }

  private refreshCfgMenu() {
    const qH = document.getElementById('qHigh');
    const qL = document.getElementById('qLow');
    if (qH) qH.style.background = this.quality === 'high' ? '#ffcc00' : '#fff';
    if (qL) qL.style.background = this.quality === 'low' ? '#ffcc00' : '#fff';
    const sens = document.getElementById('sensRange') as HTMLInputElement | null;
    const val = document.getElementById('sensVal');
    if (sens && this.input) sens.value = String(this.input.sensitivity);
    if (val && this.input) val.textContent = this.input.sensitivity.toFixed(1);
    const aiUrl = document.getElementById('aiUrl') as HTMLInputElement | null;
    if (aiUrl) {
      let saved = '';
      try { saved = localStorage.getItem('cowrampage.ai.llm') ?? ''; } catch { saved = ''; }
      aiUrl.value = saved;
    }
  }

  private refreshMenuWallet() {
    const el = document.getElementById('menuwallet');
    if (el) el.textContent = `🪙 ${getWallet()} DINCOW`;
  }

  /** Sair: volta pra tela da senha. */
  private lockGame() {
    if (this.netActive) this.leaveNet();
    if (this.cowAI) { this.cowAI.stop(); this.cowAI = null; }
    this.started = false;
    if (document.pointerLockElement) {
      try {
        document.exitPointerLock();
      } catch { /* ignora */ }
    }
    for (const id of ['hud', 'controls', 'mission', 'scores', 'leaveBtn', 'touchui', 'mousehint', 'gamemenu', 'netmenu', 'skinmenu', 'configmenu', 'gadgetmenu']) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }
    const pw = document.getElementById('pwInput') as HTMLInputElement | null;
    if (pw) pw.value = '';
    document.getElementById('lockscreen')!.style.display = 'flex';
    document.title = 'Acesso';
  }

  private setupInput() {
    this.input = new Input(this.renderer.domElement);
    this.loadSettings();
    setupTouchControls(this.input, () => this.started);
    this.input.onPadMenu = () => {
      if (this.started) this.exitToMenu();
    };
    this.input.onCycleGadget = (dir: number) => {
      if (this.started) this.cycleGadget(dir);
    };
    this.input.onPadStatus = (connected) => {
      if (connected && this.started) {
        this.showMessage('🎮 Controle conectado! Bola=pular, R1=cabeçada (sem X!)');
      }
    };
    this.input.onLockError = () => {
      this.showMessage('Mouse recusado: clique de novo ou arraste pra olhar');
    };
    this.renderer.domElement.addEventListener('click', () => {
      if (this.started) this.input.requestLock();
    });
    // clica em qualquer lugar pra (re)ativar o mouse (ex.: depois do Esc)
    document.addEventListener('mousedown', () => {
      if (this.started && !this.input.mouseLocked) this.input.requestLock();
    });
    document.addEventListener('click', () => {
      if (this.started && !this.input.mouseLocked) this.input.requestLock();
    });
    // voltou pra aba (celular suspende tudo): reanuncia presença na hora
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.net.connected) this.net.poke();
    });
  }

  private async buildWorld(loading: (pct: number, label: string) => void) {
    this.physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world = new World(this.scene, this.physics, loading);
    loading(5, 'Criando chao...');

    await this.world.buildBuildings(40);
    await this.world.buildTrees(100);
    this.world.buildCannons(16);
    await this.world.buildGrass(3000);
    this.world.buildDistricts();

    this.cow = new Cow(this.scene, this.physics, SPAWN.x, SPAWN.z);
    this.cow.syncMesh();
    (window as unknown as Record<string, unknown>).__game = this;
    this.npcFactory = new NPCFactory();
    await this.npcFactory.preload();
    await this.npcFactory.preloadZane();
    await this.npcFactory.preloadWalker();
    await this.npcFactory.preloadFights();
    const placeNPC = (x: number, z: number, kind?: 'goat') => {
      const n = this.npcFactory.create(this.scene, this.physics, x, z, kind);
      // sem sombra (são pequenos; economiza 1 passe inteiro no shadow map)
      n.mesh.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.castShadow = false;
          m.receiveShadow = false;
        }
      });
      this.npcs.push(n);
    };
    // minas e mansão: ninguém (nem spawn)
    const npcSpotOk = (x: number, z: number): boolean => {
      if (!this.world.isOnIsland(x, z, 3)) return false;
      if (Math.hypot(x - MINE.x, z - MINE.z) < MINE.r + 8) return false;
      if (Math.hypot(x - MANSION.x, z - MANSION.z) < 60) return false;
      for (const b of this.world.buildings) {
        if (Math.abs(x - b.x) < b.halfW + 1.5 && Math.abs(z - b.z) < b.halfD + 1.5) return false;
      }
      return true;
    };
    // 60 espalhados pela ilha principal
    for (let i = 0; i < 60; i++) {
      let x = 20, z = 20;
      for (let a = 0; a < 40; a++) {
        const th = worldRand() * Math.PI * 2;
        const rr = Math.sqrt(worldRand()) * (islandRadius(th, true) - 14);
        const px = Math.cos(th) * rr;
        const pz = Math.sin(th) * rr;
        if (Math.hypot(px - SPAWN.x, pz - SPAWN.z) < 15) continue;
        if (!npcSpotOk(px, pz)) continue;
        x = px; z = pz; break;
      }
      placeNPC(x, z);
    }
    // calçadas das avenidas largas (~30m, lados alternados, sobre a calçada 6..9)
    for (let z = -1050, s = 1; z <= 1150; z += 30, s *= -1) {
      const px = s * 8 + (worldRand() - 0.5) * 2;
      if (npcSpotOk(px, z)) placeNPC(px, z);
    }
    for (let x = -1370, s = 1; x <= 1150; x += 30, s *= -1) {
      const pz = s * 8 + (worldRand() - 0.5) * 2;
      if (npcSpotOk(x, pz)) placeNPC(x, pz);
    }
    // ruas da cidade (~40m)
    for (let k = -1; k <= 1; k++) {
      for (let d = -300; d <= 300; d += 40) {
        const jx = (worldRand() - 0.5) * 4;
        if (npcSpotOk(k * 400 + jx, CITY.z + d)) placeNPC(k * 400 + jx, CITY.z + d);
        const jz = (worldRand() - 0.5) * 4;
        if (npcSpotOk(CITY.x + d, CITY.z + k * 400 + jz)) placeNPC(CITY.x + d, CITY.z + k * 400 + jz);
      }
    }
    // ponte (poucos)
    for (let z = -1400, s = 1; z <= -1120; z += 40, s *= -1) {
      const px = s * 3;
      if (this.onBridge(px, z)) placeNPC(px, z);
    }
    // bodes da cidade das cabras
    await this.world.buildForestPatch(FOREST.x, FOREST.z, FOREST.r, 150);
    for (let i = 0; i < 10; i++) {
      const th = worldRand() * Math.PI * 2;
      const rr = Math.sqrt(worldRand()) * 30;
      const gx = GOATS.x + Math.cos(th) * rr;
      const gz = GOATS.z + Math.sin(th) * rr;
      placeNPC(gx, gz, 'goat');
    }
    // (a loja de skins do usuário já tem bode próprio; sem vendedor NPC)
    // trabalhadores da fazenda (poucos: spawn tranquilo)
    for (let i = 0; i < 6; i++) {
      let gx = BALL.x, gz = BALL.z;
      for (let a = 0; a < 12; a++) {
        const th = worldRand() * Math.PI * 2;
        const rr = Math.sqrt(worldRand()) * 60;
        gx = BALL.x + Math.cos(th) * rr;
        gz = BALL.z + Math.sin(th) * rr;
        if (Math.hypot(gx - SPAWN.x, gz - SPAWN.z) >= 12) break;
      }
      placeNPC(gx, gz);
    }
    loading(95, 'Criando NPCs...');
  }

  private setupHUD() {
    const hud = document.createElement('div');
    hud.id = 'hud';
    hud.style.display = 'none';
    hud.innerHTML = `
      <div>🪙 DINCOW: <span id="score">0</span> <span id="padstat"></span> <span id="dayphase">☀ 07:48</span></div>
      <div>Caos: <div id="chaos-bar"><div id="chaos-fill"></div></div> <span id="chaos-pct">0%</span></div>
      <div id="carry-status"></div>
      <div id="gadget-status"></div>
      <button id="menuBtn">MENU</button>
      <button id="soundBtn">${isMuted() ? '🔇' : '🔊'}</button>
    `;
    document.body.appendChild(hud);
    document.getElementById('menuBtn')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.exitToMenu();
    });
    document.getElementById('soundBtn')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleSound();
    });

    const controls = document.createElement('div');
    controls.id = 'controls';
    controls.style.display = 'none';
    controls.textContent = isTouchDevice()
      ? 'Joystick: mover | Arrastar na tela: câmera | Botões: ações | 🎒: aparelho'
      : 'WASD:Mover | Espaco:Pular | E:Interagir | F:Soltar | Q:Cabecada | R:Mortal | M:Som | Shift:Correr | Mouse:Camera | Scroll:Zoom | 1/2/3:Aparelho';
    document.body.appendChild(controls);

    const mousehint = document.createElement('div');
    mousehint.id = 'mousehint';
    mousehint.textContent = 'Clique na tela para ativar o mouse (arrastar tambem olha)';
    document.body.appendChild(mousehint);

    // indicador de versão: qual commit está no ar (até na tela da senha)
    const commitTag = document.createElement('div');
    commitTag.id = 'commitTag';
    commitTag.textContent = `v ${typeof __COMMIT__ !== 'undefined' ? __COMMIT__ : 'dev'}`;
    commitTag.style.cssText = 'position:fixed;left:6px;bottom:2px;z-index:9999;'
      + 'font:11px monospace;color:#fff;opacity:.55;pointer-events:none;'
      + 'text-shadow:1px 1px 2px #000;';
    document.body.appendChild(commitTag);

    const mission = document.createElement('div');
    mission.id = 'mission';
    mission.style.display = 'none';
    document.body.appendChild(mission);

    const scores = document.createElement('div');
    scores.id = 'scores';
    scores.style.display = 'none';
    document.body.appendChild(scores);

    const leaveBtn = document.createElement('button');
    leaveBtn.id = 'leaveBtn';
    leaveBtn.textContent = 'sair da sala';
    leaveBtn.style.display = 'none';
    document.body.appendChild(leaveBtn);
    leaveBtn.addEventListener('click', () => this.leaveNet());

    this.missions.onComplete = (done, next) => {
      this.score += done.reward;
      playSfx('coin');
      this.chaos = Math.min(100, this.chaos + 10);
      const p = this.cow.group.position;
      this.spawnParticles(p.x, p.y + 2, p.z, 20, 0xffcc32);
      this.showMessage(next
        ? `+${done.reward} DINCOW! Nova: ${next.title}`
        : `+${done.reward} DINCOW! TODAS COMPLETAS 🏆`);
    };

    const start = document.createElement('div');
    start.id = 'start';
    start.innerHTML = `
      <div id="lockscreen">
        <p>Digite a senha para continuar</p>
        <input id="pwInput" type="password" placeholder="Senha" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
        <div id="pwError"></div>
        <button id="unlockBtn">ENTRAR</button>
      </div>
      <div id="gamemenu" style="display:none">
        <h1>COW RAMPAGE</h1>
        <h2>🐄 Goat Simulator Edition</h2>
        <div id="menuwallet">🪙 0 DINCOW</div>
        <button id="playBtn">jogar offline</button>
        <button id="aiBtn">🤖 jogar com IA</button>
        <button id="netBtn">jogar online</button>
        <button id="cfgBtn">configurações</button>
        <button id="sairBtn">sair</button>
        <button id="skinBtn">🐄 skins</button>
        <button id="gadgetBtn">🎒 aparelhos</button>
        <p class="controls-mini">WASD mover · Espaço pular · Q cabeçada · 🎮 controle funciona!</p>
        <p class="ver">v0.0.1 · multiplayer sem conta</p>
      </div>
      <div id="configmenu" style="display:none">
        <h1>CONFIGURAÇÕES</h1>
        <div class="cfgrow"><span>Qualidade</span><span><button id="qHigh">ALTA</button><button id="qLow">BAIXA</button></span></div>
        <div class="cfgrow"><span>Sensibilidade</span><span><input id="sensRange" type="range" min="0.5" max="2" step="0.1" value="1" /><b id="sensVal">1.0</b></span></div>
        <div class="cfgrow"><span>IA (proxy URL)</span><span><input id="aiUrl" type="text" placeholder="https://...workers.dev" size="26" /></span></div>
        <p style="font-size:12px;color:#9aa;max-width:520px;text-align:center">Cole a URL do proxy pra IA de verdade (Groq/OpenAI). Sem isso o CowAI usa o cérebro local. Deixa em branco e rode <b>ollama serve</b> pra usar a IA de graça no seu PC.</p>
        <button id="cfgBack">VOLTAR</button>
      </div>
      <div id="skinmenu" style="display:none">
        <h1>SKINS</h1>
        <p>Compre com DINCOW 🪙 (ganha jogando, saldo salvo)</p>
        <div id="skinwallet"></div>
        <div id="skinlist"></div>
        <div id="skinError"></div>
        <button id="skinBack">VOLTAR</button>
      </div>
      <div id="gadgetmenu" style="display:none">
        <h1>APARELHOS</h1>
        <p>O que vai nas costas da vaca (1/2/3 troca no jogo)</p>
        <div id="gadgetlist"></div>
        <button id="gadgetBack">VOLTAR</button>
      </div>
      <div id="netmenu" style="display:none">
        <h1>MULTIPLAYER</h1>
        <p>Mesma sala = mesmo caos. Sem conta!</p>
        <p>Os dois entram com o MESMO código e clicam JOGAR ONLINE.</p>
        <input id="netName" placeholder="Seu nome" autocomplete="off" />
        <input id="netRoom" placeholder="Código da sala" autocomplete="off" />
        <div id="netError"></div>
        <button id="netJoin">ENTRAR NA SALA</button>
        <div id="netplayerlist"></div>
        <button id="netPlay" style="display:none">JOGAR ONLINE</button>
        <button id="netRetry" style="display:none">🔄 RECONECTAR</button>
        <button id="netBack">VOLTAR</button>
      </div>
    `;
    document.body.appendChild(start);
    document.getElementById('unlockBtn')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.startGame();
    });
    document.getElementById('playBtn')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.beginPlay(false);
    });
    document.getElementById('aiBtn')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.beginPlay(false, true);
    });
    document.getElementById('netBtn')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openNetMenu();
    });
    document.getElementById('skinBtn')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openSkinMenu();
    });
    document.getElementById('gadgetBtn')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openGadgetMenu();
    });
    document.getElementById('gadgetBack')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeGadgetMenu();
    });
    document.getElementById('cfgBtn')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openCfgMenu();
    });
    document.getElementById('sairBtn')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.lockGame();
    });
    document.getElementById('cfgBack')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeCfgMenu();
    });
    document.getElementById('qHigh')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setQuality('high');
    });
    document.getElementById('qLow')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setQuality('low');
    });
    const sens = document.getElementById('sensRange') as HTMLInputElement;
    sens.addEventListener('click', (e) => e.stopPropagation());
    sens.addEventListener('input', () => {
      this.setSensitivity(Number.parseFloat(sens.value));
    });
    const aiUrl = document.getElementById('aiUrl') as HTMLInputElement;
    aiUrl.addEventListener('click', (e) => e.stopPropagation());
    aiUrl.addEventListener('change', () => {
      if (this.cowAI) this.cowAI.llmUrl = aiUrl.value;
      else {
        try {
          if (aiUrl.value.trim()) localStorage.setItem('cowrampage.ai.llm', aiUrl.value.trim());
          else localStorage.removeItem('cowrampage.ai.llm');
        } catch { /* ignora */ }
      }
    });
    document.getElementById('skinBack')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeSkinMenu();
    });
    document.getElementById('netBack')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeNetMenu();
    });
    document.getElementById('netJoin')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.joinNetRoom();
    });
    document.getElementById('netRetry')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.joinNetRoom();
    });
    document.getElementById('netPlay')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.beginPlay(true);
    });
    for (const id of ['netName', 'netRoom']) {
      const el = document.getElementById(id)!;
      el.addEventListener('click', (e) => e.stopPropagation());
      el.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if ((e as KeyboardEvent).key === 'Enter') this.joinNetRoom();
      });
    }
    const pwInput = document.getElementById('pwInput')!;
    pwInput.addEventListener('click', (e) => e.stopPropagation());
    pwInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if ((e as KeyboardEvent).key === 'Enter') this.startGame();
    });
  }

  private startGame() {
    const pw = ((document.getElementById('pwInput') as HTMLInputElement | null)?.value ?? '').trim().toLowerCase();
    const debug = pw === 'debugcow';
    if (pw !== 'cowcow' && !debug) {
      const err = document.getElementById('pwError');
      if (err) err.textContent = 'Senha incorreta!';
      return;
    }
    resumeAudio();
    playSfx('click');
    document.title = 'Cow Rampage 3D';
    (document.getElementById('pwInput') as HTMLInputElement | null)?.blur();
    document.getElementById('lockscreen')!.style.display = 'none';
    document.getElementById('gamemenu')!.style.display = 'flex';
    if (debug) this.enableDebugHitboxes();
    this.refreshMenuWallet();
  }

  /** Liga as hitboxes do Rapier em azul (só pela senha debugcow). */
  private enableDebugHitboxes() {
    if (this.debugHitboxes) {
      this.debugHitboxes.visible = true;
      return;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    const material = new THREE.LineBasicMaterial({
      color: 0x2f7bff,
      transparent: true,
      opacity: 0.75,
      depthTest: false,
    });
    const lines = new THREE.LineSegments(geometry, material);
    lines.frustumCulled = false;
    lines.renderOrder = 999;
    this.debugHitboxes = lines;
    this.scene.add(lines);
    const group = new THREE.Group();
    group.name = 'debug-trimesh';
    this.scene.add(group);
    this.debugTrimeshGroup = group;
    this.debugTrimeshMat = material;
    this.createFpsMeter();
    console.log('[debug] hitboxes em azul ligadas');
  }

  /** Cria o medidor de FPS do modo debug (canto superior esquerdo). */
  private createFpsMeter() {
    if (this.debugFpsEl) {
      this.debugFpsEl.style.display = 'block';
      return;
    }
    const el = document.createElement('div');
    el.id = 'debugfps';
    el.style.cssText = [
      'position:fixed',
      'top:10px',
      'left:10px',
      'z-index:9999',
      'padding:6px 10px',
      'border-radius:6px',
      'background:rgba(0,0,0,0.65)',
      'color:#4da3ff',
      'font:600 14px/1.3 ui-monospace,Consolas,monospace',
      'letter-spacing:0.5px',
      'pointer-events:none',
      'text-shadow:0 1px 2px rgba(0,0,0,0.8)',
    ].join(';');
    el.textContent = 'FPS --';
    document.body.appendChild(el);
    this.debugFpsEl = el;
  }

  /** Copia as linhas de debug do Rapier para o LineSegments a cada frame.
   *  Só entram colliders perto da vaca e cada linha é recortada num raio de 200 m:
   *  desenhar o mundo inteiro (terreno + construções) custava ~1 s por frame. */
  private updateDebugHitboxes(dt: number) {
    const lines = this.debugHitboxes;
    if (!lines) return;

    const cow = this.cow ? this.cow.body.translation() : { x: 0, y: 0, z: 0 };
    const cx = cow.x, cy = cow.y, cz = cow.z;
    const RANGE = 200;
    const near2 = RANGE * RANGE;
    // colliders com o centro um pouco além do raio ainda entram, porque a hitbox
    // pode terminar dentro dos 200 m; o recorte abaixo apara o excesso.
    const pick2 = (RANGE + 8) * (RANGE + 8);

    this.debugTrimeshQueue.clear();
    const { vertices } = this.physics.debugRender(undefined, (collider: RAPIER.Collider) => {
      const t = collider.translation();
      // prédios/terreno (trimesh) são desenhados à parte e cacheados: regerar
      // as malhas grandes a cada frame custava ~1 s. O corpo do prédio fica no
      // chão, então a distância é medida na horizontal (x/z).
      if (collider.shapeType() === RAPIER.ShapeType.TriMesh) {
        const hx = t.x - cx, hz = t.z - cz;
        if (hx * hx + hz * hz > pick2) return false;
        if (!this.debugTrimeshCache.has(collider.handle)) {
          this.debugTrimeshQueue.add(collider.handle);
        }
        return false;
      }
      const dx = t.x - cx, dy = t.y - cy, dz = t.z - cz;
      return dx * dx + dy * dy + dz * dz <= pick2;
    });

    let out = this.debugBuffer;
    if (out.length < vertices.length) {
      out = new Float32Array(vertices.length);
      this.debugBuffer = out;
    }
    let w = 0;
    for (let i = 0; i + 5 < vertices.length; i += 6) {
      const ax = vertices[i]! - cx, ay = vertices[i + 1]! - cy, az = vertices[i + 2]! - cz;
      const bx = vertices[i + 3]! - cx, by = vertices[i + 4]! - cy, bz = vertices[i + 5]! - cz;
      if (ax * ax + ay * ay + az * az > near2 && bx * bx + by * by + bz * bz > near2) continue;
      out[w++] = vertices[i]!;
      out[w++] = vertices[i + 1]!;
      out[w++] = vertices[i + 2]!;
      out[w++] = vertices[i + 3]!;
      out[w++] = vertices[i + 4]!;
      out[w++] = vertices[i + 5]!;
    }
    this.debugSegmentsDrawn = w / 6;

    const pos = lines.geometry.getAttribute('position') as THREE.BufferAttribute;
    if (pos.array !== out) {
      lines.geometry.setAttribute('position', new THREE.BufferAttribute(out, 3));
    } else {
      pos.needsUpdate = true;
    }
    lines.geometry.setDrawRange(0, w / 3);
    this.updateDebugTrimeshes(dt);

    const el = this.debugFpsEl;
    if (!el) return;
    this.debugFpsAcc += dt;
    this.debugFpsFrames += 1;
    if (this.debugFpsAcc >= 0.25) {
      const fps = this.debugFpsFrames / this.debugFpsAcc;
      const ms = (this.debugFpsAcc / this.debugFpsFrames) * 1000;
      this.debugFpsShown = Math.round(fps);
      el.textContent = `FPS ${this.debugFpsShown} | ${ms.toFixed(1)} ms | ${this.debugSegmentsDrawn + this.debugTrimeshSegments} linhas`;
      this.debugFpsAcc = 0;
      this.debugFpsFrames = 0;
    }
  }

  /** Gera no máximo ~4 ms de wireframe de trimesh por frame e libera o que ficou longe. */
  private updateDebugTrimeshes(dt: number) {
    const group = this.debugTrimeshGroup;
    if (!group) return;

    if (this.debugTrimeshQueue.size) {
      const start = performance.now();
      for (const handle of this.debugTrimeshQueue) {
        this.debugTrimeshQueue.delete(handle);
        this.buildDebugTrimesh(handle);
        if (performance.now() - start > 4) break;
      }
    }

    this.debugEvictAcc += dt;
    if (this.debugEvictAcc < 1) return;
    this.debugEvictAcc = 0;
    const cow = this.cow ? this.cow.body.translation() : null;
    if (!cow) return;
    const evict2 = 600 * 600;
    for (const [handle, entry] of this.debugTrimeshCache) {
      const dx = entry.x - cow.x, dz = entry.z - cow.z;
      if (dx * dx + dz * dz < evict2) continue;
      if (entry.obj) {
        group.remove(entry.obj);
        entry.obj.geometry.dispose();
        this.debugTrimeshSegments -= entry.segs;
      }
      this.debugTrimeshCache.delete(handle);
    }
  }

  /** Constrói o wireframe de um collider trimesh (prédio) e guarda no cache. */
  private buildDebugTrimesh(handle: number) {
    const collider = this.physics.getCollider(handle);
    const group = this.debugTrimeshGroup;
    const mat = this.debugTrimeshMat;
    if (!collider || !group || !mat) return;

    const t = collider.translation();
    const entry = { obj: null as THREE.LineSegments | null, x: t.x, y: t.y, z: t.z, segs: 0 };
    this.debugTrimeshCache.set(handle, entry);

    const verts = collider.vertices();
    const idx = collider.indices();
    if (!verts || !idx || idx.length < 3) return;

    // malhas do tamanho do mapa (terreno): fora, eram o maior custo
    let mnx = Infinity, mnz = Infinity, mxx = -Infinity, mxz = -Infinity;
    for (let i = 0; i < verts.length; i += 3) {
      const x = verts[i]!, z = verts[i + 2]!;
      if (x < mnx) mnx = x;
      if (x > mxx) mxx = x;
      if (z < mnz) mnz = z;
      if (z > mxz) mxz = z;
    }
    if (mxx - mnx > 120 || mxz - mnz > 120) return;

    // malhas com 100 mil triângulos desenhariam milhões de linhas:
    // amostra no máximo 2.000 triângulos por prédio (continua legível).
    const nTri = Math.floor(idx.length / 3);
    const stride = Math.max(1, Math.ceil(nTri / 2000));
    const out = new Float32Array(Math.ceil(nTri / stride) * 18);
    const rot = collider.rotation();
    const identity = Math.abs(rot.w) > 0.99999;
    const qx = rot.x, qy = rot.y, qz = rot.z, qw = rot.w;
    let w = 0;
    const put = (vi: number) => {
      let x = verts[vi]!, y = verts[vi + 1]!, z = verts[vi + 2]!;
      if (!identity) {
        const tx = 2 * (qy * z - qz * y);
        const ty = 2 * (qz * x - qx * z);
        const tz = 2 * (qx * y - qy * x);
        const nx = x + qw * tx + (qy * tz - qz * ty);
        const ny = y + qw * ty + (qz * tx - qx * tz);
        const nz = z + qw * tz + (qx * ty - qy * tx);
        x = nx; y = ny; z = nz;
      }
      out[w++] = x + t.x;
      out[w++] = y + t.y;
      out[w++] = z + t.z;
    };
    for (let tri = 0; tri < nTri; tri += stride) {
      const a = idx[tri * 3]! * 3;
      const b = idx[tri * 3 + 1]! * 3;
      const c = idx[tri * 3 + 2]! * 3;
      put(a); put(b);
      put(b); put(c);
      put(c); put(a);
    }
    if (!w) return;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(out.subarray(0, w), 3));
    const obj = new THREE.LineSegments(geo, mat);
    obj.frustumCulled = false;
    obj.renderOrder = 999;
    group.add(obj);
    entry.obj = obj;
    entry.segs = w / 6;
    this.debugTrimeshSegments += entry.segs;
  }

  private openNetMenu() {
    document.getElementById('gamemenu')!.style.display = 'none';
    document.getElementById('netmenu')!.style.display = 'flex';
    const nameEl = document.getElementById('netName') as HTMLInputElement;
    if (!nameEl.value) nameEl.value = 'Vaca-' + Math.floor(1000 + Math.random() * 9000);
    const palette = [0xff5555, 0x55aaff, 0x55dd55, 0xffcc00, 0xcc66ff, 0xff8800];
    this.net.myColor = palette[Math.floor(Math.random() * palette.length)];
    this.net.mySkin = getSelectedId();
    this.renderNetList();
  }

  private closeNetMenu() {
    document.getElementById('netmenu')!.style.display = 'none';
    document.getElementById('gamemenu')!.style.display = 'flex';
    this.refreshMenuWallet();
  }

  private openSkinMenu() {
    document.getElementById('gamemenu')!.style.display = 'none';
    document.getElementById('lockscreen')!.style.display = 'none';
    document.getElementById('netmenu')!.style.display = 'none';
    document.getElementById('configmenu')!.style.display = 'none';
    document.getElementById('gadgetmenu')!.style.display = 'none';
    const start = document.getElementById('start');
    if (start) start.style.display = 'flex';
    document.getElementById('skinmenu')!.style.display = 'flex';
    // no meio do jogo solta o mouse pra clicar na loja
    if (this.started && document.pointerLockElement) {
      try {
        document.exitPointerLock();
      } catch { /* ignora */ }
    }
    this.renderSkins();
  }

  private openGadgetMenu() {
    for (const id of ['gamemenu', 'lockscreen', 'netmenu', 'configmenu', 'skinmenu']) {
      document.getElementById(id)!.style.display = 'none';
    }
    const start = document.getElementById('start');
    if (start) start.style.display = 'flex';
    document.getElementById('gadgetmenu')!.style.display = 'flex';
    this.renderGadgets();
  }

  private closeGadgetMenu() {
    document.getElementById('gadgetmenu')!.style.display = 'none';
    if (this.started) {
      document.getElementById('start')!.style.display = 'none';
    } else {
      document.getElementById('gamemenu')!.style.display = 'flex';
      this.refreshMenuWallet();
    }
  }

  private renderGadgets() {
    const listEl = document.getElementById('gadgetlist');
    if (!listEl) return;
    listEl.innerHTML = this.GADGETS.map((id) => {
      const info = this.GADGET_INFO[id]!;
      const sel = this.loadGadget() === id;
      const btn = sel
        ? '<span class="sel">EM USO ✅</span>'
        : `<button data-gadget="${id}">USAR</button>`;
      return `<div class="skinrow"><span class="swatch">${info.icon}</span><span class="sname">${info.name}<br><small>${info.desc}</small></span>${btn}</div>`;
    }).join('');
    listEl.querySelectorAll('[data-gadget]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = (b as HTMLElement).dataset['gadget'] ?? 'sela';
        if (id === 'jetpack' || id === 'biblia') this.setGadget(id);
        else this.setGadget('sela');
        this.renderGadgets();
      });
    });
  }
  private closeSkinMenu() {
    document.getElementById('skinmenu')!.style.display = 'none';
    if (this.started) {
      // estava jogando: só fecha a loja e volta pro jogo
      document.getElementById('start')!.style.display = 'none';
    } else {
      document.getElementById('gamemenu')!.style.display = 'flex';
      this.refreshMenuWallet();
    }
  }

  /** Aplica a skin escolhida na hora (vale no meio do jogo). */
  private applySelectedSkin() {
    const id = getSelectedId();
    this.cow.setSkin(skinById(id));
    this.net.mySkin = id;
  }

  private renderSkins() {
    const listEl = document.getElementById('skinlist');
    const walletEl = document.getElementById('skinwallet');
    const errEl = document.getElementById('skinError');
    if (!listEl || !walletEl) return;
    if (errEl) errEl.textContent = '';
    const wallet = getWallet();
    const owned = getOwned();
    const selected = getSelectedId();
    walletEl.textContent = `🪙 Carteira: ${wallet} DINCOW`;
    listEl.innerHTML = SKINS.map((s) => {
      const has = owned.includes(s.id);
      const sel = selected === s.id;
      const btn = sel
        ? '<span class="sel">EM USO ✅</span>'
        : has
          ? `<button data-sel="${s.id}">USAR</button>`
          : `<button data-buy="${s.id}">🪙 ${s.price}</button>`;
      return `<div class="skinrow"><span class="swatch" style="background:#${s.tint.toString(16).padStart(6, '0')}"></span><span class="sname">${s.name}</span>${btn}</div>`;
    }).join('');
    listEl.querySelectorAll('[data-buy]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = (b as HTMLElement).dataset['buy'] ?? '';
        const skin = skinById(id);
        if (!spendDincow(skin.price)) {
          if (errEl) errEl.textContent = 'DINCOW insuficiente! Jogue pra ganhar 🪙';
          return;
        }
        addOwned(id);
        setSelectedId(id);
        playSfx('coin');
        this.applySelectedSkin();
        this.renderSkins();
      });
    });
    listEl.querySelectorAll('[data-sel]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        setSelectedId((b as HTMLElement).dataset['sel'] ?? 'comum');
        playSfx('click');
        this.applySelectedSkin();
        this.renderSkins();
      });
    });
  }

  /** Volta pro menu (sai da sala se estiver online). */
  private exitToMenu() {
    if (this.netActive) this.leaveNet();
    if (this.cowAI) { this.cowAI.stop(); this.cowAI = null; }
    this.started = false;
    if (document.pointerLockElement) {
      try {
        document.exitPointerLock();
      } catch { /* ignora */ }
    }
    for (const id of ['hud', 'controls', 'mission', 'scores', 'leaveBtn', 'touchui', 'mousehint']) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }
    const start = document.getElementById('start');
    if (start) start.style.display = 'flex';
    document.getElementById('gamemenu')!.style.display = 'flex';
    document.getElementById('netmenu')!.style.display = 'none';
    document.getElementById('skinmenu')!.style.display = 'none';
    document.getElementById('configmenu')!.style.display = 'none';
    document.getElementById('gadgetmenu')!.style.display = 'none';
    this.refreshMenuWallet();
    const netPlay = document.getElementById('netPlay');
    if (netPlay) netPlay.style.display = 'none';
  }

  private joining = false;

  private async joinNetRoom() {
    if (this.joining) return;
    const nameEl = document.getElementById('netName') as HTMLInputElement;
    const codeEl = document.getElementById('netRoom') as HTMLInputElement;
    if (!codeEl.value.trim() && !this.net.roomCode) {
      document.getElementById('netError')!.textContent = 'Digite o código da sala!';
      return;
    }
    const name = nameEl.value;
    const code = codeEl.value.trim() || this.net.roomCode;
    const err = document.getElementById('netError')!;
    this.joining = true;
    try {
      await this.net.join(code, name || 'Jimmy', this.net.myColor);
      // atualiza a lista ao vivo (antes mesmo de clicar JOGAR)
      this.net.onPeers = () => this.renderNetList();
      document.getElementById('netPlay')!.style.display = 'block';
      document.getElementById('netRetry')!.style.display = 'block';
      err.textContent = 'Sala: ' + this.net.roomCode + ' — chame os amigos!';
      this.renderNetList();
    } catch {
      err.textContent = 'Falha ao entrar. Tente de novo.';
    } finally {
      this.joining = false;
    }
  }

  private renderNetList() {
    const el = document.getElementById('netplayerlist');
    if (!el) return;
    const list = this.net.scoreboard(this.score);
    const others = list.filter((p) => !p.me);
    const dbg = this.net.debugStatus();
    let html = `<div>Sala: <b>${this.net.roomCode}</b> 🌐${list.length}</div>`;
    html += `<div style="font-size:13px;color:#999">📡 sinal ${dbg.trackersOpen}/${dbg.trackersTotal} · direto ${dbg.peers} · relay ${dbg.relay ? 'sim' : 'não'} · vistos ${dbg.known}</div>`;
    html += list.map((p) =>
      `<div style="color:#${p.color.toString(16).padStart(6, '0')}">${cleanName(p.name, 'Vaca')}${p.me ? ' (você)' : ''}</div>`,
    ).join('');
    if (others.length === 0) {
      html += '<div style="color:#ffcc00">🔍 Procurando jogadores...<br>Confira se o código é igual nos dois e aguarde até 1 min.</div>';
    } else {
      html += '<div style="color:#7fff7f">✅ Conectado! Cliquem JOGAR ONLINE nos dois.</div>';
    }
    const hint = this.net.dropHint();
    if (hint) html += `<div style="color:#ff8855">${hint}</div>`;
    el.innerHTML = html;
  }

  private beginPlay(multiplayer: boolean, withAI = false) {
    const start = document.getElementById('start');
    if (start) start.style.display = 'none';
    document.getElementById('hud')!.style.display = 'block';
    document.getElementById('controls')!.style.display = 'block';
    document.getElementById('mission')!.style.display = 'block';
    this.started = true;
    // modo IA: a vaca preta e verde que conversa por voz
    if (withAI && !this.cowAI) {
      this.cowAI = new CowAI(this.scene, this.physics);
      this.cowAI.onSay = (t) => this.showMessage(`CowAI: ${t}`);
      this.cowAI.onLog = (t) => console.log('[cowai]', t);
      this.cowAI.onDeliver = () => {
        this.score += 8;
        this.chaos = Math.min(100, this.chaos + 4);
        this.missions.event('knock');
        this.showMessage('CowAI trouxe um suéter! +8 DINCOW');
      };
      this.cowAI.start(this.cow.group.position);
    }
    // teclado/controle/touch limpos ao começar + sela equipada
    this.input.keys = {};
    this.input.joyF = 0;
    this.input.joyS = 0;
    this.input.takePadDelta();
    this.setGadget(this.loadGadget());
    this.netActive = multiplayer && this.net.connected;
    // skin escolhida na loja (vale pra vaca local e pros amigos verem)
    const mySkin = getSelectedId();
    this.cow.setSkin(skinById(mySkin));
    this.net.mySkin = mySkin;
    if (this.netActive) {
      document.getElementById('leaveBtn')!.style.display = 'block';
      this.net.onCowState((s: CowNetState, peerId: string) => {
        let rc = this.remoteCows.get(peerId);
        if (!rc) {
          const prof = this.net.profileOf(peerId);
          rc = new RemoteCow(this.scene, prof ? cleanName(prof.name, 'Vaca') : '?', prof ? prof.color : 0xffffff, prof && typeof prof.skin === 'string' ? prof.skin : 'comum');
          rc.group.position.set(s.x, s.y - COW_HALF_H, s.z);
          rc.target.set(s.x, s.y - COW_HALF_H, s.z);
          this.remoteCows.set(peerId, rc);
          this.showMessage((prof ? cleanName(prof.name, 'Alguém') : 'Alguém') + ' entrou! 🐄');
        }
        rc.setState(s);
        const prof2 = this.net.profileOf(peerId);
        if (prof2 && typeof prof2.skin === 'string') rc.setSkin(prof2.skin);
        this.net.updateScore(peerId, s.score);
      });
      this.net.onRemoteLeave = (peerId: string) => {
        const rc = this.remoteCows.get(peerId);
        if (rc) {
          rc.dispose(this.scene);
          this.remoteCows.delete(peerId);
          this.showMessage('Jogador saiu 👋');
        }
      };
      this.net.onPeers = () => this.renderNetList();
      this.net.onEvent = (e, rawName) => {
        const fromName = cleanName(rawName, 'Vaca');
        if (e.type === 'boom') {
          this.spawnParticles(e.x, e.y, e.z, 12, 0xff6600);
          playSfx('boom');
          this.showMessage(fromName + ': ' + e.text);
        } else if (e.type === 'hit') {
          // cabeçada PvP: só aplica se fui o alvo e estou perto do golpe
          if (typeof e.target !== 'string' || e.target !== this.net.id) return;
          const t = this.cow.body.translation();
          let dx = t.x - e.x;
          let dz = t.z - e.z;
          if (Math.hypot(dx, dz) >= 5) return;
          if (Math.hypot(dx, dz) < 0.001) {
            const a = Math.random() * Math.PI * 2;
            dx = Math.cos(a);
            dz = Math.sin(a);
          }
          const push = this._push.set(dx, 0, dz).normalize().multiplyScalar(120);
          this.cow.body.applyImpulse({ x: push.x, y: 80, z: push.z }, true);
          this.showMessage(fromName + ' te deu CABECADA!');
          this.spawnParticles(t.x, t.y + 1, t.z, 8, 0xff4444);
          this.input.rumble(1, 0.7, 300);
        }
      };
    }
    this.input.requestLock();
    resumeAudio();
    playSfx('moo');
    this.showMessage('BOA SORTE!');
  }

  private leaveNet() {
    void this.net.leave();
    for (const rc of this.remoteCows.values()) rc.dispose(this.scene);
    this.remoteCows.clear();
    this.netActive = false;
    document.getElementById('leaveBtn')!.style.display = 'none';
    document.getElementById('scores')!.style.display = 'none';
    document.getElementById('netPlay')!.style.display = 'none';
    document.getElementById('netRetry')!.style.display = 'none';
    this.showMessage('Saiu da sala.');
  }

  private showMessage(_text: string) {
    // popup do centro da tela removido (atrapalhava a visão)
  }

  private updateHUD() {
    document.getElementById('score')!.textContent = String(this.score);
    const padstat = document.getElementById('padstat');
    if (padstat) padstat.textContent = this.input.padConnected ? '🎮' : '';
    const gadgetEl = document.getElementById('gadget-status');
    if (gadgetEl) gadgetEl.textContent = this.gadgetHint();
    // tudo que ganhou vira DINCOW na carteira (persistente, gasta na loja)
    const gain = this.score - this.lastScore;
    if (gain > 0) addDincow(gain);
    this.lastScore = this.score;
    const fill = document.getElementById('chaos-fill');
    if (fill) fill.style.width = this.chaos + '%';
    document.getElementById('chaos-pct')!.textContent = Math.round(this.chaos) + '%';

    let status = '';
    const cx = this.cow.group.position.x;
    const cz = this.cow.group.position.z;
    if (this.carrying) {
      status = 'Carregando! [E] Canhao | [F] Soltar';
    } else if (Math.hypot(this.world.skinShop.x - cx, this.world.skinShop.z - cz) < 7) {
      status = '[E] Loja de skins 🐐';
    } else {
      const nearCannon = this.world.cannons.some((c) =>
        Math.hypot(c.x - cx, c.z - cz) < 10 && c.loadedNPC !== null);
      const emptyCannon = this.world.cannons.some((c) =>
        Math.hypot(c.x - cx, c.z - cz) < 10 && c.loadedNPC === null);
      const nearNPC = this.npcs.some((n) =>
        (n.state === 'walk' || n.state === 'stunned' || n.state === 'fallen') &&
        Math.hypot(n.body.translation().x - cx, n.body.translation().z - cz) < 10);
      if (nearCannon) status = '[E] DISPARAR canhao!';
      else if (emptyCannon) status = 'Canhao vazio - pegue alguem [E]';
      else if (nearNPC) status = '[E] Pegar pessoa';
    }
    document.getElementById('carry-status')!.textContent = status;

    const hint = document.getElementById('mousehint');
    if (hint) hint.style.display = (this.started && !this.input.mouseLocked && !this.input.isTouch) ? 'block' : 'none';

    const touchui = document.getElementById('touchui');
    if (touchui) touchui.style.display = (this.started && this.input.isTouch) ? 'block' : 'none';

    const sb = document.getElementById('scores');
    if (sb) {
      if (this.netActive) {
        sb.style.display = 'block';
        const board = this.net.scoreboard(this.score);
        sb.innerHTML = '<b>🏆 Sala ' + this.net.roomCode + ' 🌐' + board.length + '</b><br>' + board
          .map((p) => `<span style="color:#${p.color.toString(16).padStart(6, '0')}">${p.name}: ${p.score}</span>`)
          .join('<br>');
        const hint = this.net.dropHint();
        if (hint) sb.innerHTML += `<br><span style="font-size:12px;color:#ff8855">${hint}</span>`;
      } else {
        sb.style.display = 'none';
      }
    }

    const mp = document.getElementById('mission');
    if (mp) {
      const m = this.missions.current();
      if (!m) {
        mp.innerHTML = '🏆 <b>Todas as missões completas!</b><br><span>Modo livre: cause caos!</span>';
      } else {
        let prog: string;
        if (m.id === 'fama') prog = `${Math.min(this.score, m.target)}/${m.target} pts`;
        else if (m.id === 'passeio') prog = `${Math.floor(this.missions.progress)}/${m.target}s`;
        else prog = `${Math.min(Math.floor(this.missions.progress), m.target)}/${m.target}`;
        mp.innerHTML = `<b>${m.title}</b><br><span>${m.desc}</span><br><span class="mp">${prog}</span>`;
      }
    }
  }

  /** Cria o pool de faíscas: TODAS num único InstancedMesh (1 draw call, 1 geometria). */
  private initParticles() {
    const im = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.12, 0.12, 0.12),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
      this.P_MAX,
    );
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.frustumCulled = false;
    im.castShadow = false;
    im.receiveShadow = false;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    this._pCol.setHex(0xffffff);
    for (let i = 0; i < this.P_MAX; i++) {
      im.setMatrixAt(i, zero);
      im.setColorAt(i, this._pCol);
      this.pData.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0 });
    }
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    this.particleIM = im;
    this.scene.add(im);
  }

  /** Emite faíscas reciclando slots do pool (nenhuma geometria/mesh é criada). */
  private spawnParticles(x: number, y: number, z: number, n: number, color = 0xffcc32) {
    const im = this.particleIM;
    if (!im) return;
    this._pCol.setHex(color);
    for (let i = 0; i < n; i++) {
      const idx = this.pCursor;
      this.pCursor = (this.pCursor + 1) % this.P_MAX;
      const d = this.pData[idx]!;
      d.x = x; d.y = y; d.z = z;
      d.vx = (Math.random() - 0.5) * 0.3;
      d.vy = Math.random() * 0.2 + 0.1;
      d.vz = (Math.random() - 0.5) * 0.3;
      d.life = 30 + Math.random() * 30;
      im.setColorAt(idx, this._pCol);
    }
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
  }

  private randomMsg(): string {
    const msgs = [
      'BOOOM!', 'CABECADA!', 'MIIINHU!', 'CRASH!', 'WALL RUN!', 'AAAAH!', 'SOCO NAS COSTAS!', 'PFWEEE!', 'DERROUBOU!',
    ];
    return msgs[Math.floor(Math.random() * msgs.length)];
  }

  private doInteract() {
    const cx = this.cow.group.position.x;
    const cz = this.cow.group.position.z;

    // dentro do carro: [E] desce
    if (this.ridingCar) {
      this.exitCar();
      return;
    }

    // loja de skins do usuário: abre perto dela (vale carregando ou não)
    if (Math.hypot(this.world.skinShop.x - cx, this.world.skinShop.z - cz) < 7) {
      this.openSkinMenu();
      return;
    }

    // bíblia: levita a pessoa pra sempre (E num levitando pega de volta)
    if (this.gadget === 'biblia' && !this.carrying) {
      let bestB: NPCPhysics | null = null;
      let bestDistB = 10;
      for (const n of this.npcs) {
        if (n.vendor) continue;
        if (n.state !== 'walk' && n.state !== 'stunned' && n.state !== 'fallen' && n.state !== 'levitate') continue;
        const t = n.body.translation();
        const d = Math.hypot(t.x - cx, t.z - cz);
        if (d < bestDistB) {
          bestDistB = d;
          bestB = n;
        }
      }
      if (bestB) {
        if (bestB.state === 'levitate') {
          // pega de volta quem estava flutuando
          this.carrying = bestB;
          this.setNPCState(bestB, 'carried');
        } else {
          const t = bestB.body.translation();
          this.setNPCState(bestB, 'levitate');
          bestB.levT = 0;
          bestB.body.setLinvel({ x: 0, y: 2, z: 0 }, true);
          this.spawnParticles(t.x, t.y + 1, t.z, 12, 0xffe97a);
        }
        return;
      }
    }

    // carro colado na vaca: entra nele (tem prioridade sobre pegar NPC)
    if (!this.carrying) {
      let nearCar: (typeof this.world.cars)[number] | null = null;
      // raio generoso: o carro anda 12m/s, a vaca pula pra dentro de longe
      let carDist = 9;
      for (const c of this.world.cars) {
        const d = Math.hypot(c.mesh.position.x - cx, c.mesh.position.z - cz);
        if (d < carDist) { carDist = d; nearCar = c; }
      }
      if (nearCar) {
        this.enterCar(nearCar);
        return;
      }
    }

    if (this.carrying) {
      const near = this.world.cannons.find((c) => Math.hypot(c.x - cx, c.z - cz) < 10);
      if (near) {
        // se o canhao ja tem alguem, tira o antigo antes (vira fallen, continua pegavel)
        if (near.loadedNPC !== null) {
          const old = this.npcs.find((n) => n.id === near.loadedNPC);
          if (old) {
            this.setNPCState(old, 'fallen');
            old.stateTimer = 4;
            old.body.setTranslation({ x: near.x + 2, y: 1.5, z: near.z + 2 }, true);
          }
        }
        near.loadedNPC = this.carrying.id;
        this.missions.event('load');
        this.setNPCState(this.carrying, 'inCannon');
        this.carrying.body.setTranslation({ x: near.x, y: 2, z: near.z - 2 }, true);
        this.carrying.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        this.carrying = null;
        this.showMessage('Colocado no canhao! E de novo pra atirar!');
        return;
      }
      this.dropCarried();
      return;
    }

    // canhao carregado -> disparar
    const loadedCannon = this.world.cannons.find((c) =>
      c.loadedNPC !== null && Math.hypot(c.x - cx, c.z - cz) < 10);
    if (loadedCannon) {
      const npc = this.npcs.find((n) => n.id === loadedCannon.loadedNPC);
      if (npc) {
        this.setNPCState(npc, 'launched');
        npc.body.setLinvel({ x: 0, y: 12, z: -8 }, true);
        npc.body.setAngvel({ x: 2, y: 0, z: 0 }, true);
        loadedCannon.loadedNPC = null;
        this.missions.event('fire');
        if (this.netActive) {
          const nt = npc.body.translation();
          this.net.sendBoom('BOOOM!', nt.x, nt.y, nt.z);
        }
        this.score += 15;
        playSfx('boom');
        this.chaos = Math.min(100, this.chaos + 25);
        this.showMessage('BOOOM!');
        this.spawnParticles(npc.body.translation().x, npc.body.translation().y, npc.body.translation().z, 15, 0xff6600);
      }
      return;
    }

    // pegar pessoa (vale andando, atordoada ou caida — menos o vendedor)
    let best: NPCPhysics | null = null;
    let bestDist = 10;
    for (const n of this.npcs) {
      if (n.vendor) continue;
      if (n.state !== 'walk' && n.state !== 'stunned' && n.state !== 'fallen') continue;
      const t = n.body.translation();
      const d = Math.hypot(t.x - cx, t.z - cz);
      if (d < bestDist) {
        bestDist = d;
        best = n;
      }
    }
    if (best) {
      this.carrying = best;
      this.setNPCState(best, 'carried');
      this.npcFactory.complain(best, 'PUT ME DOWN!!');
      this.showMessage('Pegou! E no canhao!');
    }
  }

  /** Entra no carro: a vaca vira passageira (some do visual, sem colisão). */
  private enterCar(car: (typeof this.world.cars)[number]): void {
    this.ridingCar = car;
    this.cow.group.visible = false;
    this.cow.setGhost(true);
    this.cow.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.showMessage('Entrou no carro! [E] pra descer');
    playSfx('click');
  }

  /** Desce do carro (ao lado dele). */
  private exitCar(): void {
    const car = this.ridingCar;
    if (!car) return;
    this.ridingCar = null;
    this.cow.group.visible = true;
    this.cow.setGhost(false);
    const m = car.mesh;
    // desce pro lado (perpendicular à direção do carro)
    const dirX = car.axis === 'z' ? 0 : car.dir;
    const dirZ = car.axis === 'z' ? car.dir : 0;
    const sideX = -dirZ;
    const sideZ = dirX;
    this.cow.body.setTranslation({
      x: m.position.x + sideX * 4.5,
      y: m.position.y + 5,
      z: m.position.z + sideZ * 4.5,
    }, true);
    this.cow.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.showMessage('Desceu do carro!');
    playSfx('click');
  }

  private dropCarried() {
    if (!this.carrying) return;
    const npc = this.carrying;
    this.setNPCState(npc, 'stunned');
    npc.stateTimer = 4;
    const v = this.cow.body.linvel();
    npc.body.setLinvel({ x: v.x, y: 2, z: v.z }, true);
    this.carrying = null;
    this.showMessage('Soltou!');
  }

  /** Vingança: cabeçada conta; 5x apaga pra sempre, senão cai>levanta>corre>chuta>encara. */
  private registerHit(n: NPCPhysics): void {
    if (n.vendor || n.outCold) return;
    n.hits++;
    n.revenge = true;
    if (n.hits >= 5) {
      n.outCold = true;
      this.setNPCState(n, 'fallen');
      n.stateTimer = 9999;
      return;
    }
    this.setNPCState(n, 'fallen');
    n.stateTimer = 2.5;
  }

  private setNPCState(npc: NPCPhysics, state: NPCPhysics['state'], timer = 0) {
    npc.state = state;
    npc.stateTimer = timer;
    this.npcFactory.playForState(npc);
    // dentro do canhao some (em vez de ficar andando em cima do tubo)
    npc.mesh.visible = state !== 'inCannon';
    // carregando/no canhao vira sensor: nao engancha nas paredes nem empurra a vaca
    npc.collider.setSensor(state === 'carried' || state === 'inCannon');
    // desbloqueia rotacao quando nao está andando normal
    if (state !== 'walk') {
      npc.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

  /** Aparelhos das costas: sela (pegar gente), jetpack (voar), bíblia (levitar). */
  private gadget: 'sela' | 'jetpack' | 'biblia' = 'sela';
  private readonly GADGETS = ['sela', 'jetpack', 'biblia'] as const;
  private readonly GADGET_INFO: Record<string, { name: string; icon: string; desc: string }> = {
    sela: { name: 'Sela', icon: '🐄', desc: 'pegar gente no colo' },
    jetpack: { name: 'Jetpack Atômico', icon: '🚀', desc: 'segure ESPAÇO pra voar' },
    biblia: { name: 'Bíblia', icon: '📖', desc: 'levita a pessoa pra sempre' },
  };

  private loadGadget(): 'sela' | 'jetpack' | 'biblia' {
    try {
      const id = window.localStorage.getItem('cowrampage.gadget') ?? 'sela';
      if (id === 'jetpack' || id === 'biblia') return id;
    } catch { /* padrão */ }
    return 'sela';
  }

  private setGadget(g: 'sela' | 'jetpack' | 'biblia') {
    if (this.gadget !== g) playSfx('click');
    this.gadget = g;
    try {
      window.localStorage.setItem('cowrampage.gadget', g);
    } catch { /* ignora */ }
    this.cow.setGadgetVisual(g);
    if (g !== 'jetpack') this.cow.setFlame(false);
  }

  private cycleGadget(dir: number) {
    const i = this.GADGETS.indexOf(this.gadget);
    const n = this.GADGETS[(i + dir + this.GADGETS.length) % this.GADGETS.length]!;
    this.setGadget(n);
  }

  private gadgetHint(): string {
    if (this.gadget === 'jetpack') return '🎒 Jetpack · segure ESPAÇO/PULAR pra voar';
    if (this.gadget === 'biblia') return '🎒 Bíblia · [E] levita a pessoa pra sempre';
    return '🎒 Sela (1/2/3 troca) · [E] pegar gente';
  }

  private cowAttack() {
    const cx = this.cow.group.position.x;
    const cz = this.cow.group.position.z;
    for (const n of this.npcs) {
      if ((n.state !== 'walk' && n.state !== 'stare' && n.state !== 'revenge' && n.state !== 'attack') || n.vendor) continue;
      const t = n.body.translation();
      const dx = t.x - cx;
      const dz = t.z - cz;
      const d = Math.hypot(dx, dz);
      if (d < 5) {
        this.registerHit(n);
        this.npcFactory.complain(n);
        const push = this._push.set(dx, 0, dz).normalize().multiplyScalar(170);
        n.body.applyImpulse({ x: push.x, y: 120, z: push.z }, true);
        playSfx('thud');
        this.score += 3;
        this.chaos = Math.min(100, this.chaos + 5);
        this.missions.event('headbutt');
        this.missions.event('knock');
        if (this.netActive) this.net.sendBoom('CABECADA!', t.x, t.y + 1, t.z);
        this.showMessage('CABECADA!');
        this.spawnParticles(t.x, t.y + 1, t.z, 8, 0xff4444);
        this.input.rumble(1, 0.5, 200);
      }
    }
    // PvP: cabeçada pega nas vacas dos amigos (hitbox = raio 5 na posição sincronizada)
    // e na vaca da IA (mesma física: ela voa, cai e reclama)
    if (this.cowAI) {
      const av = this.cowAI.cow.body.translation();
      const ad = Math.hypot(av.x - cx, av.z - cz);
      if (ad < 5 && Math.abs(av.y - this.cow.body.translation().y) < 4) {
        const l = Math.hypot(av.x - cx, av.z - cz) || 1;
        this.cowAI.cow.body.applyImpulse({
          x: ((av.x - cx) / l) * 150,
          y: 110,
          z: ((av.z - cz) / l) * 150,
        }, true);
        playSfx('thud');
        this.showMessage('CABECADA no CowAI!');
        this.spawnParticles(av.x, av.y + 1, av.z, 10, 0x39ff5a);
        this.input.rumble(1, 0.6, 250);
        this.score += 3;
        this.chaos = Math.min(100, this.chaos + 4);
        this.missions.event('headbutt');
      }
    }
    if (this.netActive) {
      for (const [peerId, rc] of this.remoteCows) {
        const dx = rc.target.x - cx;
        const dz = rc.target.z - cz;
        if (Math.hypot(dx, dz) < 5) {
          this.net.sendHit(peerId, cx, cz);
          this.score += 3;
          this.chaos = Math.min(100, this.chaos + 5);
          this.missions.event('headbutt');
          this.showMessage('CABECADA no ' + rc.name + '!');
          this.spawnParticles(rc.target.x, rc.target.y + 1, rc.target.z, 8, 0xff4444);
          this.input.rumble(1, 0.5, 200);
        }
      }
    }
  }

  private updateCow(dt: number) {
    const running = this.input.isDown('ShiftLeft', 'ShiftRight');
    const speed = running ? 11 : 6;
    const thrusting = this.gadget === 'jetpack' && this.input.isDown('Space');
    if (this.coastT > 0) this.coastT -= dt;

    // CAÍDA ALTA: de barriga pra cima, balançando de um lado pro outro.
    // Controles travados (só freia); levanta sozinha ou apertando pular.
    if (this.cow.bellyUp) {
      const b = this.cow.body;
      const v = b.linvel();
      const f = Math.max(0, 1 - dt * 4);
      b.setLinvel({ x: v.x * f, y: v.y, z: v.z * f }, true);
      if (this.cow.bellyUpT < 1.4 && this.input.consumeOnce('Space')) {
        this.cow.getUp();
        this.input.rumble(0.6, 0.4, 150);
      }
      this.cow.syncMesh();
      this.cow.update(dt, 0, false);
      this.updateCarried(dt);
      return;
    }

    const fwd = this._fwd.set(Math.sin(this.camYaw), 0, Math.cos(this.camYaw));
    const rgt = this._rgt.set(Math.cos(this.camYaw), 0, -Math.sin(this.camYaw));
    const move = this._move.set(0, 0, 0);
    if (this.input.isDown('KeyW', 'ArrowUp')) move.add(fwd);
    if (this.input.isDown('KeyS', 'ArrowDown')) move.sub(fwd);
    if (this.input.isDown('KeyA', 'ArrowLeft')) move.add(rgt);
    if (this.input.isDown('KeyD', 'ArrowRight')) move.sub(rgt);
    // joystick virtual (analógico)
    if (this.input.joyF !== 0 || this.input.joyS !== 0) {
      move.addScaledVector(fwd, this.input.joyF).addScaledVector(rgt, -this.input.joyS);
    }

    const body = this.cow.body;
    const currentVel = body.linvel();
    const t = body.translation();

    const inWater = !this.onBridge(t.x, t.z) && !this.world.isOnIsland(t.x, t.z, -2);
    if (this.cow.stunT > 0) {
      // atordoada (chute!): desliza sem controle e quase sem freio
      this.cow.stunT -= dt;
      const f = Math.max(0, 1 - dt * 1.5);
      body.setLinvel({ x: currentVel.x * f, y: currentVel.y, z: currentVel.z * f }, true);
    } else if (move.length() > 0) {
      // normaliza só se passar de 1 (preserva a força do joystick analógico)
      if (move.length() > 1) move.normalize();
      move.multiplyScalar(speed);
      if (this.coastT > 0) {
        // no embalo do foguete, o input dirige sem matar a velocidade (mistura)
        const blendM = Math.min(1, dt * 1.5);
        body.setLinvel({
          x: currentVel.x + (move.x - currentVel.x) * blendM,
          y: currentVel.y,
          z: currentVel.z + (move.z - currentVel.z) * blendM,
        }, true);
      } else {
        // velocidade em m/s (sem escalar por dt: fisica usa timestep fixo)
        body.setLinvel({ x: move.x, y: currentVel.y, z: move.z }, true);
      }
      this.cow.yaw = Math.atan2(move.x, move.z);
    } else if (!thrusting) {
      // sem input: freio forte normal; mas no embalo do foguete é quase nada
      // de arrasto (desliza muito até parar)
      const coasting = this.coastT > 0;
      const f = Math.max(0, 1 - dt * (coasting ? 0.35 : 12));
      body.setLinvel({ x: currentVel.x * f, y: currentVel.y, z: currentVel.z * f }, true);
    }

    // nado: SÓ BOIA — a física de água só age quando a vaca está NA água
    // (perto da linha). Voando/pulando por cima, é física normal de ar.
    if (inWater && t.y <= 1.6) {
        if (!this.wasSwimming) {
          // entrou na água: só um splash (sem travar/sugar nada)
          this.wasSwimming = true;
          playSfx('splash');
          this.spawnParticles(t.x, 0.2, t.z, 12, 0x3a8fcf);
        this.input.rumble(0.4, 0.3, 150);
      }
      const cw = body.translation();
      const wv = body.linvel();
      if (wv.y <= 4) {
        // Empuxo natural: a GRAVIDADE CONTINUA (o motor aplica -9.81); a boia
        // cresce conforme a vaca submerge e a água amortece o movimento.
        // Equilíbrio em ~y 0.3 (uns 60% do corpo na água) com balanço suave.
        const KP = 22;   // força do empuxo
        const KD = 4.5;  // arrasto linear (deixa balançar)
        const KQ = 0.35; // arrasto quadrático (segura queda forte sem afundar)
        const sub = 0.75 - cw.y; // >0 = submersa
        const acc = KP * sub - KD * wv.y - KQ * wv.y * Math.abs(wv.y);
        const vy = Math.max(-12, Math.min(8, wv.y + acc * dt));
        body.setLinvel({ x: wv.x, y: vy, z: wv.z }, true);
      }
      // se está subindo (pulo/foguete > 4 m/s), a água não segura
      this.swimSplashT -= dt;
      if (this.swimSplashT <= 0 && Math.hypot(wv.x, wv.z) > 2) {
        this.swimSplashT = 0.3;
        this.spawnParticles(cw.x, 0.2, cw.z, 3, 0x3a8fcf);
      }
    } else {
      this.wasSwimming = false;
    }

    // pulo (na agua vira remada) — com jetpack, ESPAÇO segurao = FOGUETE:
    // sobe E empurra pra frente, na direção da câmera (sem limite: é atômico!)
      this.cow.setFlame(thrusting);
      if (thrusting) {
        this.coastT = 8.0; // ao soltar, desliza ~8s até o freio normal voltar
        this.cow.yaw = this.camYaw;
      const ROCKET = 150; // alvo 10x (o damping da física segura em ~130 m/s)
      const blend = Math.min(1, dt * 3);
      const bv = body.linvel();
      const fx = Math.sin(this.camYaw);
      const fz = Math.cos(this.camYaw);
      body.setLinvel({
        x: bv.x + (fx * ROCKET - bv.x) * blend,
        y: 14,
        z: bv.z + (fz * ROCKET - bv.z) * blend,
      }, true);
      if (Math.random() < 0.5) {
        this.spawnParticles(t.x, t.y - 1, t.z, 2, 0xff8830);
      }
      this.cow.resetJumps();
    }
    const jump = !thrusting && this.input.consumeOnce('Space');
    if (jump) {
        if (inWater) {
          // pulo de verdade na água: dá pra saltar pra fora
          const v = body.linvel();
          body.setLinvel({ x: v.x + fwd.x * 3, y: 9, z: v.z + fwd.z * 3 }, true);
          this.cow.resetJumps();
          playSfx('splash');
          this.spawnParticles(t.x, 0.3, t.z, 6, 0x3a8fcf);
        } else if (this.cow.jumpCount < this.cow.maxJumps) {
          this.cow.applyJump(running ? 10 : 8.5);
          playSfx('jump');
          this.cow.jumpCount++;
        this.spawnParticles(this.cow.group.position.x, 0.1, this.cow.group.position.z, 4, 0xffffff);
      }
    }

    // detecta chao via raycast (exclui o proprio corpo da vaca!)
    const ray = this.downRay ?? (this.downRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 }));
    ray.origin.x = t.x;
    ray.origin.y = t.y;
    ray.origin.z = t.z;
    const hit = this.physics.castRay(ray, 1.1 * COW_SCALE + 0.4, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, this.cow.body);
    const wasGrounded = this.cow.grounded;
    this.cow.grounded = hit !== null && !inWater;
    if (!this.cow.grounded) {
      // guarda a maior velocidade de queda pra medir o tombo no pouso
      this.fallV = Math.max(this.fallV, -currentVel.y);
      // tempo de queda: a gravidade acelera quanto mais tempo se cai
      if (currentVel.y < 0 && !inWater) this.fallT += dt;
      else if (currentVel.y >= 0) this.fallT = 0;
    } else {
        if (!wasGrounded && this.fallV > 16) {
          // caiu de MUITO alto: tomba de barriga pra cima
          this.cow.startBellyUp();
          playSfx('flop');
          this.spawnParticles(t.x, t.y - 1.4, t.z, 18, 0xd9c27a);
        this.input.rumble(1, 0.9, 400);
        if (this.carrying) this.dropCarried();
      }
      this.fallV = 0;
      this.fallT = 0;
      if (!wasGrounded) this.cow.resetJumps();
    }

    if (this.input.isDown('KeyR')) {
      this.showMessage('MORTAL!');
      this.input.keys['KeyR'] = false;
      const v = body.linvel();
      body.setLinvel({ x: v.x, y: Math.max(v.y, 5.5), z: v.z }, true);
      this.cow.startFlip();
    }

    this.cow.syncMesh();
    const lv = body.linvel();
    this.cow.update(dt, Math.hypot(lv.x, lv.z), !this.cow.grounded);
    this.updateCarried(dt);
  }

  private onBridge(x: number, z: number): boolean {
    return x > BRIDGE.x0 - 0.5 && x < BRIDGE.x1 + 0.5 && z > BRIDGE.z0 && z < BRIDGE.z1;
  }

  private updateCarried(dt: number) {
    void dt;
    if (!this.carrying) return;
    const t = this.cow.body.translation();
    const yaw = this.cow.yaw;
    const offset = this._carryOff.set(-Math.sin(yaw) * 0.3, 0, -Math.cos(yaw) * 0.3);
    const target = this._carryTgt.set(t.x + offset.x, t.y + 1.55 * COW_SCALE, t.z + offset.z);
    const body = this.carrying.body;
    const cur = body.translation();
    body.setTranslation({
      x: cur.x + (target.x - cur.x) * 0.4,
      y: cur.y + (target.y - cur.y) * 0.4,
      z: cur.z + (target.z - cur.z) * 0.4,
    }, true);
    body.setLinvel({ x: (target.x - cur.x) * 6, y: (target.y - cur.y) * 6, z: (target.z - cur.z) * 6 }, true);
    this.carrying.mesh.position.set(target.x, target.y - 0.72, target.z);
    this.carrying.mesh.rotation.y = yaw;
  }

  /** Sorteia um destino secreto (nunca na mansão nem nas minas). */
  private pickNPCDestination(n: NPCPhysics): void {
    const t = n.body.translation();
    for (let a = 0; a < 12; a++) {
      const th = Math.random() * Math.PI * 2;
      const rr = 100 + Math.random() * 300;
      const x = t.x + Math.cos(th) * rr;
      const z = t.z + Math.sin(th) * rr;
      if (!this.world.isOnIsland(x, z, 6)) continue;
      if (Math.hypot(x - MINE.x, z - MINE.z) < MINE.r + 10) continue;
      if (Math.hypot(x - MANSION.x, z - MANSION.z) < 70) continue;
      let inB = false;
      for (const b of this.world.buildings) {
        if (Math.abs(x - b.x) < b.halfW + 1 && Math.abs(z - b.z) < b.halfD + 1) { inB = true; break; }
      }
      if (inB) continue;
      n.tx = x;
      n.tz = z;
      return;
    }
    // sem lugar bom: fica onde está e tenta de novo em breve
    n.tx = t.x;
    n.tz = t.z;
  }

  private updateNPCs(dt: number) {
    for (const n of this.npcs) {
      const t = n.body.translation();
      switch (n.state) {
        case 'walk': {
          if (n.vendor) {
            // vendedor não sai do lugar
            const v0 = n.body.linvel();
            n.body.setLinvel({ x: 0, y: v0.y, z: 0 }, true);
            break;
          }
          const v = n.body.linvel();
          const dx = n.tx - t.x;
          const dz = n.tz - t.z;
          const d = Math.hypot(dx, dz);
          if (d < 3) {
            // chegou: novo destino secreto
            this.pickNPCDestination(n);
          } else {
            n.body.setLinvel({ x: (dx / d) * n.speed, y: v.y, z: (dz / d) * n.speed }, true);
            // travou numa parede: desiste e sorteia outro
            if (Math.hypot(v.x, v.z) < n.speed * 0.3 && Math.random() < 0.05) {
              this.pickNPCDestination(n);
            }
          }
          break;
        }
        case 'stunned':
        case 'fallen': {
          if (n.outCold) break; // 5 cabeçadas: chão pra sempre
          if (n.stateTimer > 0) {
            n.stateTimer -= dt;
            if (n.stateTimer <= 0) {
              if (n.revenge) {
                this.setNPCState(n, 'getup');
                n.stateTimer = 1.2;
              } else {
                this.setNPCState(n, 'walk');
              }
              if (!n.vendor) this.pickNPCDestination(n);
              n.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
              n.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
            }
          }
          break;
        }
        case 'getup': {
          // levantando (Standing Up 1x): parado, depois corre pra cima da vaca
          n.body.setLinvel({ x: 0, y: n.body.linvel().y, z: 0 }, true);
          if (n.stateTimer > 0) {
            n.stateTimer -= dt;
            if (n.stateTimer <= 0) this.setNPCState(n, 'revenge');
          } else {
            this.setNPCState(n, 'revenge');
          }
          break;
        }
        case 'revenge': {
          // corre até a vaca (Running) e chuta quando chega perto
          const cwx = this.cow.group.position.x;
          const cwz = this.cow.group.position.z;
          const rdx = cwx - t.x;
          const rdz = cwz - t.z;
          const rd = Math.hypot(rdx, rdz) || 1;
          n.mesh.rotation.y = Math.atan2(rdx, rdz);
          if (rd < 3.2) {
            this.setNPCState(n, 'attack');
            n.stateTimer = 1.1;
            const cv = this.cow.body.linvel();
            this.cow.body.setLinvel({
              x: (rdx / rd) * 10 + cv.x * 0.3,
              y: Math.max(cv.y, 3.5),
              z: (rdz / rd) * 10 + cv.z * 0.3,
            }, true);
            this.cow.stunT = 0.9;
            this.npcFactory.complain(n);
            playSfx('thud');
            this.chaos = Math.min(100, this.chaos + 3);
            this.showMessage('CHUTE!');
            this.spawnParticles(cwx, t.y + 1, cwz, 8, 0xff8830);
            this.input.rumble(1, 0.5, 200);
          } else {
            // chega freando (sem montar na vaca): para a 2.6m e chuta dali
            const v = n.body.linvel();
            const spd = Math.max(0, Math.min(8, (rd - 2.6) * 4));
            n.body.setLinvel({ x: (rdx / rd) * spd, y: v.y, z: (rdz / rd) * spd }, true);
          }
          break;
        }
        case 'attack': {
          // chutando/soca (1x): cravado no lugar, depois encara
          const v = n.body.linvel();
          n.body.setLinvel({ x: 0, y: v.y, z: 0 }, true);
          if (n.stateTimer > 0) {
            n.stateTimer -= dt;
            if (n.stateTimer <= 0) {
              this.setNPCState(n, 'stare');
              n.stateTimer = 8;
            }
          } else {
            this.setNPCState(n, 'stare');
            n.stateTimer = 8;
          }
          break;
        }
        case 'stare': {
          // parado encarando a vaca (pose), depois volta a andar
          const cwx = this.cow.group.position.x;
          const cwz = this.cow.group.position.z;
          n.mesh.rotation.y = Math.atan2(cwx - t.x, cwz - t.z);
          const v = n.body.linvel();
          n.body.setLinvel({ x: 0, y: v.y, z: 0 }, true);
          if (n.stateTimer > 0) {
            n.stateTimer -= dt;
            if (n.stateTimer <= 0) {
              this.setNPCState(n, 'walk');
              if (!n.vendor) this.pickNPCDestination(n);
            }
          }
          break;
        }
        case 'launched': {
          // exclui o proprio corpo: senao "pousa" no ar na hora do disparo
          const lray = this.downRay ?? (this.downRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 }));
          lray.origin.x = t.x;
          lray.origin.y = t.y;
          lray.origin.z = t.z;
          const fall = this.physics.castRay(lray, 1.2, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, n.body);
          if (fall !== null) {
            this.setNPCState(n, 'stunned');
            n.stateTimer = 6;
            n.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
            n.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
            this.score += 3;
            this.chaos = Math.min(100, this.chaos + 3);
            this.showMessage(this.randomMsg());
            this.spawnParticles(t.x, t.y, t.z, 6, 0xffcc32);
          }
          break;
        }
        case 'carried':
        case 'inCannon':
          break;
        case 'levitate': {
          // bíblia: sobe sem parar, ao infinito e além (pra sempre, sem teto)
          n.levT -= dt;
          const lv = n.body.linvel();
          n.body.setLinvel({ x: lv.x * 0.9, y: 5, z: lv.z * 0.9 }, true);
          if (n.levT <= 0) {
            n.levT = 0.4;
            this.spawnParticles(t.x, t.y - 1, t.z, 2, 0xffe97a);
          }
          break;
        }
      }
      // colisao com vaca aproximada (empurrar pessoas)
      const cx = this.cow.group.position.x;
      const cz = this.cow.group.position.z;
      const d = Math.hypot(t.x - cx, t.z - cz);
      if (d < 2.4 && this.carrying !== n && !n.vendor && n.state === 'walk') {
        this.setNPCState(n, 'stunned');
        this.npcFactory.complain(n);
        n.stateTimer = 3;
        n.body.setLinvel({ x: (t.x - cx) * 3, y: 3, z: (t.z - cz) * 3 }, true);
        this.score += 2;
        this.chaos = Math.min(100, this.chaos + 2);
        this.missions.event('knock');
      }
      this.npcFactory.syncMesh(n);
      this.npcFactory.tickSay(n, dt);
      this.npcFactory.tickAnim(n, dt);
      // afogado (ex.: lançado pelo canhão na água): volta pra ilha principal
      // (levitando nunca afoga)
      if (t.y < 0.5 && n.state !== 'carried' && n.state !== 'inCannon' && n.state !== 'levitate'
        && !this.onBridge(t.x, t.z) && !this.world.isOnIsland(t.x, t.z, -2)) {
        this.spawnParticles(t.x, 0.5, t.z, 8, 0x3a8fcf);
        let rx = 20, rz = 20;
        for (let a = 0; a < 12; a++) {
          const th = Math.random() * Math.PI * 2;
          const rr = Math.sqrt(Math.random()) * (islandRadius(th, true) - 12);
          const px = Math.cos(th) * rr;
          const pz = Math.sin(th) * rr;
          if (Math.hypot(px, pz - 8) < 15) continue;
          rx = px; rz = pz; break;
        }
        n.body.setTranslation({ x: rx, y: 4, z: rz }, true);
        n.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        this.pickNPCDestination(n);
        if (n.state === 'launched') {
          this.setNPCState(n, 'stunned');
          n.stateTimer = 3;
        }
      }
      // marcador ▼ dourado só aparece durante a missão das folhas
      const mk = n.mesh.userData['sweaterMarker'] as THREE.Mesh | undefined;
      if (mk) {
        const show = this.missions.current()?.id === 'folhas'
          && n.state !== 'inCannon' && n.state !== 'launched';
        mk.visible = show === true;
        if (show) mk.position.y = 2.75 + Math.sin(performance.now() / 300) * 0.15;
      }
    }
  }

  /** Hitbox dos carros: encostou/foi atropelado -> arremessada pra frente e vira. */
  private updateCarsHit(dt: number) {
    if (this.ridingCar) return; // dentro do carro: não é atropelada
    if (this.carHitCD > 0) this.carHitCD -= dt;
    const t = this.cow.body.translation();
    if (t.y > 4.5) return; // voando por cima: sem hitbox
    if (this.carHitCD > 0) return;
    for (const car of this.world.cars) {
      const m = car.mesh;
      const dx = t.x - m.position.x;
      const dz = t.z - m.position.z;
      const th = m.rotation.y;
      const cos = Math.cos(th);
      const sin = Math.sin(th);
      // caixa do carro no referencial local (R8: 4.4 x 2.0 + metade da vaca)
      const lx = dx * cos - dz * sin;
      const lz = dx * sin + dz * cos;
      if (Math.abs(lx) > 1.9 || Math.abs(lz) > 4.4) continue;
      this.carHitCD = 1.1;
      // quem manda é a direção do carro (atropelou) + o embalo que a vaca tinha
      const dirX = car.axis === 'z' ? 0 : car.dir;
      const dirZ = car.axis === 'z' ? car.dir : 0;
      const v = this.cow.body.linvel();
      this.cow.getUp(); // se estava de barriga pra cima, levanta com o impacto
      this.cow.body.setLinvel({
        x: dirX * 9 + v.x * 0.4,
        y: 8,
        z: dirZ * 9 + v.z * 0.4,
      }, true);
      playSfx('clang');
      // só é arremessada pra frente (sem mortal/loop)
      this.spawnParticles(m.position.x, 1.4, m.position.z, 12, 0xffdd55);
      this.input.rumble(1, 0.8, 300);
      this.chaos = Math.min(100, this.chaos + 3);
      return;
    }
  }

  /** Carros longe (>250m) nem desenham: cada R8 tem 217k vértices. */
  private updateCarVisibility() {
    const t = this.cow.group.position;
    for (const c of this.world.cars) {
      const dx = c.mesh.position.x - t.x;
      const dz = c.mesh.position.z - t.z;
      c.mesh.visible = dx * dx + dz * dz < 62500; // 250m
    }
  }

  /** Trânsito: freia ante obstáculo (não passa por cima de nada) e faz
   *  meia-volta no fim da rua ou se emperrar — nunca some/teleporta. */
  private updateCars(dt: number) {
    const cp = this.cow.group.position;
    const cowY = this.cow.body.translation().y;
    for (const c of this.world.cars) {
      const m = c.mesh;
      const fx = c.axis === 'z' ? 0 : c.dir;
      const fz = c.axis === 'z' ? c.dir : 0;
      const ax = m.position.x + fx * 7;
      const az = m.position.z + fz * 7;
      // retângulo à frente do carro: 0.5..12m no rumo, ±largura lateral.
      // (antes só verificava a <80m da vaca; o resto atropelava NPC sem frear)
      const ahead = (tx: number, tz: number, lateral: number): boolean => {
        const dx = tx - m.position.x;
        const dz = tz - m.position.z;
        const dF = dx * fx + dz * fz;
        const dL = Math.abs(dx * fz - dz * fx);
        return dF > 0.5 && dF < 12 && dL < lateral;
      };
      let blocked = false;
      // vaca (só se estiver no chão; voando por cima, passa).
      // carro "barbeiro" (rage) NÃO freia pra vaca: ele atropela.
      if (!c.rage && cowY < 4 && ahead(cp.x, cp.z, 4.5)) blocked = true;
      if (!blocked) {
        for (const n of this.npcs) {
          const st = n.state;
          if (st === 'carried' || st === 'inCannon' || st === 'launched') continue;
          const t = n.body.translation();
          if (ahead(t.x, t.z, 4)) { blocked = true; break; }
        }
      }
      if (!blocked) {
        for (const cn of this.world.cannons) {
          if (ahead(cn.x, cn.z, 4)) { blocked = true; break; }
        }
      }
      if (!blocked) {
        for (const b of this.world.buildings) {
          if (Math.abs(ax - b.x) < b.halfW + 1 && Math.abs(az - b.z) < b.halfD + 1) { blocked = true; break; }
        }
      }
      const yawFor = (axis: 'x' | 'z', dir: number) =>
        axis === 'z' ? (dir > 0 ? 0 : Math.PI) : (dir > 0 ? Math.PI / 2 : -Math.PI / 2);
      if (blocked) {
        c.v = Math.max(0, c.v - dt * 24);
        c.blockT += dt;
        if (c.blockT > 4) {
          // emperrou de vez: meia-volta e segue
          c.blockT = 0;
          c.dir *= -1;
          m.rotation.y = yawFor(c.axis, c.dir);
        }
      } else {
        c.blockT = 0;
        c.v = Math.min(c.speed, c.v + dt * 14);
      }
      if (c.axis === 'z') {
        m.position.z += c.v * c.dir * dt;
        if (m.position.z > c.max) { m.position.z = c.max; c.dir = -1; m.rotation.y = yawFor('z', -1); }
        if (m.position.z < c.min) { m.position.z = c.min; c.dir = 1; m.rotation.y = yawFor('z', 1); }
      } else {
        m.position.x += c.v * c.dir * dt;
        if (m.position.x > c.max) { m.position.x = c.max; c.dir = -1; m.rotation.y = yawFor('x', -1); }
        if (m.position.x < c.min) { m.position.x = c.min; c.dir = 1; m.rotation.y = yawFor('x', 1); }
      }
    }
  }

  private updateBullets() {
    for (const c of this.world.cannons) {
      if (c.loadedNPC !== null) {
        const npc = this.npcs.find((n) => n.id === c.loadedNPC);
        if (npc) {
          npc.body.setTranslation({ x: c.x, y: 2, z: c.z - 2 }, true);
          npc.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
          npc.mesh.position.set(c.x, 2 - 0.72, c.z - 2);
        }
      }
    }
  }

  private updateParticles() {
    const im = this.particleIM;
    if (!im) return;
    const m = this._pMat;
    for (let i = 0; i < this.P_MAX; i++) {
      const d = this.pData[i]!;
      if (d.life <= 0) continue; // slot morto já ficou com escala 0
      d.life--;
      d.x += d.vx;
      d.y += d.vy;
      d.z += d.vz;
      d.vy -= 0.005;
      const s = d.life > 0 ? 1 : 0; // no frame da morte, some
      m.makeScale(s, s, s);
      m.setPosition(d.x, d.y, d.z);
      im.setMatrixAt(i, m);
    }
    im.instanceMatrix.needsUpdate = true;
  }

  private updateCamera() {
    const t = this.cow.group.position;
    // neblina e alcance acompanham o zoom (de longe dá pra ver a ilha inteira),
    // mas na cidade usa curto pra cortar geometria (menos lag)
    const fog = this.scene.fog as THREE.Fog | null;
    const inCity = Math.hypot(t.x - CITY.x, t.z - CITY.z) < CITY.r + 300;
    if (fog) {
      if (inCity) {
        fog.near = 200;
        fog.far = 1200;
      } else {
        fog.near = 800;
        fog.far = Math.max(2500, this.camDist * 2.2);
      }
    }
    // far amarrado à neblina: além dela tudo já é cor de neblina, então não há
    // por que submeter geometria. Antes era 6000 fixo -> puxava a ilha inteira
    // (grama + árvores instanciadas) mesmo com o jogador parado (~12M triângulos).
    const fogFar = inCity ? 1200 : Math.max(2500, this.camDist * 2.2);
    const wantFar = inCity ? 1500 : Math.max(fogFar + 400, this.camDist * 2.5 + 400);
    if (Math.abs(this.camera.far - wantFar) > 1) {
      this.camera.far = wantFar;
      this.camera.updateProjectionMatrix();
    }
    const targetX = t.x - Math.sin(this.camYaw) * this.camDist * Math.cos(this.camPitch);
    const targetY = t.y + 3 + Math.sin(this.camPitch) * this.camDist;
    const targetZ = t.z - Math.cos(this.camYaw) * this.camDist * Math.cos(this.camPitch);
    this._camPos.set(targetX, targetY, targetZ);
    this.camera.position.lerp(this._camPos, 0.12);
    this.camera.lookAt(t.x, t.y + 2.5, t.z);
  }

  private update(dt: number) {
    if (!this.started) return;
    this.input.syncLock();
    this.input.pollGamepad();
    // GRAVIDADE DINÂMICA: quanto mais tempo a vaca cai, mais forte a gravidade
    // (a queda vira mergulho: quanto mais tempo, mais rápido cai)
    {
      const ramp = Math.min(2.4, this.fallT);
      const g = this.gravBase + ramp * this.gravRamp;
      const gr = this.physics.gravity;
      if (gr) { gr.x = 0; gr.y = -g; gr.z = 0; }
    }
    // timestep fixo: fisica em tempo real mesmo com fps baixo
    this.physAcc += dt;
    let steps = 0;
    while (this.physAcc >= 1 / 60 && steps < 5) {
      this.physics.step();
      this.physAcc -= 1 / 60;
      steps++;
    }
    if (steps === 5) this.physAcc = 0;

    const md = this.input.takeMouseDelta();
    // com pointer lock OU arrastando (mouse ou dedo na tela)
    if (this.input.mouseLocked || this.input.mouseDown || this.input.isTouch) {
      this.camYaw += md.x * 0.003 * this.input.sensitivity;
      this.camPitch = Math.max(-0.5, Math.min(1.2, this.camPitch - md.y * 0.003 * this.input.sensitivity));
    }
    // olhar pelo analógico direito do controle (girar: invertido do arrasto)
    const pd = this.input.takePadDelta();
    if (pd.x !== 0 || pd.y !== 0) {
      this.camYaw -= pd.x * 0.003 * this.input.sensitivity;
      this.camPitch = Math.max(-0.5, Math.min(1.2, this.camPitch + pd.y * 0.003 * this.input.sensitivity));
    }
    const wd = this.input.takeWheelDelta();
    if (wd !== 0) {
      // zoom multiplicativo (livre até 3000m) com trava embaixo pra não entrar na vaca
      this.camDist = Math.max(8, Math.min(3000, this.camDist * (1 + wd * 0.002)));
    }

    if (this.input.isDown('KeyE')) {
      this.input.keys['KeyE'] = false;
      this.doInteract();
    }
    if (this.input.isDown('KeyQ')) {
      this.input.keys['KeyQ'] = false;
      this.cowAttack();
    }
    if (this.input.isDown('KeyF') && this.carrying) {
      this.input.keys['KeyF'] = false;
      this.dropCarried();
    }
    if (this.input.consumeOnce('Digit1')) this.setGadget('sela');
    if (this.input.consumeOnce('Digit2')) this.setGadget('jetpack');
    if (this.input.consumeOnce('Digit3')) this.setGadget('biblia');
    if (this.input.consumeOnce('KeyM')) this.toggleSound();

    // dentro do carro: a vaca viaja com ele (sem física, sem colisão)
    if (this.ridingCar) {
      const m = this.ridingCar.mesh;
      this.cow.body.setTranslation({ x: m.position.x, y: m.position.y + 1.6, z: m.position.z }, true);
      this.cow.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      this.cow.yaw = m.rotation.y;
      this.cow.group.position.set(m.position.x, m.position.y + 1.6 - COW_HALF_H, m.position.z);
      this.cow.group.visible = false;
    } else {
      this.updateCow(dt);
    }
    this.updateCars(dt);
    this.updateCarsHit(dt);
    // IA: joga, obedece, mantém distância do jogador, conversa
    if (this.cowAI) {
      this.cowAI.update(
        dt,
        this.cow.group.position,
        this.npcs,
        (x, z) => this.world.groundHeight(x, z),
      );
    }
    this.updateCarVisibility();
    this.updateNPCs(dt);
    this.updateBullets();
    this.world.updateAnims(dt);
    if (this.netActive && this.net.connected) {
      this.netAcc += dt;
      if (this.netAcc >= 1 / 15) {
        this.netAcc = 0;
        const t = this.cow.body.translation();
        const v = this.cow.body.linvel();
        this.net.sendState({
          x: t.x, y: t.y, z: t.z, yaw: this.cow.yaw,
          speed: Math.hypot(v.x, v.z),
          air: !this.cow.grounded, carry: this.carrying !== null,
          score: this.score,
        });
      }
      for (const rc of this.remoteCows.values()) {
        const d = Math.hypot(rc.target.x - rc.group.position.x, rc.target.z - rc.group.position.z);
        rc.update(dt, d > 0.5 ? 5 : 0);
      }
    } else if (this.netActive) {
      this.netActive = false;
    }
    this.missions.update(dt, {
      carrying: this.carrying ? {
        isSweater: isSweater(this.carrying),
        x: this.carrying.body.translation().x,
        y: this.carrying.body.translation().y,
        z: this.carrying.body.translation().z,
      } : null,
      trees: this.world.trees,
      score: this.score,
      chaos: this.chaos,
    });
    // carregando a pessoa errada na missão das folhas? avisa (com cooldown)
    if (this.missions.current()?.id === 'folhas' && this.carrying && !isSweater(this.carrying)) {
      const now = performance.now();
      if (now - this.sweaterHintAt > 4000) {
        this.sweaterHintAt = now;
        this.showMessage('Esse não é de sueter! Procure o ▼ amarelo 🍂');
      }
    }
    this.updateParticles();
    this.updateCamera();
    this.updateSun(dt);
    // HUD a 10Hz: o innerHTML das missões/placar e as varreduras de NPC por
    // frame custavam caro à toa (nada visível muda em <100ms).
    this.hudAcc += dt;
    if (this.hudAcc >= 0.1) {
      this.hudAcc = 0;
      this.updateHUD();
    }
  }

  /** O sol (e sua câmera de sombra de 90m) acompanha a vaca todo frame. */
  /** Ciclo dia/noite: o sol gira (lua no oposto), céu/neblina/luz acompanham. */
  private updateSun(dt: number) {
    const dl = this.sunLight;
    if (!dl) return;
    this.dayT = (this.dayT + dt / Game.DAY_LEN) % 1;
    const th = this.dayT * Math.PI * 2;
    const ex = Math.cos(th) * 70, ey = Math.sin(th) * 70, ez = 30;
    const e = Math.sin(th); // altura do sol (-1..1)
    const dayF = Math.max(0, Math.min(1, (e + 0.06) / 0.21)); // 0 noite, 1 dia
    const t = this.cow.group.position;
    if (e > -0.02) dl.position.set(t.x + ex, t.y + Math.max(4, ey), t.z + ez);
    else dl.position.set(t.x - ex, t.y + Math.max(4, -ey), t.z - ez); // lua
    dl.target.position.set(t.x, t.y, t.z);
    dl.target.updateMatrixWorld();
    // cor: sol branco->laranja no horizonte; lua azul fraca
    const k = Math.max(0, Math.min(1, 1 - Math.max(0, e) * 2.5));
    this.dayNightTmp.copy(SUN_COL).lerp(SET_COL, k).lerp(MOON_COL, 1 - dayF);
    dl.color.copy(this.dayNightTmp);
    dl.intensity = 0.18 + 1.07 * dayF;
    if (this.hemiLight) this.hemiLight.intensity = 0.06 + 0.34 * dayF;
    if (this.ambLight) this.ambLight.intensity = 0.12 + 0.48 * dayF;
    const fog = this.scene.fog as THREE.Fog | null;
    if (fog) fog.color.copy(FOG_NIGHT).lerp(FOG_DAY, dayF);
    // postes + janelas: 3 luzes nos bulbos mais próximos, vidros acesos
    const nightF = 1 - dayF;
    this.world.applyNight(nightF);
    this.lampScanT -= dt;
    if (this.lampScanT <= 0) {
      this.lampScanT = 0.3;
      const bulbs = this.world.lampBulbs;
      const ranked = bulbs
        .map((b) => ({ b, d: Math.abs(b.x - t.x) + Math.abs(b.z - t.z) }))
        .sort((a, c) => a.d - c.d)
        .slice(0, this.lampLights.length);
      this.lampLights.forEach((pl, i) => {
        const hit = ranked[i];
        if (hit && nightF > 0.02) {
          pl.position.set(hit.b.x, hit.b.y, hit.b.z);
          pl.intensity = 1500 * nightF;
        } else {
          pl.intensity = 0;
        }
      });
    } else {
      for (const pl of this.lampLights) {
        if (pl.intensity > 0) pl.intensity = 1500 * nightF;
      }
    }
    // reflexos do ambiente também anoitecem (senão a vaca fica acesa à noite)
    this.scene.environmentIntensity = 0.08 + 0.92 * dayF;
    if (this.skyMat) {
      (this.skyMat.uniforms['sunDir'] as THREE.IUniform).value.set(ex, ey, ez).normalize();
      (this.skyMat.uniforms['nightF'] as THREE.IUniform).value = 1 - dayF;
    }
    // relógio no HUD (só quando muda o minuto)
    const mins = Math.floor(((6 + this.dayT * 24) % 24) * 60);
    const txt = `${dayF > 0.6 ? '☀' : dayF > 0.25 ? '🌇' : '🌙'} `
      + `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
    if (txt !== this.lastClock) {
      this.lastClock = txt;
      const el = document.getElementById('dayphase');
      if (el) el.textContent = txt;
    }
    // a cúpula acompanha a câmera (o sol fica parado no céu)
    if (this.skyDome) this.skyDome.position.copy(this.camera.position);
  }

  /** Vitrine no menu: câmera orbitando a fazenda + vaca pastando. */
  private updateMenuCamera(dt: number) {
    this.menuCamT += dt * 0.1;
    const a = this.menuCamT;
    this.camera.position.set(SPAWN.x + Math.sin(a) * 18, 8, SPAWN.z + Math.cos(a) * 18);
    this.camera.lookAt(SPAWN.x, 2, SPAWN.z);
  }

  private animate() {
    requestAnimationFrame(() => this.animate());
    const now = performance.now();
    const dt = Math.min((now - this.lastTime) / 1000, 0.05);
    this.lastTime = now;
    if (this.started) {
      this.update(dt);
    } else if (this.cow && this.world) {
      this.updateMenuCamera(dt);
      this.cow.update(dt, 0, false);
      this.world.updateAnims(dt);
      this.updateCars(dt);
    }
    if (this.debugHitboxes) this.updateDebugHitboxes(dt);
    this.renderer.render(this.scene, this.camera);
  }
}