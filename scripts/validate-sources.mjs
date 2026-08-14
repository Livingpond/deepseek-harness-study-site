import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const EXPECTED = '47f943859bef60e4160492346772ded9b24f765a';
const root = process.cwd();
const sourceRoot = path.resolve(root, process.env.DEEPSEEK_HARNESS_SOURCE_ROOT ?? '../../deepseek-harness');
const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
if (actual !== EXPECTED) throw new Error(`源码提交不匹配：期望 ${EXPECTED}，实际 ${actual}`);

const docsRoot = path.join(root, 'src/content/docs');
const fixedSourceUrl = `https://github.com/deepseek-ai/deepseek-harness/blob/${EXPECTED}/`;
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
let totalChapterLines = 0;
let totalChapterCharacters = 0;
let shortestChapter = null;
for await (const file of glob('chapters/*.md', { cwd: docsRoot })) {
  const body = await readFile(path.join(docsRoot, file), 'utf8');
  const lines = body.split(/\r?\n/);
  if (!body.includes('## 0. 本章学习目标') || !body.includes('## 1. 一句话讲明白')) {
    throw new Error(`${file} 缺少必需教学章节`);
  }
  if (lines.length < 220 || body.length < 7000) {
    throw new Error(`${file} 内容不足：${lines.length} 行、${body.length} 字符，最低要求为 220 行、7000 字符`);
  }

  const teachingSections = body.match(/^#{2,3}\s+.+$/gm) ?? [];
  if (teachingSections.length < 10) {
    throw new Error(`${file} 只有 ${teachingSections.length} 个教学段落，最低要求为 10 个`);
  }

  const codeFences = body.match(/^```/gm) ?? [];
  if (codeFences.length < 4) {
    throw new Error(`${file} 至少需要两个完整代码块或图示，当前围栏数为 ${codeFences.length}`);
  }
  if (!/^\|.+\|\s*$/m.test(body) || !/^\|\s*:?-+/m.test(body)) {
    throw new Error(`${file} 缺少用于真实差异比较的 Markdown 表格`);
  }
  if (!/自测/.test(body) || !/练习/.test(body)) {
    throw new Error(`${file} 缺少费曼自测或分层练习`);
  }
  if (!/(失败|错误|停止|边界|恢复|安全)/.test(body)) {
    throw new Error(`${file} 没有讲清失败、停止或安全边界`);
  }
  if (body.includes('/master/')) {
    throw new Error(`${file} 包含漂移的 master 源码链接`);
  }

  const sourceLinkPattern = /https:\/\/github\.com\/deepseek-ai\/deepseek-harness\/blob\/([0-9a-f]{40})\/([^\s)#]+)(?:#L(\d+)(?:-L(\d+))?)?/g;
  const sourceFiles = new Set();
  let sourceLinkCount = 0;
  let anchoredSourceLinkCount = 0;
  for (const match of body.matchAll(sourceLinkPattern)) {
    const [, revision, encodedPath, startText, endText] = match;
    if (revision !== EXPECTED) throw new Error(`${file} 包含错误提交 ${revision}`);
    const sourcePath = decodeURIComponent(encodedPath);
    const sourceFile = path.join(sourceRoot, sourcePath);
    await access(sourceFile);
    const sourceLines = (await readFile(sourceFile, 'utf8')).split(/\r?\n/).length;
    const start = Number(startText ?? 1);
    const end = Number(endText ?? start);
    if (start < 1 || end < start || end > sourceLines) {
      throw new Error(`${file} 的源码锚点越界：${sourcePath}#L${start}-L${end}，文件共 ${sourceLines} 行`);
    }
    sourceFiles.add(sourcePath);
    sourceLinkCount += 1;
    if (startText) anchoredSourceLinkCount += 1;
  }
  if (sourceLinkCount < 8 || anchoredSourceLinkCount < 8 || sourceFiles.size < 5) {
    throw new Error(
      `${file} 源码证据不足：${sourceLinkCount} 个固定链接、${anchoredSourceLinkCount} 个行锚点、${sourceFiles.size} 个文件，最低要求为 8 个链接、8 个行锚点、5 个文件`,
    );
  }
  if (!body.includes(fixedSourceUrl)) {
    throw new Error(`${file} 没有使用固定提交源码链接`);
  }
  totalChapterLines += lines.length;
  totalChapterCharacters += body.length;
  if (!shortestChapter || lines.length < shortestChapter.lines) {
    shortestChapter = { file, lines: lines.length, characters: body.length };
  }
  chapterCount += 1;
}
if (chapterCount !== 12) throw new Error(`规划 12 章，实际 ${chapterCount} 章`);
console.log(
  `源码证据通过：${evidence.length} 个基础文件，12 章，${totalChapterLines} 行、${totalChapterCharacters} 字符；最短章节 ${shortestChapter.file} ${shortestChapter.lines} 行；提交 ${EXPECTED.slice(0, 8)}`,
);
