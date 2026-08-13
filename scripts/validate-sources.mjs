import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const EXPECTED = '47f943859bef60e4160492346772ded9b24f765a';
const root = process.cwd();
const sourceRoot = path.resolve(root, process.env.DEEPSEEK_HARNESS_SOURCE_ROOT ?? '../../deepseek-harness');
const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
if (actual !== EXPECTED) throw new Error(`源码提交不匹配：期望 ${EXPECTED}，实际 ${actual}`);

const docsRoot = path.join(root, 'src/content/docs');
const evidence = [
  ['docs/architecture.md', 129],
  ['vendor/cordis/src/context.ts', 145],
  ['apps/cli/src/bin.ts', 52],
  ['apps/cli/src/profile-boot.ts', 283],
  ['apps/web/src/main.ts', 10],
  ['packages/boot/app-boot/src/index.ts', 829],
  ['packages/core/agent/src/index.ts', 256],
  ['packages/core/agent-loop/src/agent.ts', 482],
  ['packages/core/session/src/types.ts', 336],
  ['packages/core/session/src/index.ts', 749],
  ['packages/core/tools/src/index.ts', 1425],
  ['packages/core/system-prompt/src/index.ts', 535],
  ['packages/llm/llm/src/index.ts', 815],
  ['packages/llm/llm-deepseek/src/adapter.ts', 260],
  ['packages/llm/llm-deepseek/src/serialize.ts', 177],
  ['packages/llm/llm-deepseek/src/translate.ts', 184],
  ['packages/session/session-persistence/src/coordinator.ts', 1133],
  ['packages/skill/skill/src/index.ts', 560],
  ['packages/skill/tool-skill/src/index.ts', 225],
  ['packages/subagent/subagent/src/index.ts', 425],
  ['packages/subagent/tool-subagent/src/index.ts', 430],
];

for (const [file, end] of evidence) {
  const full = path.join(sourceRoot, file);
  await access(full);
  const lines = (await readFile(full, 'utf8')).split(/\r?\n/).length;
  if (lines < end) throw new Error(`${file} 只有 ${lines} 行，无法解析引用到 ${end}`);
}

const { glob } = await import('node:fs/promises');
let chapterCount = 0;
for await (const file of glob('chapters/*.md', { cwd: docsRoot })) {
  const body = await readFile(path.join(docsRoot, file), 'utf8');
  if (!body.includes('## 0. 本章学习目标') || !body.includes('## 1. 一句话讲明白')) {
    throw new Error(`${file} 缺少必需教学章节`);
  }
  chapterCount += 1;
}
if (chapterCount !== 12) throw new Error(`规划 12 章，实际 ${chapterCount} 章`);
console.log(`源码证据通过：${evidence.length} 个文件，12 章，提交 ${EXPECTED.slice(0, 8)}`);
