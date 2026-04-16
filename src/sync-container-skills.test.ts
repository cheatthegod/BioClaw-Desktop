import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { syncContainerSkillsToSession } from './sync-container-skills.js';

describe('syncContainerSkillsToSession', () => {
  let tmp: string;

  afterEach(() => {
    if (tmp && fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true });
  });

  it('copies skill dirs recursively including nested folders', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bioclaw-skills-'));
    const src = path.join(tmp, 'src');
    const dst = path.join(tmp, 'dst');
    fs.mkdirSync(path.join(src, 'bio-tools', 'templates'), { recursive: true });
    fs.writeFileSync(path.join(src, 'bio-tools', 'SKILL.md'), 'root');
    fs.writeFileSync(path.join(src, 'bio-tools', 'templates', 'x.py'), 'py');
    fs.mkdirSync(path.join(src, 'other'), { recursive: true });
    fs.writeFileSync(path.join(src, 'other', 'SKILL.md'), 'other');

    syncContainerSkillsToSession(src, dst);

    expect(fs.readFileSync(path.join(dst, 'bio-tools', 'SKILL.md'), 'utf8')).toBe('root');
    expect(fs.readFileSync(path.join(dst, 'bio-tools', 'templates', 'x.py'), 'utf8')).toBe('py');
    expect(fs.readFileSync(path.join(dst, 'other', 'SKILL.md'), 'utf8')).toBe('other');
  });
});
