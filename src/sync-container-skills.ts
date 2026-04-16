/**
 * Copy each top-level directory under container/skills/ into the destination
 * skills folder recursively (supports nested dirs e.g. bio-tools/templates/).
 */
import fs from 'fs';
import path from 'path';

function copyDirRecursive(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

export function syncContainerSkillsToSession(skillsSrc: string, skillsDstRoot: string): void {
  if (!fs.existsSync(skillsSrc)) return;
  for (const name of fs.readdirSync(skillsSrc)) {
    const srcDir = path.join(skillsSrc, name);
    if (!fs.statSync(srcDir).isDirectory()) continue;
    const dstDir = path.join(skillsDstRoot, name);
    copyDirRecursive(srcDir, dstDir);
  }
}
