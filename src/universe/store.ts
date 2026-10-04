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
  /** Lower-case words to find and filter by, e.g. "gift", "christmas". */
  tags: string[];
  likes: number;
  /** Built-in example rather than a user upload. */
  example?: boolean;
}

export type NewBox = Omit<SharedBox, 'id' | 'created_at' | 'example' | 'likes'>;

export type SortOrder = 'new' | 'liked';

export interface ListOptions {
  query: string;
  /** Only boxes with this tag. */
  tag?: string;
  sort: SortOrder;
}

export interface BoxStore {
  /** True when uploads are visible to everyone, false when they stay in this browser. */
  readonly shared: boolean;
  list(opts: ListOptions): Promise<SharedBox[]>;
  add(box: NewBox): Promise<SharedBox>;
  /** Adds (or takes back) a like; returns the new count. */
  like(id: string, liked: boolean): Promise<number>;
  /** Only local boxes can be removed. */
  remove?(id: string): Promise<void>;
}

/** Cleans up tags: lower case, letters, digits, spaces and dashes, at most 8 of 24 characters. */
export function cleanTags(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,#]/) : [];
  const out: string[] = [];
  for (const t of list) {
    if (typeof t !== 'string') continue;
    const tag = t.toLowerCase().replace(/[^\p{L}\p{N} -]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 24);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length === 8) break;
  }
  return out;
}

const LIKED_KEY = 'box-maker:liked';

/** Boxes liked in this browser (one like per box per browser). */
export function likedBoxes(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(LIKED_KEY) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

export function setLiked(id: string, liked: boolean) {
  const set = likedBoxes();
  if (liked) set.add(id);
  else set.delete(id);
  try {
    localStorage.setItem(LIKED_KEY, JSON.stringify([...set].slice(-2000)));
  } catch {
    /* ignore */
  }
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
    tags: cleanTags(r.tags),
    likes: typeof r.likes === 'number' && Number.isFinite(r.likes) ? Math.max(0, Math.round(r.likes)) : 0,
  };
}

/** Search (name, author, description, tags) and tag filter, as the gallery applies them. */
export function matches(b: SharedBox, opts: Pick<ListOptions, 'query' | 'tag'>): boolean {
  if (opts.tag && !b.tags.includes(opts.tag)) return false;
  const q = opts.query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${b.name} ${b.author} ${b.description} ${b.tags.join(' ')}`.toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

export function sortBoxes(list: SharedBox[], sort: SortOrder): SharedBox[] {
  const byDate = (a: SharedBox, b: SharedBox) => b.created_at.localeCompare(a.created_at);
  return [...list].sort(sort === 'liked' ? (a, b) => b.likes - a.likes || byDate(a, b) : byDate);
}

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

  async list(opts: ListOptions) {
    return sortBoxes(this.read().filter((b) => matches(b, opts)), opts.sort);
  }

  async add(box: NewBox) {
    const full: SharedBox = { ...box, id: Math.random().toString(36).slice(2, 12), created_at: new Date().toISOString(), likes: 0 };
    this.write([full, ...this.read()]);
    return full;
  }

  async like(id: string, liked: boolean) {
    const list = this.read();
    const box = list.find((b) => b.id === id);
    if (!box) return 0;
    box.likes = Math.max(0, box.likes + (liked ? 1 : -1));
    this.write(list);
    return box.likes;
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
  /** Set when the table predates tags and likes (see README); they're then left out. */
  private legacy = false;
  constructor(private url: string, private key: string) {}

  private headers(extra: Record<string, string> = {}) {
    return { apikey: this.key, Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json', ...extra };
  }

  async list(opts: ListOptions): Promise<SharedBox[]> {
    const legacy = this.legacy;
    const params = new URLSearchParams({
      select: `id,created_at,name,author,description,kind,data,thumbnail${legacy ? '' : ',tags,likes'}`,
      order: opts.sort === 'liked' && !legacy ? 'likes.desc,created_at.desc' : 'created_at.desc',
      limit: '60',
    });
    // Keep only characters that are safe inside PostgREST's filter syntax.
    const q = opts.query.trim().replace(/[^\p{L}\p{N} _.-]/gu, ' ').replace(/\s+/g, ' ').trim();
    const tagQ = cleanTags([q])[0];
    if (q) params.set('or', `(name.ilike.*${q}*,author.ilike.*${q}*,description.ilike.*${q}*${!legacy && tagQ ? `,tags.cs.{"${tagQ}"}` : ''})`);
    const tag = cleanTags([opts.tag ?? ''])[0];
    if (tag && !legacy) params.set('tags', `cs.{"${tag}"}`);
    const res = await fetch(`${this.url}/rest/v1/boxes?${params}`, { headers: this.headers() });
    if (!res.ok) {
      // An older table without the tags and likes columns: carry on without them.
      if (!legacy && res.status === 400) {
        this.legacy = true;
        return this.list(opts);
      }
      throw new Error(`Couldn't load the Box Universe (${res.status}).`);
    }
    const rows = (await res.json()) as unknown[];
    return (rows.map(sanitizeBox).filter(Boolean) as SharedBox[]).filter((b) => !tag || !legacy || b.tags.includes(tag));
  }

  async like(id: string, liked: boolean) {
    const res = await fetch(`${this.url}/rest/v1/rpc/like_box`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ box_id: id, delta: liked ? 1 : -1 }),
    });
    if (!res.ok) throw new Error(`Couldn't save the like (${res.status}).`);
    const n = await res.json();
    return typeof n === 'number' ? n : 0;
  }

  async add(box: NewBox) {
    const { tags, ...rest } = box;
    const res = await fetch(`${this.url}/rest/v1/boxes`, {
      method: 'POST',
      headers: this.headers({ Prefer: 'return=representation' }),
      body: JSON.stringify(this.legacy ? rest : { ...rest, tags }),
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
