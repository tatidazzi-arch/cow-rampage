import type { Input } from './input';

/** Celular/tablet? Cobre Android, iPhone e iPad (inclusive com UA de desktop). */
export function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  return 'ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0;
}

const BTN_KEY: Record<string, string> = {
  jump: 'Space',
  grab: 'KeyE',
  drop: 'KeyF',
  head: 'KeyQ',
  flip: 'KeyR',
};

const JOY_R = 55;

/** Cria joystick virtual + botões de ação. O olhar é por arrastar na tela. */
export function setupTouchControls(input: Input, isPlaying: () => boolean): void {
  if (!isTouchDevice()) return;
  input.isTouch = true;
  document.body.classList.add('touch');

  const root = document.createElement('div');
  root.id = 'touchui';
  root.innerHTML = `
    <div id="tjoy"><div id="tknob"></div></div>
    <div class="tbtn tjump" data-tbtn="jump">PULAR</div>
    <div class="tbtn tgrab" data-tbtn="grab">PEGAR</div>
    <div class="tbtn tdrop" data-tbtn="drop">SOLTAR</div>
    <div class="tbtn thead" data-tbtn="head">CABEÇADA</div>
    <div class="tbtn tflip" data-tbtn="flip">MORTAL</div>
    <div class="tbtn trun" data-tbtn="run">CORRER</div>
    <div class="tbtn tgear" data-tbtn="gear">🎒</div>
    <div class="tbtn tzin" data-tbtn="zin">+</div>
    <div class="tbtn tzout" data-tbtn="zout">−</div>
  `;
  document.body.appendChild(root);

  const joy = root.querySelector('#tjoy') as HTMLElement;
  const knob = root.querySelector('#tknob') as HTMLElement;
  let joyId: number | null = null;
  let joyCX = 0;
  let joyCY = 0;
  let lookId: number | null = null;
  let lastLX = 0;
  let lastLY = 0;

  const setKnob = (dx: number, dy: number) => {
    knob.style.transform = `translate(${dx.toFixed(1)}px,${dy.toFixed(1)}px)`;
  };

  const setJoy = (dx: number, dy: number) => {
    const len = Math.hypot(dx, dy) || 1;
    const cl = Math.min(len, JOY_R);
    const nx = (dx / len) * cl;
    const ny = (dy / len) * cl;
    setKnob(nx, ny);
    input.joyF = -ny / JOY_R; // pra cima = andar pra frente
    input.joyS = nx / JOY_R; // pra direita = strafe direita
  };

  const resetJoy = () => {
    joyId = null;
    input.joyF = 0;
    input.joyS = 0;
    setKnob(0, 0);
    joy.style.left = '';
    joy.style.top = '';
    joy.style.right = '';
    joy.style.bottom = '';
  };

  const isUI = (t: Touch): boolean => {
    const el = t.target as HTMLElement | null;
    return !!el && !!el.closest && !!el.closest('[data-tbtn],input,button,#touchui-ignore');
  };

  document.addEventListener('touchstart', (e) => {
    if (!isPlaying()) return;
    for (const t of Array.from(e.changedTouches)) {
      if (isUI(t)) continue;
      e.preventDefault();
      const w = window.innerWidth;
      const h = window.innerHeight;
      if (joyId === null && t.clientX < w * 0.45 && t.clientY > h * 0.3) {
        joyId = t.identifier;
        joyCX = Math.max(70, Math.min(t.clientX, w - 70));
        joyCY = Math.max(70, Math.min(t.clientY, h - 70));
        joy.style.left = `${joyCX - 60}px`;
        joy.style.top = `${joyCY - 60}px`;
        joy.style.right = 'auto';
        joy.style.bottom = 'auto';
        setJoy(0, 0);
      } else if (lookId === null) {
        lookId = t.identifier;
        lastLX = t.clientX;
        lastLY = t.clientY;
      }
    }
  }, { passive: false });

  document.addEventListener('touchmove', (e) => {
    if (!isPlaying()) return;
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === joyId) {
        e.preventDefault();
        setJoy(t.clientX - joyCX, t.clientY - joyCY);
      } else if (t.identifier === lookId) {
        e.preventDefault();
        input.mouseDX += (t.clientX - lastLX) * 1.6;
        input.mouseDY += (t.clientY - lastLY) * 1.6;
        lastLX = t.clientX;
        lastLY = t.clientY;
      }
    }
  }, { passive: false });

  const endTouch = (e: TouchEvent) => {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === joyId) resetJoy();
      if (t.identifier === lookId) lookId = null;
    }
  };
  document.addEventListener('touchend', endTouch);
  document.addEventListener('touchcancel', endTouch);

  root.querySelectorAll('[data-tbtn]').forEach((el) => {
    const btn = el as HTMLElement;
    const kind = btn.dataset['tbtn'] ?? '';
    let releaseTimer = 0;
    btn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!isPlaying()) return;
      if (kind === 'run') {
        input.keys['ShiftLeft'] = !input.keys['ShiftLeft'];
        btn.classList.toggle('on', !!input.keys['ShiftLeft']);
      } else if (kind === 'gear') {
        if (input.onCycleGadget) input.onCycleGadget(1);
      } else if (kind === 'zin') {
        input.wheelDX -= 150;
      } else if (kind === 'zout') {
        input.wheelDX += 150;
      } else {
        const code = BTN_KEY[kind];
        if (code) {
          window.clearTimeout(releaseTimer);
          input.keys[code] = true;
        }
        btn.classList.add('on');
      }
    }, { passive: false });
    const release = (e: TouchEvent) => {
      e.stopPropagation();
      const code = BTN_KEY[kind];
      if (code) {
        // segura um pouco: o tap pode ser mais rápido que 1 frame
        window.clearTimeout(releaseTimer);
        releaseTimer = window.setTimeout(() => { input.keys[code] = false; }, 120);
      }
      if (kind !== 'run') btn.classList.remove('on');
    };
    btn.addEventListener('touchend', release);
    btn.addEventListener('touchcancel', release);
  });
}
