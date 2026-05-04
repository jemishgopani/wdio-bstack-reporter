import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { httpRequest, HttpError } from '../src/client/http.js';

describe('httpRequest', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns parsed JSON on 200', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const res = await httpRequest<{ ok: number }>({ method: 'GET', url: 'http://x' });
    expect(res).toEqual({ ok: 1 });
  });

  it('retries 5xx and eventually succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(new Response('boom', { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const res = await httpRequest({
      method: 'POST',
      url: 'http://x',
      body: { a: 1 },
      sleep: () => Promise.resolve(),
    });
    expect(res).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('throws HttpError after exhausting retries on 5xx', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 503 }));
    await expect(
      httpRequest({ method: 'GET', url: 'http://x', maxRetries: 1, sleep: () => Promise.resolve() }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry 4xx (other than 408/429)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad', { status: 400 }));
    await expect(
      httpRequest({ method: 'GET', url: 'http://x', sleep: () => Promise.resolve() }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries on 429', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('slow down', { status: 429 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await httpRequest({ method: 'GET', url: 'http://x', sleep: () => Promise.resolve() });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
