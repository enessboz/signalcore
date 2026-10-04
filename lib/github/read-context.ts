export type GithubRepositoryContext = {
  repo_full_name: string;
  default_branch: string | null;
  private: boolean | null;
  description: string | null;
  language: string | null;
  readme: string | null;
  package_json: Record<string, unknown> | null;
  error: string | null;
};

function validateRepoFullName(value: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("Invalid GitHub repository name.");
  }
  return value;
}

async function githubFetch(path: string) {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "SignalCore/0.1",
  };

  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = "Bearer " + process.env.GITHUB_TOKEN;
  }

  const response = await fetch("https://api.github.com" + path, {
    headers,
    cache: "no-store",
  });

  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(
      "GitHub API " + response.status + ": " + (message.slice(0, 220) || response.statusText),
    );
  }

  return response.json();
}

function decodeBase64(content: string | undefined) {
  if (!content) return null;
  try {
    return Buffer.from(content.replace(/\n/g, ""), "base64").toString("utf8");
  } catch {
    return null;
  }
}

export async function fetchGithubRepositoryContext(
  repoFullName: string,
): Promise<GithubRepositoryContext> {
  const repo = validateRepoFullName(repoFullName);

  try {
    const metadata = (await githubFetch("/repos/" + repo)) as {
      default_branch?: string;
      private?: boolean;
      description?: string | null;
      language?: string | null;
    };

    let readme: string | null = null;
    let packageJson: Record<string, unknown> | null = null;

    try {
      const payload = (await githubFetch("/repos/" + repo + "/readme")) as {
        content?: string;
      };
      readme = decodeBase64(payload.content)?.slice(0, 12000) || null;
    } catch {
      // README is optional.
    }

    try {
      const payload = (await githubFetch("/repos/" + repo + "/contents/package.json")) as {
        content?: string;
      };
      const decoded = decodeBase64(payload.content);
      packageJson = decoded ? (JSON.parse(decoded) as Record<string, unknown>) : null;
    } catch {
      // Non-JS repositories may not have package.json.
    }

    return {
      repo_full_name: repo,
      default_branch: metadata.default_branch || null,
      private: metadata.private ?? null,
      description: metadata.description || null,
      language: metadata.language || null,
      readme,
      package_json: packageJson,
      error: null,
    };
  } catch (error) {
    return {
      repo_full_name: repo,
      default_branch: null,
      private: null,
      description: null,
      language: null,
      readme: null,
      package_json: null,
      error: error instanceof Error ? error.message : "GitHub context could not be loaded.",
    };
  }
}
