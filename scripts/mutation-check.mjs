// mutation-check.mjs — 变异检测 v1
//
// 对 scripts/mutation-invariants.json 中每条高价值不变量，在生产代码上做真实
// 变异（字符串替换，要求 find 唯一匹配），然后只跑 expectRed 指定的目标测试文件
// （node --test，快），记录 red/green，再逐字节还原原文件。任何异常都通过
// try/finally 保证还原。最终写出证据 JSON。
//
// 判读纪律：
//   caught        = 变异下目标测试变红（该测试对此缺陷有判别力）
//   not caught    = 变异下目标测试仍绿（覆盖空洞，诚实上报）
//   invalid-mutation = 变异导致语法/加载崩溃而非行为判定失败（不算 caught，需修正）
//
// 调用（仓库根目录下）：
//   node scripts/mutation-check.mjs
// 可选：
//   node scripts/mutation-check.mjs --sandbox-off   # 用 dangerouslyDisableSandbox 语义跑 node（此处仅切换 cwd 行为）

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const INVARIANTS_PATH = path.join(SCRIPT_DIR, 'mutation-invariants.json');
const EVIDENCE_DIR = path.join(
  REPO_ROOT,
  'docs',
  'rearchitecture',
  'core-v0-cleanup-slice',
  'evidence'
);
const EVIDENCE_PATH = path.join(EVIDENCE_DIR, 'mutation-check-20260914.json');

const MAX_EXCERPT_LINES = 15;

// 仅在确实抓到崩溃信号时把 red 降级为 invalid-mutation。
function detectCrash(stdout, stderr, testsRan) {
  const blob = `${stdout}\n${stderr}`;
  const loadError =
    /SyntaxError:/.test(blob) ||
    /Error \[ERR_MODULE_NOT_FOUND\]/.test(blob) ||
    /does not provide an export/.test(blob) ||
    /Cannot find module/.test(blob) ||
    /ReferenceError:/.test(blob);
  // 没有任何测试被执行却非零退出 → 一定是加载/解析期失败，不是行为判定。
  if (testsRan === 0 && loadError) return true;
  // 标准输出里出现解析错误且根本没有测试计数 → 同样视为崩溃。
  if (/SyntaxError:/.test(blob) && /tests 0/.test(blob)) return true;
  return false;
}

function runTests(testFiles) {
  const args = ['--test', '--test-reporter=spec', ...testFiles];
  const res = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 1 << 26
  });
  const stdout = res.stdout || '';
  const stderr = res.stderr || '';
  const combined = `${stdout}\n${stderr}`;
  // 解析 node --test spec 报告尾部的计数。
  const testsMatch = combined.match(/ℹ tests\s+(\d+)/);
  const failMatch = combined.match(/ℹ fail\s+(\d+)/);
  const testsRan = testsMatch ? Number(testsMatch[1]) : 0;
  const failed = failMatch ? Number(failMatch[1]) : (res.status !== 0 ? 1 : 0);
  const red = failed > 0;
  const crash = detectCrash(stdout, stderr, testsRan);
  return { red, crash, failed, testsRan, combined };
}

function excerpt(combined) {
  const lines = combined.split('\n').filter(l => l.trim().length > 0);
  // 优先取尾部失败信息，最多 15 行。
  return lines.slice(-MAX_EXCERPT_LINES);
}

function applyMutation(content, find, replaceWith) {
  const count = content.split(find).length - 1;
  if (count === 0) return { ok: false, reason: `find 串未匹配（count=0）` };
  if (count > 1) return { ok: false, reason: `find 串不唯一（count=${count}），无法安全替换` };
  const mutated = content.replace(find, replaceWith);
  if (mutated === content) return { ok: false, reason: '替换后内容未变化' };
  return { ok: true, mutated };
}

function main() {
  const raw = readFileSync(INVARIANTS_PATH, 'utf8');
  const doc = JSON.parse(raw);
  const invariants = doc.invariants || [];

  const entries = [];
  let caught = 0;
  const holes = [];
  const invalid = [];

  for (const inv of invariants) {
    const id = inv.id;
    const targetRel = inv.targetFile;
    const targetAbs = path.join(REPO_ROOT, targetRel);
    const testFiles = (inv.expectRed || []).map(f => path.join(REPO_ROOT, f));
    const started = Date.now();
    let status;
    let note = '';
    let combined = '';
    let failed = 0;
    let testsRan = 0;
    let crash = false;

    // 唯一匹配 + 备份 + 应用 + 跑测试 + 还原，全程 try/finally 保证还原。
    let original = null;
    try {
      original = readFileSync(targetAbs, 'utf8'); // 作为字节基准（utf8 往返一致）
      const apply = applyMutation(original, inv.mutation.find, inv.mutation.replaceWith);
      if (!apply.ok) {
        status = 'mutation-error';
        note = apply.reason;
        invalid.push(id);
      } else {
        writeFileSync(targetAbs, apply.mutated, 'utf8');
        const run = runTests(testFiles);
        combined = run.combined;
        failed = run.failed;
        testsRan = run.testsRan;
        crash = run.crash;
        if (crash) {
          status = 'invalid-mutation';
          note = '变异导致语法/加载崩溃（非行为判定失败），不算 caught';
          invalid.push(id);
        } else if (run.red) {
          status = 'caught';
          caught += 1;
        } else {
          status = 'not-caught';
          note = '目标测试在变异下仍绿 —— 覆盖空洞';
          holes.push(id);
        }
      }
    } catch (err) {
      status = 'runner-error';
      note = `执行异常：${err?.message || String(err)}`;
      invalid.push(id);
    } finally {
      if (original !== null) {
        // 逐字节还原：写回原始内容。
        writeFileSync(targetAbs, original, 'utf8');
      }
    }

    const durationMs = Date.now() - started;
    const ex = status === 'caught' || status === 'not-caught' || status === 'invalid-mutation'
      ? excerpt(combined)
      : [];

    entries.push({
      id,
      targetFile: targetRel,
      mutationDescription: inv.mutationNote || inv.description || '',
      expectRed: inv.expectRed || [],
      status,
      caught: status === 'caught',
      failedTests: failed,
      testsRan,
      durationMs,
      note,
      failureExcerpt: ex
    });

    console.log(
      `[${id}] ${status}` +
      (status === 'caught' ? ' (caught)' : '') +
      (status === 'not-caught' ? ' (COVERAGE HOLE)' : '') +
      (status === 'invalid-mutation' ? ' (invalid-mutation)' : '') +
      ` — ${inv.mutationNote || ''}`
    );
  }

  const total = invariants.length;
  const score = `${caught}/${total}`;
  let verdict;
  if (invalid.length) {
    verdict = `${score} caught；无效/错误变异 ${invalid.join(',')}（需修正变异定义后重跑）`;
  } else if (holes.length) {
    verdict = `${score} caught；覆盖空洞：${holes.join(', ')}（测试对该缺陷无判别力）`;
  } else {
    verdict = `${score} caught；全部目标测试对该类缺陷均有判别力，无覆盖空洞`;
  }

  const evidence = {
    generatedAt: new Date().toISOString(),
    runner: 'scripts/mutation-check.mjs',
    invariantsFile: 'scripts/mutation-invariants.json',
    score,
    caught,
    total,
    coverageHoles: holes,
    invalidMutations: invalid,
    verdict,
    entries
  };

  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2) + '\n', 'utf8');

  console.log('\n=== mutation-check verdict ===');
  console.log(`score: ${score}`);
  console.log(`verdict: ${verdict}`);
  console.log(`evidence: ${path.relative(REPO_ROOT, EVIDENCE_PATH)}`);
}

main();
