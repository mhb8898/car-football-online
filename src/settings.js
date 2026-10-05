// Per-browser preferences. localStorage only; nothing here is ever sent.
const KEY = 'tk_settings';
const touch = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
const DEFAULTS = {
  name: '',
  car: 0,
  quality: touch ? 'low' : 'high',
  fov: 80,
  dist: 8.6,
  volume: 0.8,
  ballCam: true,
  plates: true,
  perf: false,
  autoRes: true,
  muted: false,
};
let cur = { ...DEFAULTS };
try { cur = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { /* private mode */ }

export const get = () => cur;
export function set(patch) {
  cur = { ...cur, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(cur)); } catch { /* private mode */ }
  return cur;
}
export const isTouch = touch;
