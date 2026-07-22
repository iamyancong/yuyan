import assert from 'node:assert/strict';
import test from 'node:test';
import { endArchiveSseWithError } from '../archive-sse.mjs';

test('SSH 凭据错误会输出 SSE error 并正常结束响应', () => {
  const writes = [];
  let flushed = false;
  let ended = false;
  const response = {
    writableEnded: false,
    write: (value) => writes.push(value),
    flush: () => { flushed = true; },
    end: () => { ended = true; },
  };

  endArchiveSseWithError(response, new Error('服务器凭据解密失败'));

  assert.equal(flushed, true);
  assert.equal(ended, true);
  assert.equal(writes.length, 1);
  assert.match(writes[0], /"error":"服务器凭据解密失败"/);
  assert.equal(writes[0].endsWith('\n\n'), true);
});
