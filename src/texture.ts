import { sanitizeTexture } from './decals';
import type { Appearance, Dieline, Texture } from './types';
import { $, download, readTexture, toast } from './ui';

/**
 * The texture controls in a Look panel: download a template to paint over, import the
 * painted picture, remove it. Returns a function to call when the box changes (it warns
 * when the box no longer matches the template the texture was painted on).
 */
export function bindTexture(
  prefix: string,
  opts: {
    get: () => Texture | undefined;
    set: (t: Texture | undefined) => void;
    dieline: () => Dieline;
    look: () => Appearance;
    name: () => string;
  },
) {
  const hint = $(`#${prefix}tex-hint`);
  const remove = $(`#${prefix}tex-remove`);
  const input = $<HTMLInputElement>(`#${prefix}tex-import`);
  const help = hint.textContent ?? '';
  const sync = () => {
    const t = opts.get();
    const d = opts.dieline();
    remove.hidden = !t;
    hint.classList.toggle('warn', false);
    if (!t) hint.textContent = help;
    else if (Math.abs(t.width - d.width) > 0.5 || Math.abs(t.height - d.height) > 0.5) {
      hint.classList.add('warn');
      hint.textContent = `The box has changed since this texture was painted (${Math.round(t.width)} × ${Math.round(t.height)} mm sheet, now ${Math.round(d.width)} × ${Math.round(d.height)} mm), so it's stretched to fit. Download a new template to repaint it.`;
    } else hint.textContent = 'Texture applied. Paint more over a new template any time, or remove it.';
  };
  $(`#${prefix}tex-template`).addEventListener('click', async () => {
    const { buildTemplatePdf } = await import('./export/pdf');
    download(await buildTemplatePdf(opts.dieline(), opts.look()), `${opts.name()}-texture-template.pdf`);
  });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const { src, aspect } = await readTexture(file);
      const d = opts.dieline();
      opts.set({ src, width: d.width, height: d.height });
      const want = d.height / d.width;
      if (Math.abs(aspect / want - 1) > 0.03) {
        toast('That picture isn’t the same shape as the template, so it’s stretched to fit the sheet. Paint over the template PDF and keep its page size.', 6000);
      }
    } catch {
      toast('Couldn’t read that image. Try a PNG or JPG.');
    }
    sync();
  });
  remove.addEventListener('click', () => {
    opts.set(undefined);
    sync();
  });
  sync();
  return sync;
}

let cached: { src: string; url: string } | null = null;

/**
 * A short object URL standing in for a (large) texture data URL, so on-screen previews that
 * are rebuilt on every edit don't copy megabytes of text each time.
 */
export function previewLook(look: Appearance): Appearance {
  const t = look.texture;
  if (!t) return look;
  if (cached?.src !== t.src) {
    if (cached) URL.revokeObjectURL(cached.url);
    const [head, data] = t.src.split(',');
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    cached = { src: t.src, url: URL.createObjectURL(new Blob([bytes], { type: head.slice(5, head.indexOf(';')) })) };
  }
  return { ...look, texture: { ...t, src: cached.url } };
}

const lastSaved = new Map<string, string | undefined>();

/**
 * Textures are saved under their own key, so a picture too big for the browser's storage
 * never stops the rest of the box from being saved.
 */
export function saveTexture(key: string, t: Texture | undefined) {
  const k = `${key}:texture`;
  const json = t ? JSON.stringify(t) : undefined;
  if (lastSaved.get(k) === json) return;
  lastSaved.set(k, json);
  try {
    if (json) localStorage.setItem(k, json);
    else localStorage.removeItem(k);
  } catch {
    localStorage.removeItem(k);
    toast('The texture is too big for the browser to remember after a reload, but it’s used until then. Export now, or use a smaller picture.', 6000);
  }
}

export function loadTexture(key: string): Texture | undefined {
  try {
    const t = sanitizeTexture(JSON.parse(localStorage.getItem(`${key}:texture`) ?? 'null'));
    if (t) lastSaved.set(`${key}:texture`, JSON.stringify(t));
    return t;
  } catch {
    return undefined;
  }
}
