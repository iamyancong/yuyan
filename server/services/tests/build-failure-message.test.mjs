import assert from 'node:assert/strict';
import os from 'node:os';
import test from 'node:test';
import {
  createBuildSlotLimiter,
  executeBuildWithOomRetry,
  isNodeHeapOomError,
} from '../build-isolation-service.mjs';
import { formatLocalCommandFailureMessage, runLocalCommand } from '../deploy-service.mjs';
import { resolveStderrLogLevel } from '../../utils/process-output.mjs';

const HEAP_OOM = 'FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory';

test('formatLocalCommandFailureMessage：普通退出码不带信号，被信号杀死时带上信号名（#58）', () => {
  assert.equal(formatLocalCommandFailureMessage('构建产物', 1, null, 'boom'), '构建产物 执行失败，退出码 1\nboom');
  assert.equal(
    formatLocalCommandFailureMessage('构建产物 2/2', null, 'SIGKILL', ''),
    '构建产物 2/2 执行失败，退出码 null（信号 SIGKILL）\n'
  );
  // 有退出码时信号无意义，不追加
  assert.equal(formatLocalCommandFailureMessage('构建产物', 137, 'SIGKILL', 'Killed'), '构建产物 执行失败，退出码 137\nKilled');
});

test('runLocalCommand：命令进程本身被 SIGKILL 杀死时错误信息为「退出码 null（信号 SIGKILL）」', { skip: process.platform === 'win32' }, async () => {
  await assert.rejects(
    runLocalCommand('kill -KILL $$', { cwd: os.tmpdir(), env: process.env, label: '构建产物' }),
    (error) => {
      assert.match(error.message, /^构建产物 执行失败，退出码 null（信号 SIGKILL）/);
      return true;
    }
  );
});

test('runLocalCommand：shell 里的子进程被 SIGKILL 时由 shell 报告退出码 137（诊断按 137 归类）', { skip: process.platform === 'win32' }, async () => {
  await assert.rejects(
    runLocalCommand(`node -e "process.kill(process.pid, 'SIGKILL')"; exit $?`, { cwd: os.tmpdir(), env: process.env, label: '构建产物' }),
    (error) => {
      assert.match(error.message, /^构建产物 执行失败，退出码 137\n/);
      return true;
    }
  );
});

test('runLocalCommand：普通非 0 退出保留原格式并附带 stderr', async () => {
  await assert.rejects(
    runLocalCommand(`node -e "console.error('Error: boom'); process.exit(3)"`, { cwd: os.tmpdir(), env: process.env, label: '构建产物' }),
    (error) => {
      assert.match(error.message, /^构建产物 执行失败，退出码 3\nError: boom/);
      assert.doesNotMatch(error.message, /信号/);
      return true;
    }
  );
});

test('isNodeHeapOomError：带不带信号后缀都能识别 Node 堆溢出；只有 Killed 不算', () => {
  assert.equal(isNodeHeapOomError(new Error(formatLocalCommandFailureMessage('构建产物', null, 'SIGABRT', HEAP_OOM))), true);
  assert.equal(isNodeHeapOomError(new Error(formatLocalCommandFailureMessage('构建产物', 134, null, HEAP_OOM))), true);
  assert.equal(isNodeHeapOomError(new Error(formatLocalCommandFailureMessage('构建产物', null, 'SIGKILL', 'Killed'))), false);
});

/**
 * 跑一次「首次失败、重试成功」的构建，返回是否触发了扩容重试。
 * @param {Error} firstError 首次构建抛出的错误
 */
async function runWithFirstFailure(firstError) {
  const limiter = createBuildSlotLimiter({ maxConcurrent: 2, totalSystemMemoryMb: 8192, reservedSystemMemoryMb: 2048 });
  const attempts = [];
  try {
    const result = await executeBuildWithOomRetry({
      initialHeapMb: 2048,
      limiter,
      runBuild: async (heapMb, isRetry) => {
        attempts.push({ heapMb, isRetry });
        if (!isRetry) throw firstError;
      },
    });
    return { retried: result.retried, attempts, error: null };
  } catch (error) {
    return { retried: false, attempts, error };
  } finally {
    assert.equal(limiter.getStats().usedMemoryMb, 0);
  }
}

test('OOM 自动扩容重试：信号后缀不影响触发；SIGKILL/Killed 不触发重试并原样抛出', async () => {
  const withSignal = await runWithFirstFailure(new Error(formatLocalCommandFailureMessage('构建产物', null, 'SIGABRT', HEAP_OOM)));
  assert.equal(withSignal.retried, true);
  assert.equal(withSignal.attempts.length, 2);
  assert.ok(withSignal.attempts[1].heapMb > withSignal.attempts[0].heapMb);

  const withoutSignal = await runWithFirstFailure(new Error(formatLocalCommandFailureMessage('构建产物', 134, null, HEAP_OOM)));
  assert.equal(withoutSignal.retried, true);

  const killed = await runWithFirstFailure(new Error(formatLocalCommandFailureMessage('构建产物', null, 'SIGKILL', 'Killed')));
  assert.equal(killed.retried, false);
  assert.equal(killed.attempts.length, 1);
  assert.match(killed.error.message, /退出码 null（信号 SIGKILL）/);
});

test('resolveStderrLogLevel：超长单行只看前 2000 字符判级，且不会因正则回溯卡住', () => {
  const started = Date.now();
  assert.equal(resolveStderrLogLevel(`${'x'.repeat(200000)}`), 'info');
  assert.ok(Date.now() - started < 500, `20 万字符单行判级耗时 ${Date.now() - started}ms`);
  // 错误关键字在 2000 字符以内照常判为 error；超出 2000 字符的部分不参与判级
  assert.equal(resolveStderrLogLevel(`Error: boom ${'x'.repeat(5000)}`), 'error');
  assert.equal(resolveStderrLogLevel(`${'a'.repeat(2100)} Error: boom`), 'info');
});
