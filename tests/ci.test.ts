import { describe, expect, it } from 'vitest';
import { detectCI } from '../src/ci.js';

describe('detectCI', () => {
  it('returns undefined when no CI env vars match', () => {
    expect(detectCI({})).toBeUndefined();
  });

  it('detects GitHub Actions', () => {
    const ci = detectCI({
      GITHUB_ACTIONS: 'true',
      GITHUB_RUN_ID: '12345',
      GITHUB_REF_NAME: 'main',
      GITHUB_SHA: 'abc',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'foo/bar',
    });
    expect(ci).toEqual({
      batchId: '12345',
      provider: 'github-actions',
      branch: 'main',
      commit: 'abc',
      buildUrl: 'https://github.com/foo/bar/actions/runs/12345',
    });
  });

  it('detects GitLab CI', () => {
    const ci = detectCI({ GITLAB_CI: 'true', CI_PIPELINE_ID: '999' });
    expect(ci?.provider).toBe('gitlab-ci');
    expect(ci?.batchId).toBe('999');
  });

  it('detects CircleCI by workflow id', () => {
    const ci = detectCI({ CIRCLECI: 'true', CIRCLE_WORKFLOW_ID: 'wf-1' });
    expect(ci?.batchId).toBe('wf-1');
  });

  it('detects Jenkins', () => {
    const ci = detectCI({ JENKINS_URL: 'http://j', BUILD_NUMBER: '42' });
    expect(ci?.provider).toBe('jenkins');
    expect(ci?.batchId).toBe('42');
  });
});
