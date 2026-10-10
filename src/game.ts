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
  private shopGoat: NPCPhysics | null = null;
  private netActive = false;
  private netAcc = 0;

  private score = 0;
  private lastScore = 0;
  private quality: 'high' | 'low' = 'high';
  private sunLight: THREE.DirectionalLight | null = null;
  private menuCamT = 0;
  private chaos = 0;
  private carrying: NPCPhysics | null = null;
  private camDist = 16;
  private camYaw = 0;
  private camPitch = 0.45;
  private started = false;
  private physAcc = 0;
  /** maior velocidade de queda desde o último toque no chão (tombo) */
  private fallV = 0;
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

    this.scene.add(new THREE.AmbientLight(0x606080, 0.6));
    const dl = new THREE.DirectionalLight(0xfff5e0, 1.2);
    dl.position.set(50, 80, 30);
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
    this.scene.add(new THREE.HemisphereLight(0x87ceeb, 0x445522, 0.4));
    this.sunLight = dl;
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
  }

  private refreshMenuWallet() {
    const el = document.getElementById('menuwallet');
    if (el) el.textContent = `🪙 ${getWallet()} DINCOW`;
  }

  /** Sair: volta pra tela da senha. */
  private lockGame() {
    if (this.netActive) this.leaveNet();
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
    // bode vendedor da loja de skins (atrás do balcão, paradão)
    {
      const vendor = this.npcFactory.create(this.scene, this.physics, GOATS.x - 24, GOATS.z + 18, 'goat');
      vendor.vendor = true;
      vendor.tx = GOATS.x - 24;
      vendor.tz = GOATS.z + 18;
      this.npcs.push(vendor);
      this.shopGoat = vendor;
    }
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
      <div>🪙 DINCOW: <span id="score">0</span> <span id="padstat"></span></div>
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
    if (pw !== 'cowcow') {
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
    this.refreshMenuWallet();
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
      `<div style="color:#${p.color.toString(16).padStart(6, '0')}">${p.name}${p.me ? ' (você)' : ''}</div>`,
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

  private beginPlay(multiplayer: boolean) {
    const start = document.getElementById('start');
    if (start) start.style.display = 'none';
    document.getElementById('hud')!.style.display = 'block';
    document.getElementById('controls')!.style.display = 'block';
    document.getElementById('mission')!.style.display = 'block';
    this.started = true;
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
          rc = new RemoteCow(this.scene, prof ? prof.name : '?', prof ? prof.color : 0xffffff, prof && typeof prof.skin === 'string' ? prof.skin : 'comum');
          rc.group.position.set(s.x, s.y - COW_HALF_H, s.z);
          rc.target.set(s.x, s.y - COW_HALF_H, s.z);
          this.remoteCows.set(peerId, rc);
          this.showMessage((prof ? prof.name : 'Alguém') + ' entrou! 🐄');
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
      this.net.onEvent = (e, fromName) => {
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
    } else if (this.shopGoat && Math.hypot(this.shopGoat.body.translation().x - cx, this.shopGoat.body.translation().z - cz) < 6) {
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

    // bode vendedor: abre a loja (vale carregando ou não)
    if (this.shopGoat) {
      const t = this.shopGoat.body.translation();
      if (Math.hypot(t.x - cx, t.z - cz) < 6) {
        this.openSkinMenu();
        return;
      }
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

  private setNPCState(npc: NPCPhysics, state: NPCPhysics['state'], timer = 0) {
    npc.state = state;
    npc.stateTimer = timer;
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
      if (n.state !== 'walk' || n.vendor) continue;
      const t = n.body.translation();
      const dx = t.x - cx;
      const dz = t.z - cz;
      const d = Math.hypot(dx, dz);
      if (d < 5) {
        this.setNPCState(n, 'stunned');
        n.stateTimer = 5;
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
    if (move.length() > 0) {
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
          if (n.stateTimer > 0) {
            n.stateTimer -= dt;
            if (n.stateTimer <= 0) {
              this.setNPCState(n, 'walk');
              if (!n.vendor) this.pickNPCDestination(n);
              n.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
              n.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
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
      // só desvia do que está perto da vaca (longe, a avenida é livre)
      const nearCow = Math.abs(m.position.x - cp.x) < 80 && Math.abs(m.position.z - cp.z) < 80;
      let blocked = false;
      if (nearCow) {
        if (Math.abs(cp.x - ax) < 4 && Math.abs(cp.z - az) < 4 && cowY < 4) blocked = true;
        if (!blocked) {
          for (const n of this.npcs) {
            const st = n.state;
            if (st === 'carried' || st === 'inCannon' || st === 'launched') continue;
            const t = n.body.translation();
            const dx = t.x - ax, dz = t.z - az;
            if (dx * dx + dz * dz < 9) { blocked = true; break; }
          }
        }
        if (!blocked) {
          for (const cn of this.world.cannons) {
            const dx = cn.x - ax, dz = cn.z - az;
            if (dx * dx + dz * dz < 9) { blocked = true; break; }
          }
        }
        if (!blocked) {
          for (const b of this.world.buildings) {
            if (Math.abs(ax - b.x) < b.halfW + 1 && Math.abs(az - b.z) < b.halfD + 1) { blocked = true; break; }
          }
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

    this.updateCow(dt);
    this.updateCars(dt);
    this.updateCarsHit(dt);
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
    this.updateSun();
    // HUD a 10Hz: o innerHTML das missões/placar e as varreduras de NPC por
    // frame custavam caro à toa (nada visível muda em <100ms).
    this.hudAcc += dt;
    if (this.hudAcc >= 0.1) {
      this.hudAcc = 0;
      this.updateHUD();
    }
  }

  /** O sol (e sua câmera de sombra de 90m) acompanha a vaca todo frame. */
  private updateSun() {
    const dl = this.sunLight;
    if (!dl) return;
    const t = this.cow.group.position;
    dl.position.set(t.x + 50, t.y + 80, t.z + 30);
    dl.target.position.set(t.x, t.y, t.z);
    dl.target.updateMatrixWorld();
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
    this.renderer.render(this.scene, this.camera);
  }
}