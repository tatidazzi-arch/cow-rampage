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
}