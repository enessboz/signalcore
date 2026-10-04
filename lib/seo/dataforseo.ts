type DataForSeoItem = {
  type?: string;
  rank_group?: number;
  rank_absolute?: number;
  position?: string;
  domain?: string;
  title?: string;
  url?: string;
  description?: string;
  breadcrumb?: string;
};

type DataForSeoResponse = {
  status_code?: number;
  status_message?: string;
  tasks?: Array<{
    status_code?: number;
    status_message?: string;
    cost?: number;
    result?: Array<{
      keyword?: string;
      check_url?: string;
      items?: DataForSeoItem[];
      item_types?: string[];
    }>;
  }>;
};

export async function fetchGoogleOrganicSerp(input: {
  keyword: string;
  locationCode?: number;
  languageCode?: string;
  device?: "desktop" | "mobile";
  depth?: number;
}) {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;

  if (!login || !password) {
    throw new Error(
      "DataForSEO credentials are not configured. Add DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD to Vercel.",
    );
  }

  const keyword = input.keyword.trim();
  if (!keyword) throw new Error("SERP keyword is empty.");

  const depth = Math.min(Math.max(input.depth || 20, 10), 100);
  const auth = Buffer.from(login + ":" + password).toString("base64");
  const response = await fetch(
    "https://api.dataforseo.com/v3/serp/google/organic/live/advanced",
    {
      method: "POST",
      headers: {
        Authorization: "Basic " + auth,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([
        {
          keyword,
          location_code: input.locationCode || 2840,
          language_code: input.languageCode || "en",
          device: input.device || "desktop",
          depth,
        },
      ]),
      cache: "no-store",
    },
  );

  const payload = (await response.json()) as DataForSeoResponse;
  const task = payload.tasks?.[0];
  const result = task?.result?.[0];

  if (
    !response.ok ||
    payload.status_code !== 20000 ||
    task?.status_code !== 20000 ||
    !result
  ) {
    throw new Error(
      task?.status_message ||
        payload.status_message ||
        "DataForSEO SERP request failed.",
    );
  }

  const organic = (result.items || [])
    .filter((item) => item.type === "organic")
    .slice(0, depth)
    .map((item) => ({
      rank: item.rank_absolute || item.rank_group || null,
      domain: item.domain || null,
      title: item.title || null,
      url: item.url || null,
      description: item.description || null,
      breadcrumb: item.breadcrumb || null,
    }));

  return {
    keyword: result.keyword || keyword,
    check_url: result.check_url || null,
    organic,
    serp_features: (result.item_types || []).filter((type) => type !== "organic"),
    cost: Number(task.cost || 0),
  };
}
