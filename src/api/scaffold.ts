import axios from 'axios';

export interface CreateMicroAppPayload {
  appName: string;
  appNameZh: string;
  port: number;
  activeRule: string;
  apiBase: string;
  proxyTarget: string;
  description?: string;
  createRepo?: boolean;
  gitlabHost?: string;
  gitlabToken?: string;
  namespaceId?: string;
  visibility?: 'private' | 'internal' | 'public';
  framework?: 'vue3' | 'react';
}

export interface CreateMicroAppResponse {
  success: boolean;
  data: {
    appName: string;
    appNameZh: string;
    activeRule: string;
    standaloneBase: string;
    apiBase: string;
    proxyTarget: string;
    description: string;
    gitlab?: {
      httpUrl: string;
      webUrl: string;
      id: number;
      path_with_namespace?: string;
    } | null;
    downloadPath?: string | null;
  };
}

export type ScaffoldProgressEvent =
  | {
      type: 'stage';
      stage: string;
      percent: number;
      message: string;
      detail?: string;
      timestamp: string;
    }
  | {
      type: 'log';
      level?: 'info' | 'success' | 'warn' | 'error';
      stage?: string;
      message: string;
      timestamp: string;
    }
  | {
      type: 'result';
      data: CreateMicroAppResponse['data'];
      timestamp: string;
    }
  | {
      type: 'error';
      stage?: string;
      message: string;
      timestamp: string;
    };

export interface CreateMicroAppProgressOptions {
  signal?: AbortSignal;
  onEvent?: (event: ScaffoldProgressEvent) => void;
}

import { getApiBase } from '@/utils/env';

const client = axios.create({ baseURL: getApiBase('/scaffold-api') });

export const createMicroApp = (payload: CreateMicroAppPayload) => client.post('/create', payload);

const parseJsonOrText = async (response: Response) => {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

export async function createMicroAppWithProgress(payload: CreateMicroAppPayload, options: CreateMicroAppProgressOptions = {}) {
  const response = await fetch(getApiBase('/scaffold-api/create?stream=1'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/x-ndjson',
    },
    body: JSON.stringify(payload),
    signal: options.signal,
  });

  if (!response.ok && !response.body) {
    const errorBody = await parseJsonOrText(response);
    const message = typeof errorBody === 'string' ? errorBody : errorBody?.error || errorBody?.message || '创建失败';
    throw new Error(message);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!response.body || contentType.includes('application/json')) {
    const data = await parseJsonOrText(response);
    if (!response.ok) {
      const message = typeof data === 'string' ? data : data?.error || data?.message || '创建失败';
      throw new Error(message);
    }

    return (data?.data || data) as CreateMicroAppResponse['data'];
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: CreateMicroAppResponse['data'] | null = null;

  const consumeLine = (rawLine: string) => {
    const line = rawLine.trim();
    if (!line) return;

    const event = JSON.parse(line) as ScaffoldProgressEvent;
    options.onEvent?.(event);

    if (event.type === 'result') {
      result = event.data;
    }

    if (event.type === 'error') {
      throw new Error(event.message || '创建失败');
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const rawLine = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        consumeLine(rawLine);
        newlineIndex = buffer.indexOf('\n');
      }
    }

    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail) consumeLine(tail);
  } catch (error) {
    if (error instanceof SyntaxError) {
      const fallback = await parseJsonOrText(response);
      const message = typeof fallback === 'string' ? fallback : fallback?.error || fallback?.message || '创建失败';
      throw new Error(message);
    }
    throw error;
  }

  if (!result) {
    throw new Error('创建流程未返回结果');
  }

  return result;
}
