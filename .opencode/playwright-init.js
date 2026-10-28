window.isPlaywrightMCP = true;

window.__GAME_TELEMETRY__ = {
  errors: [],
  fps: 0,
  frameCount: 0,
  lastTime: performance.now(),
};

function recordGameError(type, payload) {
  const telemetry = window.__GAME_TELEMETRY__;
  telemetry.errors.push({
    type,
    time: Date.now(),
    ...payload,
  });
  if (telemetry.errors.length > 100) telemetry.errors.shift();
}

window.addEventListener('error', (event) => {
  recordGameError('error', {
    message: event.message || 'Unknown error',
    source: event.filename || null,
    line: event.lineno || null,
    column: event.colno || null,
    stack: event.error?.stack || null,
  });
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  recordGameError('unhandledrejection', {
    message: reason?.message || String(reason),
    stack: reason?.stack || null,
  });
});

let frameWindowStart = performance.now();
let frameWindowCount = 0;

function updateGameTelemetry(now) {
  const telemetry = window.__GAME_TELEMETRY__;
  telemetry.frameCount += 1;
  telemetry.lastTime = now;
  frameWindowCount += 1;
  const elapsed = now - frameWindowStart;
  if (elapsed >= 1000) {
    telemetry.fps = Math.round((frameWindowCount * 1000) / elapsed);
    frameWindowCount = 0;
    frameWindowStart = now;
  }
  requestAnimationFrame(updateGameTelemetry);
}

requestAnimationFrame(updateGameTelemetry);
