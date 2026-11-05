import type { HttpClient } from "../../ai/types";
import type { ForgeRemote } from "../remote";
import type { ForgeProvider } from "../provider";
import { createForgeJsonRequest, pullRequestCheckoutSpec, toUnix } from "../shared";
import {
  ForgeError,
  type CreatePullRequestInput,
  type ForgeUser,
  type PullRequestCheckoutSpec,
  type PullRequestInfo,
} from "../types";

interface BitbucketEndpoint {
  branch?: { name?: string };
  commit?: { hash?: string };
  repository?: { full_name?: string } | null;
}

interface BitbucketPull {
  id: number;
  title?: string;
  state?: string;
  draft?: boolean;
  created_on?: string;
  updated_on?: string;
  author?: {
    display_name?: string;
    nickname?: string;
    links?: { avatar?: { href?: string } };
  } | null;
  source?: BitbucketEndpoint;
  destination?: BitbucketEndpoint;
  links?: { html?: { href?: string } };
}

function bitbucketMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; detail?: string } };
    if (parsed.error?.message && parsed.error.detail) {
      return `${parsed.error.message} (${parsed.error.detail})`;
    }
    return parsed.error?.message ?? null;
  } catch {
    return null;
  }
}

export function bitbucketForgeProvider(remote: ForgeRemote, http: HttpClient): ForgeProvider {
  const apiBase = "https://api.bitbucket.org/2.0";
  const repoPath = `${remote.owner}/${remote.repo}`;
  const requestJson = createForgeJsonRequest(http, "bitbucket", "Bitbucket", bitbucketMessage);

  const request = (method: "GET" | "POST", path: string, payload?: unknown) =>
    requestJson(`${apiBase}${path}`, method, payload);

  const mapPull = (pull: BitbucketPull): PullRequestInfo => {
    const sourceRepo = pull.source?.repository?.full_name ?? null;
    const state: PullRequestInfo["state"] =
      pull.state === "MERGED" ? "merged" : pull.state === "OPEN" ? "open" : "closed";
    return {
      number: pull.id,
      title: pull.title ?? `#${pull.id}`,
      author: pull.author?.nickname ?? pull.author?.display_name ?? "unknown",
      authorAvatarUrl: pull.author?.links?.avatar?.href ?? null,
      sourceBranch: pull.source?.branch?.name ?? "",
      targetBranch: pull.destination?.branch?.name ?? "",
      url: pull.links?.html?.href ?? "",
      state,
      isDraft: pull.draft === true,
      isFromFork: sourceRepo === null || sourceRepo.toLowerCase() !== repoPath.toLowerCase(),
      headSha: pull.source?.commit?.hash ?? "",
      createdAt: toUnix(pull.created_on),
      updatedAt: toUnix(pull.updated_on),
    };
  };

  return {
    kind: "bitbucket",
    label: "Bitbucket",

    async listOpenPullRequests(): Promise<PullRequestInfo[]> {
      const data = (await request(
        "GET",
        `/repositories/${repoPath}/pullrequests?state=OPEN&sort=-updated_on&pagelen=50`
      )) as { values?: BitbucketPull[] };
      if (!Array.isArray(data.values)) {
        throw new ForgeError("Bitbucket returned an unexpected response", "bitbucket");
      }
      return data.values.map(mapPull);
    },

    async defaultBranch(): Promise<string> {
      const data = (await request("GET", `/repositories/${repoPath}`)) as {
        mainbranch?: { name?: string };
      };
      return data.mainbranch?.name ?? "main";
    },

    async authorAvatar(input): Promise<string | null> {
      const data = (await request("GET", `/repositories/${repoPath}/commit/${input.sha}`)) as {
        author?: { user?: { links?: { avatar?: { href?: string } } } };
      };
      return data.author?.user?.links?.avatar?.href ?? null;
    },

    async listReviewerCandidates(): Promise<ForgeUser[]> {
      const data = (await request("GET", `/workspaces/${remote.owner}/members?pagelen=100`)) as {
        values?: Array<{
          user?: {
            uuid?: string;
            nickname?: string;
            display_name?: string;
            links?: { avatar?: { href?: string } };
          };
        }>;
      };
      if (!Array.isArray(data.values)) return [];
      return data.values
        .filter((entry) => entry.user?.uuid)
        .map((entry) => ({
          id: entry.user?.uuid as string,
          username: entry.user?.nickname ?? (entry.user?.uuid as string),
          name: entry.user?.display_name ?? entry.user?.nickname ?? (entry.user?.uuid as string),
          avatarUrl: entry.user?.links?.avatar?.href ?? null,
        }));
    },

    async createPullRequest(input: CreatePullRequestInput): Promise<PullRequestInfo> {
      const data = (await request("POST", `/repositories/${repoPath}/pullrequests`, {
        title: input.title,
        description: input.body,
        source: {
          branch: { name: input.sourceBranch },
          ...(input.sourceRepo
            ? { repository: { full_name: `${input.sourceRepo.owner}/${input.sourceRepo.repo}` } }
            : {}),
        },
        destination: { branch: { name: input.targetBranch } },
        ...(input.draft ? { draft: true } : {}),
        ...(input.reviewerIds?.length
          ? { reviewers: input.reviewerIds.map((uuid) => ({ uuid })) }
          : {}),
      })) as BitbucketPull;
      return mapPull(data);
    },

    checkoutSpec(pr: PullRequestInfo): PullRequestCheckoutSpec | null {
      return pullRequestCheckoutSpec("bitbucket", pr);
    },
  };
}
