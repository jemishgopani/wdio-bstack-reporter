export interface CIContext {
  batchId: string;
  provider: string;
  branch?: string;
  commit?: string;
  buildUrl?: string;
}

export function detectCI(env: NodeJS.ProcessEnv = process.env): CIContext | undefined {
  if (env.GITHUB_ACTIONS === 'true' && env.GITHUB_RUN_ID) {
    const ctx: CIContext = { batchId: env.GITHUB_RUN_ID, provider: 'github-actions' };
    if (env.GITHUB_REF_NAME) ctx.branch = env.GITHUB_REF_NAME;
    if (env.GITHUB_SHA) ctx.commit = env.GITHUB_SHA;
    if (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY) {
      ctx.buildUrl = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
    }
    return ctx;
  }
  if (env.GITLAB_CI === 'true' && env.CI_PIPELINE_ID) {
    const ctx: CIContext = { batchId: env.CI_PIPELINE_ID, provider: 'gitlab-ci' };
    if (env.CI_COMMIT_REF_NAME) ctx.branch = env.CI_COMMIT_REF_NAME;
    if (env.CI_COMMIT_SHA) ctx.commit = env.CI_COMMIT_SHA;
    if (env.CI_PIPELINE_URL) ctx.buildUrl = env.CI_PIPELINE_URL;
    return ctx;
  }
  if (env.CIRCLECI === 'true' && (env.CIRCLE_WORKFLOW_ID || env.CIRCLE_BUILD_NUM)) {
    const batchId = env.CIRCLE_WORKFLOW_ID ?? env.CIRCLE_BUILD_NUM!;
    const ctx: CIContext = { batchId, provider: 'circleci' };
    if (env.CIRCLE_BRANCH) ctx.branch = env.CIRCLE_BRANCH;
    if (env.CIRCLE_SHA1) ctx.commit = env.CIRCLE_SHA1;
    if (env.CIRCLE_BUILD_URL) ctx.buildUrl = env.CIRCLE_BUILD_URL;
    return ctx;
  }
  if (env.JENKINS_URL && env.BUILD_NUMBER) {
    const ctx: CIContext = { batchId: env.BUILD_NUMBER, provider: 'jenkins' };
    if (env.GIT_BRANCH) ctx.branch = env.GIT_BRANCH;
    if (env.GIT_COMMIT) ctx.commit = env.GIT_COMMIT;
    if (env.BUILD_URL) ctx.buildUrl = env.BUILD_URL;
    return ctx;
  }
  if (env.BUILDKITE === 'true' && env.BUILDKITE_BUILD_ID) {
    const ctx: CIContext = { batchId: env.BUILDKITE_BUILD_ID, provider: 'buildkite' };
    if (env.BUILDKITE_BRANCH) ctx.branch = env.BUILDKITE_BRANCH;
    if (env.BUILDKITE_COMMIT) ctx.commit = env.BUILDKITE_COMMIT;
    if (env.BUILDKITE_BUILD_URL) ctx.buildUrl = env.BUILDKITE_BUILD_URL;
    return ctx;
  }
  return undefined;
}
