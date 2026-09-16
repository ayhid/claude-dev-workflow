// Emit NUL-delimited paths owned by this checkout. Keep this separate from the
// shell gate so Git failures propagate and filenames never pass through lines.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function lintInventory(root) {
  const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  }).split('\0').filter(Boolean);
  const excluded = new Map();
  function excludedDirectory(dir) {
    if (dir === '.') return false;
    if (!excluded.has(dir)) {
      const parts = dir.split('/');
      excluded.set(dir, parts.some(p => ['.git', 'node_modules', '.worktrees'].includes(p))
        || dir === '.husky/_' || dir.endsWith('/.husky/_')
        || existsSync(join(root, dir, '.git'))
        || excludedDirectory(dirname(dir)));
    }
    return excluded.get(dir);
  }
  return [...new Set(paths)].sort().filter(path => {
    const shell = path.endsWith('.sh') || /^\.husky\/[^./][^/]*$/.test(path);
    if (!shell && !path.endsWith('.mjs')) return false;
    if (excludedDirectory(dirname(path))) return false;
    try {
      // Do not follow symlinks into dependencies or another checkout.
      for (let dir = dirname(path); dir !== '.'; dir = dirname(dir)) {
        if (lstatSync(join(root, dir)).isSymbolicLink()) return false;
      }
      return lstatSync(join(root, path)).isFile();
    } catch (error) {
      if (error.code === 'ENOENT') return false; // tracked deletion
      throw error;
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  for (const path of lintInventory(process.cwd())) process.stdout.write(`./${path}\0`);
}
