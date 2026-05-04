import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CollectorClient } from '../src/client/collector.js';

describe('CollectorClient JWT 401 fallback', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('drops JWT and retries with Basic auth on 401', async () => {
    const client = new CollectorClient({ username: 'u', accessKey: 'k', maxRetries: 0 });
    client.attachBuild({ buildId: 'b1', jwt: 'expired' });

    fetchMock
      .mockResolvedValueOnce(new Response('expired', { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));

    await client.sendEvents([
      {
        event_type: 'TestRunStarted',
        test_run: {
          uuid: '1',
          name: 't',
          scope: '',
          scopes: [],
          identifier: 't',
          file_name: '',
          location: '',
          started_at: new Date().toISOString(),
        },
      },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstAuth = fetchMock.mock.calls[0]?.[1].headers.authorization;
    const secondAuth = fetchMock.mock.calls[1]?.[1].authorization ?? fetchMock.mock.calls[1]?.[1].headers.authorization;
    expect(firstAuth).toBe('Bearer expired');
    expect(secondAuth).toMatch(/^Basic /);
  });

  it('does not retry on 401 when no JWT is set', async () => {
    const client = new CollectorClient({ username: 'u', accessKey: 'k', maxRetries: 0 });
    client.attachBuild({ buildId: 'b1' });

    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 401 }));

    await expect(
      client.sendEvents([
        {
          event_type: 'TestRunStarted',
          test_run: {
            uuid: '1',
            name: 't',
            scope: '',
            scopes: [],
            identifier: 't',
            file_name: '',
            location: '',
            started_at: new Date().toISOString(),
          },
        },
      ]),
    ).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
