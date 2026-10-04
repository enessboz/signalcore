import type { SupabaseClient } from "@supabase/supabase-js";
import { crawlPage } from "@/lib/crawl/http-crawler";
import { createClient } from "@/lib/supabase/server";

function numericBreakdown(value: unknown) {
  const input = (value || {}) as Record<string, unknown>;
  return {
    serp_opportunity: Number(input.serp_opportunity || 0),
    business_fit: Number(input.business_fit || 0),
    web_presence: Number(input.web_presence || 0),
    technical_opportunity: Number(input.technical_opportunity || 0),
    contactability: Number(input.contactability || 0),
  };
}

function scoreTechnical(page: Awaited<ReturnType<typeof crawlPage>>) {
  if (page.fetchError || !page.statusCode || page.statusCode >= 400) return 0;
  let score = 0;
  if (!page.title) score += 4;
  if (!page.metaDescription) score += 4;
  if (!page.h1s.length) score += 4;
  if (!page.canonical) score += 3;
  if (page.wordCount < 250) score += 3;
  if (page.responseMs && page.responseMs > 1800) score += 3;
  if (page.structuredDataCount === 0) score += 2;
  if (page.imageCount >= 3 && page.missingAltCount / page.imageCount >= 0.3) score += 2;
  return Math.min(score, 25);
}

function publicContacts(page: Awaited<ReturnType<typeof crawlPage>>) {
  const meta = (page.metadata || {}) as Record<string, unknown>;
  const emails = Array.isArray(meta.email_sample)
    ? meta.email_sample.map(String).filter(Boolean)
    : [];
  const phones = Array.isArray(meta.phone_sample)
    ? meta.phone_sample.map(String).filter(Boolean)
    : [];
  return { emails, phones };
}

export async function qualifySalesLead(input: {
  ownerId: string;
  leadId: string;
  client?: SupabaseClient;
}) {
  const supabase = input.client || (await createClient());

  const { data: lead, error } = await supabase
    .from("sales_leads")
    .select("id,domain,company_name,score,score_breakdown,evidence,stage,qualification_status")
    .eq("id", input.leadId)
    .eq("owner_id", input.ownerId)
    .single();

  if (error || !lead) throw new Error(error?.message || "Lead not found.");

  const { data: campaignLink } = await supabase
    .from("sales_campaign_leads")
    .select("campaign_id,sales_campaigns(min_score)")
    .eq("lead_id", lead.id)
    .eq("owner_id", input.ownerId)
    .order("discovered_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const campaignNested = Array.isArray(campaignLink?.sales_campaigns)
    ? campaignLink?.sales_campaigns[0]
    : campaignLink?.sales_campaigns;
  const minScore = Number(campaignNested?.min_score || 65);

  const seed = "https://" + lead.domain;
  const origin = new URL(seed).origin;
  const page = await crawlPage(seed, origin);

  const breakdown = numericBreakdown(lead.score_breakdown);
  breakdown.technical_opportunity = scoreTechnical(page);

  const contacts = publicContacts(page);
  breakdown.contactability =
    (contacts.emails.length ? 7 : 0) + (contacts.phones.length ? 3 : 0);

  const score = Math.min(
    Object.values(breakdown).reduce((sum, value) => sum + value, 0),
    100,
  );

  let qualificationStatus: "qualified" | "needs_review" | "rejected";
  let stage: string;

  if (page.fetchError || !page.statusCode) {
    qualificationStatus = "needs_review";
    stage = lead.stage;
  } else if (score >= minScore) {
    qualificationStatus = "qualified";
    stage = "qualified";
  } else if (score < 45) {
    qualificationStatus = "rejected";
    stage = "rejected";
  } else {
    qualificationStatus = "needs_review";
    stage = lead.stage;
  }

  const evidence = {
    ...((lead.evidence || {}) as Record<string, unknown>),
    homepage_qualification: {
      checked_at: new Date().toISOString(),
      url: page.url,
      status_code: page.statusCode,
      response_ms: page.responseMs,
      title: page.title,
      meta_description: page.metaDescription,
      canonical: page.canonical,
      h1_count: page.h1s.length,
      word_count: page.wordCount,
      structured_data_count: page.structuredDataCount,
      image_count: page.imageCount,
      missing_alt_count: page.missingAltCount,
      fetch_error: page.fetchError,
      public_emails: contacts.emails,
      public_phones: contacts.phones,
    },
  };

  const { error: updateError } = await supabase
    .from("sales_leads")
    .update({
      score,
      score_breakdown: breakdown,
      evidence,
      qualification_status: qualificationStatus,
      stage,
      last_qualified_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", lead.id)
    .eq("owner_id", input.ownerId);

  if (updateError) throw new Error(updateError.message);

  const { data: existingContacts } = await supabase
    .from("sales_contacts")
    .select("email,phone")
    .eq("lead_id", lead.id)
    .eq("owner_id", input.ownerId);

  const knownEmails = new Set((existingContacts || []).map((item) => item.email).filter(Boolean));
  const knownPhones = new Set((existingContacts || []).map((item) => item.phone).filter(Boolean));
  const contactRows = [
    ...contacts.emails
      .filter((email) => !knownEmails.has(email))
      .map((email) => ({
        lead_id: lead.id,
        owner_id: input.ownerId,
        email,
        source: "public_homepage_mailto",
        verification_status: "unverified",
      })),
    ...contacts.phones
      .filter((phone) => !knownPhones.has(phone))
      .map((phone) => ({
        lead_id: lead.id,
        owner_id: input.ownerId,
        phone,
        source: "public_homepage_tel",
        verification_status: "unverified",
      })),
  ];

  if (contactRows.length) {
    const { error: contactError } = await supabase.from("sales_contacts").insert(contactRows);
    if (contactError) throw new Error(contactError.message);
  }

  await supabase.from("sales_events").insert({
    lead_id: lead.id,
    owner_id: input.ownerId,
    event_type: "qualified",
    summary: `Homepage qualification completed with score ${score}/100 (${qualificationStatus}).`,
    metadata: {
      score,
      min_score: minScore,
      score_breakdown: breakdown,
      public_contact_count: contacts.emails.length + contacts.phones.length,
    },
  });

  return {
    leadId: lead.id as string,
    score,
    minScore,
    qualificationStatus,
    stage,
    breakdown,
    page,
    contacts,
  };
}
