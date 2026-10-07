import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getLocale } from "@/lib/i18n";
import { approveAction, cancelAction, executeAction, rejectAction } from "./actions";
import { getExecutorCapability } from "@/lib/approvals/executors";

type SearchParams = Record<string, string | string[] | undefined>;

function scalar(value: string | string[] | undefined, fallback = "") {
  return Array.isArray(value) ? value[0] || fallback : value || fallback;
}

function riskClass(risk: string) {
  if (risk === "critical" || risk === "high") return "approvalRiskHigh";
  if (risk === "medium") return "approvalRiskMedium";
  return "approvalRiskLow";
}

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const query = await searchParams;
  const locale = await getLocale();
  const tr = locale === "tr";
  const status = scalar(query.status, "pending");
  const supabase = await createClient();

  const { data: projects } = await supabase
    .from("projects")
    .select("id,name")
    .order("name");

  let approvalsQuery = supabase
    .from("approvals")
    .select("id,project_id,agent_run_id,target_agent_key,action_type,status,payload,summary,risk_level,execution_status,execution_result,requested_at,decided_at")
    .order("requested_at", { ascending: false })
    .limit(100);

  if (status !== "all") approvalsQuery = approvalsQuery.eq("status", status);

  const { data: approvals, error } = await approvalsQuery;
  const projectMap = new Map((projects || []).map((project) => [project.id, project.name]));

  const pendingCount = (approvals || []).filter((item) => item.status === "pending").length;

  return (
    <div className="page">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">{tr ? "İnsan onay katmanı" : "Human approval gate"}</p>
          <h1>{tr ? "Onay Merkezi" : "Approval Center"}</h1>
          <p className="muted">
            {tr ? "Dış etkili aksiyonlar sen açıkça onaylayana kadar burada durur." : "External-impact actions stop here until you explicitly approve them."}
          </p>
        </div>
        <div className="approvalHeaderCount">
          <strong>{pendingCount}</strong>
          <span>{tr ? "bu görünümde bekliyor" : "pending in this view"}</span>
        </div>
      </header>

      {scalar(query.error) ? <p className="formMessage formError pageMessage">{scalar(query.error)}</p> : null}
      {scalar(query.message) ? <p className="formMessage formSuccess pageMessage">{scalar(query.message)}</p> : null}
      {error ? <p className="formMessage formError pageMessage">{error.message}</p> : null}

      <section className="panel filterPanel">
        <form method="get" className="filterForm">
          <label>
            {tr ? "Durum" : "Status"}
            <select name="status" defaultValue={status}>
              <option value="pending">{tr ? "Bekleyen" : "Pending"}</option>
              <option value="approved">{tr ? "Onaylandı" : "Approved"}</option>
              <option value="rejected">{tr ? "Reddedildi" : "Rejected"}</option>
              <option value="cancelled">{tr ? "İptal" : "Cancelled"}</option>
              <option value="expired">Expired</option>
              <option value="all">{tr ? "Tümü" : "All"}</option>
            </select>
          </label>
          <button className="secondaryButton" type="submit">{tr ? "Uygula" : "Apply"}</button>
        </form>
      </section>

      {(approvals || []).length ? (
        <section className="approvalList">
          {(approvals || []).map((approval) => {
            const payload = (approval.payload || {}) as Record<string, unknown>;
            const title = String(payload.title || approval.action_type.replaceAll("_", " "));
            const target = payload.target ? String(payload.target) : null;
            const instructions = payload.instructions ? String(payload.instructions) : null;
            const capability = getExecutorCapability(approval.action_type, payload);

            return (
              <article className="approvalCard" key={approval.id}>
                <div className="approvalTop">
                  <div className="approvalTags">
                    <span className={`approvalRisk ${riskClass(approval.risk_level)}`}>
                      {approval.risk_level} risk
                    </span>
                    <span className="sourceBadge">{approval.action_type.replaceAll("_", " ")}</span>
                    <span className="sourceBadge">{approval.target_agent_key || "agent"}</span>
                  </div>
                  <span className={`jobStatus job-${approval.status}`}>{approval.status}</span>
                </div>

                <div className="approvalTitle">
                  <div>
                    <p className="eyebrow">{projectMap.get(approval.project_id) || "Project"}</p>
                    <h2>{title}</h2>
                    <p>{approval.summary || String(payload.summary || "No summary provided.")}</p>
                  </div>
                  {approval.agent_run_id ? (
                    <Link className="ghostButton" href={`/agents?project=${approval.project_id}&run=${approval.agent_run_id}`}>
                      View agent run
                    </Link>
                  ) : null}
                </div>

                <div className="approvalDetails">
                  {target ? (
                    <div>
                      <strong>Target</strong>
                      <span>{target}</span>
                    </div>
                  ) : null}
                  {instructions ? (
                    <div>
                      <strong>Proposed execution</strong>
                      <span>{instructions}</span>
                    </div>
                  ) : null}
                  <div>
                    <strong>Execution state</strong>
                    <span>{approval.execution_status}</span>
                  </div>
                  <div>
                    <strong>Requested</strong>
                    <span>{new Date(approval.requested_at).toLocaleString("en-GB")}</span>
                  </div>
                </div>

                <div className="approvalExecutor">
                  <div>
                    <strong>{capability.label}</strong>
                    <span>{capability.reason}</span>
                  </div>
                  <span className={capability.executable ? "readinessBadge readinessReady" : "readinessBadge readinessOptional"}>
                    {capability.executable ? "executable" : capability.configured ? "payload blocked" : "not configured"}
                  </span>
                </div>

                {approval.status === "pending" ? (
                  <div className="approvalActions">
                    <form action={approveAction.bind(null, approval.id)}>
                      <button className="primaryButton" type="submit">{tr ? "Onayla" : "Approve"}</button>
                    </form>
                    <form action={rejectAction.bind(null, approval.id)}>
                      <button className="secondaryButton" type="submit">Reject</button>
                    </form>
                    <form action={cancelAction.bind(null, approval.id)}>
                      <button className="ghostButton" type="submit">Cancel</button>
                    </form>
                    <span>
                      Approval only marks the action ready. SignalCore will not claim execution until a compatible executor confirms it.
                    </span>
                  </div>
                ) : approval.status === "approved" && approval.execution_status === "ready" ? (
                  <div className="approvalActions">
                    {capability.executable ? (
                      <form action={executeAction.bind(null, approval.id)}>
                        <button className="primaryButton" type="submit">Execute approved action</button>
                      </form>
                    ) : (
                      <span>{capability.reason}</span>
                    )}
                    <span>
                      Execution is allowed only when a registered executor validates the target and payload.
                    </span>
                  </div>
                ) : (
                  <div className="approvalDecision">
                    <strong>{approval.status} · {approval.execution_status}</strong>
                    <span>{approval.decided_at ? new Date(approval.decided_at).toLocaleString("en-GB") : "—"}</span>
                  </div>
                )}
              </article>
            );
          })}
        </section>
      ) : (
        <section className="panel emptyState">
          <strong>No approvals in this view</strong>
          <span>Approval-required agent proposals will appear here automatically.</span>
        </section>
      )}
    </div>
  );
}
