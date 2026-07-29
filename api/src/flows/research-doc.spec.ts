import { FlowRunnerService } from './flows-runner.service';

/**
 * BEA-1193 — the owner's rule: always keep a markdown document of the research, whatever skill is
 * attached at the end. His run is why. Two searches gathered 12,400 characters, the reasoning steps
 * came back empty, an attached skill produced 125 — and all 12,400 were thrown away, because parts
 * are only saved when they feed the merge AND have content.
 */
const svc = () => new FlowRunnerService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);

const graph = {
  nodes: [
    { id: 'q', data: { kind: 'question' } },
    { id: 'b1', data: { kind: 'subquestion', sub: 'Graduation numbers' } },
    { id: 's1', data: { kind: 'tool', label: 'Web search' } },
    { id: 'a1', data: { kind: 'ask_ai', label: 'Ask AI' } },
    { id: 'm', data: { kind: 'merge', label: 'Merge' } },
    { id: 'o', data: { kind: 'output', label: 'Output' } },
  ],
};

describe('the research is always kept as markdown (BEA-1193)', () => {
  it('keeps the gathered research even when the merge AND the final step produced nothing', () => {
    const results: any = {
      q: { status: 'done', output: 'Study placements in six cities' },
      s1: { status: 'done', output: 'City | Engineering | MBA\nPune | 37,314 | n/a' },
      a1: { status: 'done', output: '' },   // the reasoning step came back empty
      m: { status: 'done', output: '' },    // so did the merge
      o: { status: 'done', output: '' },
    };
    const md = (svc() as any).researchMarkdown('Placement Report', graph, results, '');
    expect(md).toContain('Study placements in six cities');
    expect(md).toContain('Graduation numbers');
    expect(md).toContain('37,314');                       // the work survives
    expect(md).toContain('final step produced nothing');  // and says why it is the record
  });

  it('includes the finished result when there IS one', () => {
    const results: any = { q: { status: 'done', output: 'Q' }, s1: { status: 'done', output: 'findings' } };
    const md = (svc() as any).researchMarkdown('R', graph, results, '<html>a report</html>');
    expect(md).toContain('The finished result');
    expect(md).toContain('a report');
    expect(md).toContain('findings'); // the research is kept ALONGSIDE what the skill made
  });

  it('saves nothing when the run genuinely gathered nothing', () => {
    const results: any = { q: { status: 'done', output: 'Q' }, s1: { status: 'done', output: '' } };
    expect((svc() as any).researchMarkdown('R', graph, results, '')).toBeNull();
  });
});
