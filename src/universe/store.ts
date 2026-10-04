import { sanitizeDesign } from '../advanced/model';
import type { AdvancedShare } from '../advanced/tab';
import { sanitizeSimple, type SimpleShare } from '../simple';

export type ShareData = SimpleShare | AdvancedShare;

/** A box in the Box Universe. */
export interface SharedBox {
  id: string;
  created_at: string;
  name: string;
  author: string;
  description: string;
  kind: 'simple' | 'advanced';
  data: ShareData;
  /** Small JPEG/PNG data URL of the 3D preview (optional). */
  thumbnail: string;
  /** Built-in example rather than a user upload. */
  example?: boolean;
}

export type NewBox = Omit<SharedBox, 'id' | 'created_at' | 'example'>;

export interface BoxStore {
  /** True when uploads are visible to everyone, false when they stay in this browser. */
  readonly shared: boolean;
  list(query: string): Promise<SharedBox[]>;
  add(box: NewBox): Promise<SharedBox>;
  /** Only local boxes can be removed. */
  remove?(id: string): Promise<void>;
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Validates a box from storage, a file or the network. Returns null if unusable. */
export function sanitizeBox(raw: unknown): SharedBox | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  let data: ShareData | null = null;
  const d = r.data as Record<string, unknown> | undefined;
  if (d?.kind === 'simple') data = sanitizeSimple(d);
  else if (d?.kind === 'advanced') {
    const design = sanitizeDesign(d.design);
    data = design ? { kind: 'advanced', design } : null;
  }
  if (!data) return null;
  const thumb = str(r.thumbnail, 400_000);
  return {
    id: str(r.id, 64) || Math.random().toString(36).slice(2),
    created_at: str(r.created_at, 40) || new Date().toISOString(),
    name: str(r.name, 80).trim() || 'Untitled box',
    author: str(r.author, 40).trim() || 'Anonymous',
    description: str(r.description, 500),
    kind: data.kind,
    data,
    // Only small inline images: no remote URLs.
    thumbnail: /^data:image\/(jpeg|png|webp);base64,[a-z0-9+/=]+$/i.test(thumb) ? thumb : '',
  };
}

const matches = (b: SharedBox, q: string) => {
  if (!q) return true;
  const hay = `${b.name} ${b.author} ${b.description}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
};

/** Boxes saved in this browser only. */
export class LocalStore implements BoxStore {
  readonly shared = false;
  private key = 'box-maker:universe:v1';

  private read(): SharedBox[] {
    try {
      const raw = JSON.parse(localStorage.getItem(this.key) ?? '[]');
      return Array.isArray(raw) ? (raw.map(sanitizeBox).filter(Boolean) as SharedBox[]) : [];
    } catch {
      return [];
    }
  }

  private write(list: SharedBox[]) {
    try {
      localStorage.setItem(this.key, JSON.stringify(list));
    } catch {
      throw new Error('Your browser storage is full. Remove a few boxes (or large decal images) and try again.');
    }
  }

  async list(query: string) {
    return this.read().filter((b) => matches(b, query));
  }

  async add(box: NewBox) {
    const full: SharedBox = { ...box, id: Math.random().toString(36).slice(2, 12), created_at: new Date().toISOString() };
    this.write([full, ...this.read()]);
    return full;
  }

  async remove(id: string) {
    this.write(this.read().filter((b) => b.id !== id));
  }
}

/**
 * A shared gallery backed by a Supabase table (see README for the SQL). Talks to its REST
 * API directly, so no client library is needed. The anon key is public by design; the
 * table's row-level security only allows reading and inserting.
 */
export class SupabaseStore implements BoxStore {
  readonly shared = true;
  constructor(private url: string, private key: string) {}

  private headers(extra: Record<string, string> = {}) {
    return { apikey: this.key, Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json', ...extra };
  }

  async list(query: string) {
    const params = new URLSearchParams({
      select: 'id,created_at,name,author,description,kind,data,thumbnail',
      order: 'created_at.desc',
      limit: '60',
    });
    const q = query.trim().replace(/[%*,()]/g, ' ').trim();
    if (q) params.set('or', `(name.ilike.*${q}*,author.ilike.*${q}*,description.ilike.*${q}*)`);
    const res = await fetch(`${this.url}/rest/v1/boxes?${params}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Couldn't load the Box Universe (${res.status}).`);
    const rows = (await res.json()) as unknown[];
    return rows.map(sanitizeBox).filter(Boolean) as SharedBox[];
  }

  async add(box: NewBox) {
    const res = await fetch(`${this.url}/rest/v1/boxes`, {
      method: 'POST',
      headers: this.headers({ Prefer: 'return=representation' }),
      body: JSON.stringify(box),
    });
    if (!res.ok) throw new Error(`Upload failed (${res.status}). ${(await res.text()).slice(0, 200)}`);
    const [row] = (await res.json()) as unknown[];
    const clean = sanitizeBox(row);
    if (!clean) throw new Error('The server returned an unexpected response.');
    return clean;
  }
}

export function createStore(): BoxStore {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (url && key && /^https:\/\//.test(url)) return new SupabaseStore(url.replace(/\/$/, ''), key);
  return new LocalStore();
}
