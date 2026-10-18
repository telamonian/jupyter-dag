/**
 * Unit tests for `dag/analysis.ts` against a fake kernel client.
 *
 * The client records what it was asked to analyse and answers from a table, so the tests check
 * what the cache sends (only changed code cells, in one request) and what it derives (names and
 * wires, with error results left out).
 */
import { CellAnalysisCache } from '../dag/analysis';
import type { IAnalyzableCell } from '../dag/analysis';
import type { IAnalyzeCellInput, IAnalyzedCell } from '../dag/protocol';

/** A cell stub with a mutable source. */
function cell(id: string, source: string, type = 'code'): IAnalyzableCell & { source: string } {
  const stub = {
    id,
    type,
    source,
    sharedModel: { getSource: () => stub.source }
  };
  return stub;
}

/** A client that answers every cell with the names its single-letter source implies: `x = y` defines x and references y. */
class FakeClient {
  readonly requests: IAnalyzeCellInput[][] = [];
  async analyze(cells: IAnalyzeCellInput[]): Promise<IAnalyzedCell[]> {
    this.requests.push(cells);
    return cells.map(({ cell_id, code }) => {
      if (code === 'bad') {
        return { cell_id, status: 'error', ename: 'SyntaxError', evalue: 'bad' };
      }
      const [lhs, rhs] = code.split('=').map(s => s.trim());
      return {
        cell_id,
        status: 'ok',
        defined: lhs ? [lhs] : [],
        referenced: rhs ? [rhs] : [],
        deleted: [],
        dynamic: false
      };
    });
  }
}

describe('CellAnalysisCache', () => {
  it('sends only code cells whose source changed, in one request', async () => {
    const client = new FakeClient();
    const cache = new CellAnalysisCache(client);
    const a = cell('a', 'x = ');
    const b = cell('b', 'y = x');
    const md = cell('m', '# title', 'markdown');
    await cache.refresh([a, b, md]);
    expect(client.requests).toEqual([
      [
        { cell_id: 'a', code: 'x = ' },
        { cell_id: 'b', code: 'y = x' }
      ]
    ]);
    await cache.refresh([a, b, md]);
    expect(client.requests).toHaveLength(1); // nothing changed, nothing sent
    b.source = 'y = q';
    await cache.refresh([a, b, md]);
    expect(client.requests[1]).toEqual([{ cell_id: 'b', code: 'y = q' }]);
    expect(cache.get('b')).toMatchObject({ status: 'ok', referenced: ['q'] });
    expect(cache.get('m')).toBeUndefined();
  });
  it('derives names and wires, leaving out cells that did not parse', async () => {
    const client = new FakeClient();
    const cache = new CellAnalysisCache(client);
    await cache.refresh([cell('a', 'x = '), cell('b', 'bad'), cell('c', 'z = x')]);
    expect(cache.names(['a', 'b', 'c'])).toEqual([
      { id: 'a', defined: ['x'], referenced: [] },
      { id: 'c', defined: ['z'], referenced: ['x'] }
    ]);
    expect(cache.wires(['a', 'b', 'c']).map(w => w.id)).toEqual(['a->c']);
    expect(cache.get('b')?.status).toBe('error');
  });
  it('forgets on delete and clear', async () => {
    const client = new FakeClient();
    const cache = new CellAnalysisCache(client);
    const a = cell('a', 'x = ');
    await cache.refresh([a]);
    cache.delete('a');
    expect(cache.get('a')).toBeUndefined();
    await cache.refresh([a]);
    expect(client.requests).toHaveLength(2); // re-sent after the delete
    cache.clear();
    expect(cache.results().size).toBe(0);
  });
});
