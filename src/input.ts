export interface KeyState {
  [key: string]: boolean;
}

export class Input {
  keys: KeyState = {};
  mouseLocked = false;
  mouseDX = 0;
  mouseDY = 0;
  wheelDX = 0;
  mouseDown = false;
  onLockError: (() => void) | null = null;
  /** true em celular/tablet (controles touch ativos) */
  isTouch = false;
  /** joystick virtual: -1..1 (frente / direita) */
  joyF = 0;
  joyS = 0;
  /** sensibilidade da câmera (configurações) */
  sensitivity = 1;
  /** controle (gamepad) conectado? */
  padConnected = false;
  /** olhar pelo analógico direito acumula aqui */
  padDX = 0;
  padDY = 0;
  onPadStatus: ((connected: boolean, id: string) => void) | null = null;
  onPadMenu: (() => void) | null = null;
  onCycleGadget: ((dir: number) => void) | null = null;

  private prevPad: boolean[] = [];

  private el: HTMLElement;
  private lockRetryAt = 0;

  constructor(el: HTMLElement) {
    this.el = el;
    window.addEventListener('keydown', (e) => {
      this.keys[e.code] = true;
      if (e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      this.keys[e.code] = false;
    });
    window.addEventListener('mousemove', (e) => {
      // acumula sempre; o Game decide quando aplicar (locked ou arrastando)
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    window.addEventListener('wheel', (e) => {
      this.wheelDX += e.deltaY;
    });
    window.addEventListener('pointerlockchange', () => {
      this.mouseLocked = document.pointerLockElement === this.el;
    });
    window.addEventListener('pointerlockerror', () => {
      if (this.onLockError) this.onLockError();
    });
    window.addEventListener('mousedown', () => { this.mouseDown = true; });
    window.addEventListener('mouseup', () => { this.mouseDown = false; });
  }

  /** Sincroniza o estado do lock todo frame (o evento pode falhar/perder). */
  syncLock() {
    this.mouseLocked = document.pointerLockElement === this.el;
  }

  requestLock() {
    if (this.mouseLocked || this.isTouch) return;
    // respeita o cooldown do navegador (ex.: logo apos sair com Esc)
    const now = performance.now();
    if (now < this.lockRetryAt) return;
    this.lockRetryAt = now + 1500;
    try {
      const p = this.el.requestPointerLock() as unknown as Promise<void> | undefined;
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          if (this.onLockError) this.onLockError();
          // uma nova tentativa apos o cooldown (ainda dentro da ativacao do clique)
          window.setTimeout(() => {
            if (!this.mouseLocked && document.hasFocus()) {
              this.lockRetryAt = 0;
              this.requestLock();
            }
          }, 1600);
        });
      }
    } catch {
      if (this.onLockError) this.onLockError();
    }
  }

  isDown(...codes: string[]): boolean {
    for (const c of codes) {
      if (this.keys[c]) return true;
    }
    return false;
  }

  consume(codes: string[]): boolean {
    let used = false;
    for (const c of codes) {
      if (this.keys[c]) {
        this.keys[c] = false;
        used = true;
      }
    }
    return used;
  }

  consumeOnce(code: string): boolean {
    let used = false;
    for (const c of code.split(',')) {
      if (this.keys[c]) {
        this.keys[c] = false;
        used = true;
      }
    }
    return used;
  }

  takeMouseDelta(): { x: number; y: number } {
    const d = { x: this.mouseDX, y: this.mouseDY };
    this.mouseDX = 0;
    this.mouseDY = 0;
    return d;
  }

  takeWheelDelta(): number {
    const w = this.wheelDX;
    this.wheelDX = 0;
    return w;
  }

  takePadDelta(): { x: number; y: number } {
    const d = { x: this.padDX, y: this.padDY };
    this.padDX = 0;
    this.padDY = 0;
    return d;
  }

