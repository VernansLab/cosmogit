import { describe, expect, it } from 'vitest';
import { parseAny, parseGitLog, parseGourceLog } from '../src/data/parse';

const RS = '\x1e';
const US = '\x1f';
const gitLog = [
  `${RS}aaa${US}100${US}Ann${US}ann@x${US}${US}init`,
  '',
  ':000000 100644 0000 1111 A\tsrc/a.ts',
  ':000000 100644 0000 2222 A\tREADME.md',
  '10\t0\tsrc/a.ts',
  '3\t0\tREADME.md',
  '',
  `${RS}bbb${US}200${US}Bob${US}bob@x${US}aaa${US}move a`,
  '',
  ':100644 100644 1111 3333 R087\tsrc/a.ts\tlib/a.ts',
  ':100644 000000 2222 0000 D\tREADME.md',
  '2\t1\t{src => lib}/a.ts',
  '0\t3\tREADME.md',
  '',
  `${RS}ccc${US}300${US}ann${US}ann@y${US}aaa bbb${US}Merge`,
  '',
].join('\n');

describe('parseGitLog', () => {
  const log = parseGitLog(gitLog, 'demo');

  it('reads commits, authors and merges', () => {
    expect(log.commits.map((c) => c.hash)).toEqual(['aaa', 'bbb', 'ccc']);
    expect(log.authors.map((a) => a.name)).toEqual(['Ann', 'Bob']);
    expect(log.commits[2].author).toBe(0);
    expect(log.commits[2].isMerge).toBe(true);
    expect(log.commits[0].isMerge).toBe(false);
  });

  it('pairs raw status with numstat counts', () => {
    expect(log.commits[0].changes).toEqual([
      { path: 'src/a.ts', op: 'A', add: 10, del: 0 },
      { path: 'README.md', op: 'A', add: 3, del: 0 },
    ]);
    expect(log.commits[1].changes).toEqual([
      { path: 'lib/a.ts', from: 'src/a.ts', op: 'R', add: 2, del: 1 },
      { path: 'README.md', op: 'D', add: 0, del: 3 },
    ]);
  });
});

describe('parseGourceLog', () => {
  it('groups lines by timestamp and user', () => {
    const log = parseGourceLog('1|ann|A|/a.txt\n1|ann|A|/b.txt\n2|bob|M|/a.txt|FF0000\n');
    expect(log.commits).toHaveLength(2);
    expect(log.commits[0].changes.map((c) => c.path)).toEqual(['a.txt', 'b.txt']);
    expect(log.commits[1].changes[0].op).toBe('M');
  });
});

describe('parseAny', () => {
  it('detects the format', () => {
    expect(parseAny(gitLog).commits).toHaveLength(3);
    expect(parseAny('1|ann|A|/a').commits).toHaveLength(1);
    expect(parseAny('{"repo":"x","authors":[],"commits":[]}').repo).toBe('x');
  });
});
