import { beforeEach, describe, expect, it } from 'vitest';
import { cleanTags, LocalStore, matches, sanitizeBox, sortBoxes, type SharedBox } from '../src/universe/store';
import { EXAMPLES } from '../src/universe/examples';

const box = (over: Partial<SharedBox>): SharedBox => ({ ...EXAMPLES[0], example: undefined, id: 'x', likes: 0, tags: [], ...over });

describe('tags', () => {
  it('cleans tags from text or lists', () => {
    expect(cleanTags('Gift, Christmas ,#jewellery,, gift')).toEqual(['gift', 'christmas', 'jewellery']);
    expect(cleanTags(['<b>x</b>', 'a'.repeat(40)])).toEqual(['bxb', 'a'.repeat(24)]);
    expect(cleanTags(Array.from({ length: 20 }, (_, i) => `t${i}`)).length).toBe(8);
    expect(cleanTags(42)).toEqual([]);
  });

  it('searches tags and filters by one', () => {
    const b = box({ tags: ['christmas', 'gift'] });
    expect(matches(b, { query: 'christ' })).toBe(true);
    expect(matches(b, { query: '', tag: 'gift' })).toBe(true);
    expect(matches(b, { query: '', tag: 'pizza' })).toBe(false);
  });

  it('sorts by likes, then newest', () => {
    const list = [box({ id: 'a', likes: 1, created_at: '2026-01-01' }), box({ id: 'b', likes: 5, created_at: '2025-01-01' }), box({ id: 'c', likes: 1, created_at: '2026-06-01' })];
    expect(sortBoxes(list, 'liked').map((b) => b.id)).toEqual(['b', 'c', 'a']);
    expect(sortBoxes(list, 'new').map((b) => b.id)).toEqual(['c', 'a', 'b']);
  });

  it('keeps likes and tags through sanitising, never negative', () => {
    const b = sanitizeBox({ ...box({}), tags: ['Gift'], likes: -3 })!;
    expect(b.tags).toEqual(['gift']);
    expect(b.likes).toBe(0);
  });
});

describe('local likes', () => {
  beforeEach(() => {
    const mem = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    };
  });

  it('counts likes and sorts by them', async () => {
    const store = new LocalStore();
    const a = await store.add({ name: 'A', author: 'me', description: '', kind: 'simple', data: EXAMPLES[0].data, thumbnail: '', tags: ['gift'] });
    const b = await store.add({ name: 'B', author: 'me', description: '', kind: 'simple', data: EXAMPLES[0].data, thumbnail: '', tags: [] });
    expect(await store.like(a.id, true)).toBe(1);
    expect(await store.like(a.id, true)).toBe(2);
    expect(await store.like(a.id, false)).toBe(1);
    const liked = await store.list({ query: '', sort: 'liked' });
    expect(liked.map((x) => x.id)).toEqual([a.id, b.id]);
    expect((await store.list({ query: '', tag: 'gift', sort: 'new' })).map((x) => x.id)).toEqual([a.id]);
  });
});
