import assert from 'node:assert/strict';
import test from 'node:test';
import { detectPlatform, detectMacCpuArch } from '../platformDetect.ts';

test('detectPlatform: 在纯 Node.js / SSR 环境下安全兜底', () => {
  const info = detectPlatform();
  assert.ok(info);
  assert.ok(info.platform);
  assert.ok(info.arch);
  assert.ok(info.platformName);
});

test('detectMacCpuArch: 当无 WebGL 环境时，现代 macOS 默认安全推荐 aarch64 (Apple Silicon)', () => {
  const result = detectMacCpuArch();
  assert.equal(result.arch, 'aarch64');
  assert.equal(result.source, 'userAgent');
});

test('detectMacCpuArch: 模拟 WebGL 硬件渲染器识别 Apple Silicon 芯片', () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;

  try {
    // 模拟浏览器全局对象及 WebGL
    (globalThis as any).window = {};
    (globalThis as any).document = {
      createElement(tag: string) {
        if (tag === 'canvas') {
          return {
            getContext(type: string) {
              if (type === 'webgl' || type === 'experimental-webgl') {
                return {
                  getExtension(ext: string) {
                    if (ext === 'WEBGL_debug_renderer_info') {
                      return { UNMASKED_RENDERER_WEBGL: 37446 };
                    }
                    return null;
                  },
                  getParameter(param: number) {
                    if (param === 37446) {
                      return 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Max, Version 2.1)';
                    }
                    return '';
                  },
                };
              }
              return null;
            },
          };
        }
        return {};
      },
    };

    const result = detectMacCpuArch();
    assert.equal(result.arch, 'aarch64');
    assert.equal(result.source, 'webgl');
  } finally {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  }
});

test('detectMacCpuArch: 模拟 WebGL 硬件渲染器识别传统 Intel Mac 芯片', () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;

  try {
    (globalThis as any).window = {};
    (globalThis as any).document = {
      createElement(tag: string) {
        if (tag === 'canvas') {
          return {
            getContext(type: string) {
              if (type === 'webgl' || type === 'experimental-webgl') {
                return {
                  getExtension(ext: string) {
                    if (ext === 'WEBGL_debug_renderer_info') {
                      return { UNMASKED_RENDERER_WEBGL: 37446 };
                    }
                    return null;
                  },
                  getParameter(param: number) {
                    if (param === 37446) {
                      return 'ANGLE (Intel, Intel(R) Iris(TM) Plus Graphics 655, Version 2.1)';
                    }
                    return '';
                  },
                };
              }
              return null;
            },
          };
        }
        return {};
      },
    };

    const result = detectMacCpuArch();
    assert.equal(result.arch, 'x86_64');
    assert.equal(result.source, 'webgl');
  } finally {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  }
});

test('detectPlatform: 即使 macOS 浏览器 UA 被冻结为 Intel，也不再误判为 Intel', () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
      },
      configurable: true,
      writable: true,
    });

    const info = detectPlatform();
    assert.equal(info.platform, 'darwin');
    // 在无 WebGL 独显干扰时，默认推断为 Apple Silicon (aarch64)
    assert.equal(info.arch, 'aarch64');
    assert.equal(info.platformName, 'macOS (Apple Silicon)');
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, 'navigator', originalDescriptor);
    }
  }
});

test('detectPlatform: Windows 环境精准识别', () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
      },
      configurable: true,
      writable: true,
    });

    const info = detectPlatform();
    assert.equal(info.platform, 'windows');
    assert.equal(info.arch, 'x86_64');
    assert.equal(info.platformName, 'Windows (x64)');
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, 'navigator', originalDescriptor);
    }
  }
});
