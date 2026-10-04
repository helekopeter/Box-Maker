/**
 * The laser bed size, shared by every tab: set it once in any Export panel and all tabs
 * warn when a cutting layout doesn't fit.
 */
const KEY = 'box-maker:bed';
const DEFAULT: [number, number] = [600, 400];

function load(): [number, number] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (Array.isArray(raw) && raw.length === 2 && raw.every((v) => typeof v === 'number' && v >= 10 && v <= 5000)) return [raw[0], raw[1]];
    // Earlier versions kept it with the Simple tab's settings.
    const old = JSON.parse(localStorage.getItem('box-maker:v2') ?? 'null')?.bed;
    if (Array.isArray(old) && old.length === 2) return [old[0], old[1]];
  } catch {
    /* storage unavailable */
  }
  return [...DEFAULT];
}

let bed = load();
const listeners = new Set<() => void>();

export function getBed(): [number, number] {
  return bed;
}

export function setBed(next: [number, number]) {
  bed = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(bed));
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((fn) => fn());
}

/** Calls `fn` whenever the bed size changes (from any tab). */
export function onBedChange(fn: () => void) {
  listeners.add(fn);
}

/** Whether a sheet fits on the bed, either way round. */
export function fitsBed(w: number, h: number): boolean {
  const [bw, bh] = bed;
  return (w <= bw && h <= bh) || (w <= bh && h <= bw);
}

export function bedWarning(): string {
  const [bw, bh] = bed;
  return `⚠ Larger than your ${bw} × ${bh} mm laser bed. Make the box smaller or change the bed size under Export.`;
}

/**
 * Wires a pair of width/height inputs to the shared bed size, keeping every pair on the
 * page in step.
 */
export function bindBedInputs(w: HTMLInputElement, h: HTMLInputElement) {
  const sync = () => {
    if (document.activeElement !== w) w.value = String(bed[0]);
    if (document.activeElement !== h) h.value = String(bed[1]);
  };
  const read = () => {
    const a = parseFloat(w.value);
    const b = parseFloat(h.value);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return;
    setBed([Math.min(5000, Math.max(10, a)), Math.min(5000, Math.max(10, b))]);
  };
  w.addEventListener('input', read);
  h.addEventListener('input', read);
  onBedChange(sync);
  sync();
}
