import { parseListObjects } from './list-objects';

describe('parseListObjects (TV Time Go %v format)', () => {
  it('parses an empty list / []', () => {
    expect(parseListObjects('[]').objects).toEqual([]);
    expect(parseListObjects('').objects).toEqual([]);
    expect(parseListObjects(null as any).objects).toEqual([]);
  });

  it('parses a single series object with numeric id', () => {
    const r = parseListObjects('[map[created_at:1.56338973e+09 id:73739 type:series]]');
    expect(r.objects).toHaveLength(1);
    expect(r.objects[0]).toMatchObject({ type: 'series', id: 73739, uuid: null });
    expect(r.objects[0].createdAt?.getTime()).toBeCloseTo(1563389730 * 1000, -3);
  });

  it('parses multiple series objects and preserves order', () => {
    const r = parseListObjects(
      '[map[created_at:1.56338973e+09 id:73739 type:series] map[created_at:1.590688686e+09 id:270408 type:series]]',
    );
    expect(r.objects.map((o) => o.id)).toEqual([73739, 270408]);
  });

  it('parses a movie object with a uuid (no name source)', () => {
    const r = parseListObjects('[map[created_at:1.614733632e+09 type:movie uuid:6254be80-6383-4767-961e-2f13d98e2676]]');
    expect(r.objects[0]).toMatchObject({ type: 'movie', id: null, uuid: '6254be80-6383-4767-961e-2f13d98e2676' });
  });

  it('parses mixed movie and series objects', () => {
    const r = parseListObjects(
      '[map[created_at:1.6e+09 type:movie uuid:abc] map[created_at:1.5e+09 id:42 type:series]]',
    );
    expect(r.objects.map((o) => o.type)).toEqual(['movie', 'series']);
  });

  it('handles scientific-notation and plain epoch timestamps', () => {
    expect(parseListObjects('[map[created_at:1.614733632e+09 id:1 type:series]]').objects[0].createdAt).toBeInstanceOf(Date);
    expect(parseListObjects('[map[created_at:1614733632 id:1 type:series]]').objects[0].createdAt).toBeInstanceOf(Date);
  });

  it('rejects bogus negative timestamps -> null', () => {
    expect(parseListObjects('[map[created_at:-6.21355968e+10 id:1 type:series]]').objects[0].createdAt).toBeNull();
  });

  it('parses an object with both id and uuid', () => {
    const o = parseListObjects('[map[created_at:1.6e+09 id:99 type:series uuid:zzz]]').objects[0];
    expect(o.id).toBe(99);
    expect(o.uuid).toBe('zzz');
  });

  it('tolerates fields in a different order', () => {
    const o = parseListObjects('[map[type:series id:5 created_at:1.6e+09]]').objects[0];
    expect(o).toMatchObject({ type: 'series', id: 5 });
  });

  it('ignores unknown additional fields (e.g. fanart/posters url groups)', () => {
    const r = parseListObjects(
      '[map[created_at:1.6e+09 fanart:[https://a.com/x.jpg https://b.com/y.jpg] id:7 type:series posters:[https://c.com/z.jpg] updated_at:1.6e+09]]',
    );
    expect(r.errors).toHaveLength(0);
    expect(r.objects[0].id).toBe(7);
  });

  it('handles missing created_at', () => {
    expect(parseListObjects('[map[id:1 type:series]]').objects[0].createdAt).toBeNull();
  });

  it('handles <nil> values', () => {
    const o = parseListObjects('[map[created_at:<nil> id:1 type:series uuid:<nil>]]').objects[0];
    expect(o.createdAt).toBeNull();
    expect(o.uuid).toBeNull();
  });

  it('reports a malformed object among valid ones without throwing', () => {
    const r = parseListObjects('[map[id:1 type:series] garbage map[id:2 type:series]]');
    // the garbage token is skipped; valid maps still parsed
    expect(r.objects.map((o) => o.id)).toEqual([1, 2]);
    expect(() => parseListObjects('][not valid at all')).not.toThrow();
  });

  it('deduplicates are left to the caller (parser preserves source entries)', () => {
    const r = parseListObjects('[map[id:1 type:series] map[id:1 type:series]]');
    expect(r.objects).toHaveLength(2);
  });
});