  /**
   * Lê o controle (PS4/PS5/Xbox) todo frame. O botão X (índice 0) é
   * IGNORADO de propósito. Mapa PS4:
   * analógico esq = mover | analógico dir = câmera | Bola = pular |
   * Quadrado = pegar | Triângulo = soltar | R1 = cabeçada | L1 = mortal |
   * L3 = correr (liga/desliga) | R2/L2 ou direcional cima/baixo = zoom |
   * Options = menu.
   */
  pollGamepad() {
    const getPads = navigator.getGamepads;
    if (typeof getPads !== 'function') return;
    let gp: Gamepad | null = null;
    try {
      const pads = getPads.call(navigator);
      for (const p of pads) {
        if (p && p.connected) {
          gp = p;
          break;
        }
      }
    } catch {
      return;
    }
    const was = this.padConnected;
    this.padConnected = !!gp;
    if (!gp) {
      if (was && this.onPadStatus) this.onPadStatus(false, '');
      return;
    }
    if (!was && this.onPadStatus) this.onPadStatus(true, gp.id);
    const dz = (v: number) => (Math.abs(v) < 0.18 ? 0 : v);
    const ax = (i: number) => dz(gp.axes[i] ?? 0);
    // andar (reaproveita o canal do joystick do celular)
    this.joyF = -ax(1);
    this.joyS = ax(0);
    // olhar
    this.padDX += ax(2) * 14;
    this.padDY += ax(3) * 14;
    const pr = (i: number) => !!(gp.buttons[i] && gp.buttons[i].pressed);
    const val = (i: number) => (gp.buttons[i] && gp.buttons[i].value) || 0;
    const edge = (i: number) => pr(i) && !this.prevPad[i];
    const release = (i: number) => !pr(i) && !!this.prevPad[i];
    // escreve nas teclas SÓ nas transições (não quebra o teclado junto)
    const tap = (i: number, code: string) => {
      if (edge(i)) this.keys[code] = true;
      else if (release(i)) this.keys[code] = false;
    };
    tap(1, 'Space'); // Bola = pular
    tap(2, 'KeyE'); // Quadrado = pegar/interagir
    tap(3, 'KeyF'); // Triângulo = soltar
    tap(5, 'KeyQ'); // R1 = cabeçada
    tap(4, 'KeyR'); // L1 = mortal
    if (edge(10)) this.keys['ShiftLeft'] = !this.keys['ShiftLeft']; // L3 = correr
    // zoom (gatilhos analógicos + direcional)
    let zoom = 0;
    if (val(7) > 0.3) zoom -= val(7) * 12; // R2 aproxima
    if (val(6) > 0.3) zoom += val(6) * 12; // L2 afasta
    if (pr(12)) zoom -= 10; // cima aproxima
    if (pr(13)) zoom += 10; // baixo afasta
    if (zoom !== 0) this.wheelDX += zoom;
    if (edge(9) && this.onPadMenu) this.onPadMenu(); // Options = menu
    if (edge(14) && this.onCycleGadget) this.onCycleGadget(-1); // <- aparelho anterior
    if (edge(15) && this.onCycleGadget) this.onCycleGadget(1); // -> próximo aparelho
    for (let i = 0; i < 18; i++) this.prevPad[i] = pr(i);
  }

  /** Vibra o controle (dual-rumble). Silencioso se não suportar. */
  rumble(strong = 1, weak = 0.6, ms = 250) {
    try {
      if (typeof navigator.getGamepads !== 'function') return;
      const pads = navigator.getGamepads.call(navigator);
      for (const p of pads) {
        const act = p && (p as unknown as { vibrationActuator?: { playEffect?: (t: string, o: object) => void } }).vibrationActuator;
        if (act && act.playEffect) {
          act.playEffect('dual-rumble', { strongMagnitude: strong, weakMagnitude: weak, duration: ms });
          break;
        }
      }
    } catch {
      /* sem vibração */
    }
  }
}