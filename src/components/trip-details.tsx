import type { Claim, Trip } from "../domain/schema.ts";
import {
  AI_LABEL,
  evidenceLabels,
  moneyText,
  safeLink,
  statusLabels,
} from "../trips/presentation.ts";

const fieldLabels: Record<string, string> = {
  address: "地点",
  opening_hours: "开放时间",
  reservation_rules: "预约规则",
  weather: "天气",
  cost: "费用",
};

const categoryLabels: Record<string, string> = {
  intercity: "城际交通",
  lodging: "住宿",
  meals: "餐饮",
  local_transport: "市内交通",
  tickets: "门票与活动",
};

const lifecycleBadges: Record<Trip["lifecycleStatus"], string> = {
  draft: "草案",
  checked: "已检查",
  executable: "可执行",
  blocked: "需确认",
};

function groupedMessages(messages: string[]): Array<[string, number]> {
  const groups = new Map<string, number>();
  for (const message of messages)
    groups.set(message, (groups.get(message) ?? 0) + 1);
  return [...groups.entries()];
}

function claimTitle(trip: Trip, claim: Claim): string {
  return (
    trip.days
      .flatMap((day) => day.activities)
      .find((activity) => activity.id === claim.subjectId)?.title ?? "行程项目"
  );
}

export function TripDetails({
  trip,
  showBudget = true,
}: {
  trip: Trip;
  showBudget?: boolean;
}) {
  const blocking = trip.alerts.filter((alert) => alert.severity === "blocking");
  const criticalClaims = trip.claims.filter(
    (claim) => claim.critical !== false && claim.status !== "verified",
  );
  const alertGroups = groupedMessages(blocking.map((alert) => alert.message));
  const verifiedClaims = trip.claims.filter(
    (claim) => claim.status === "verified",
  ).length;
  const categories = [...new Set(trip.budget.items.map((item) => item.category))];

  return (
    <section className="trip-overview">
      <div className="trip-status-card">
        <div>
          <p className="eyebrow">
            {AI_LABEL} · {trip.model ?? "deepseek-v4-pro"}
          </p>
          <h2>行程概览</h2>
          <p className="status-copy">{statusLabels[trip.lifecycleStatus]}</p>
        </div>
        <span
          className={`status-pill ${trip.lifecycleStatus === "blocked" ? "status-pill-warning" : ""}`}
        >
          {lifecycleBadges[trip.lifecycleStatus]}
        </span>
      </div>

      {trip.preset && (
        <p role="note" className="notice-card">
          {trip.preset.notice} · 数据检查日期 {trip.preset.checkedAt} ·{" "}
          {trip.preset.humanReviewed ? "人工复核完成" : "人工出行核验待完成"}
        </p>
      )}

      {(blocking.length > 0 || criticalClaims.length > 0) && (
        <div role="alert" className="attention-card">
          <div>
            <h3>出发前建议确认</h3>
            <p>
              当前有 {blocking.length} 个行程检查项、{criticalClaims.length}{" "}
              条事实待核验。相同问题已合并，不影响你先查看和导出行程草案。
            </p>
          </div>
          <ul className="compact-list">
            {alertGroups.map(([message, count]) => (
              <li key={message}>
                {message}
                {count > 1 ? `（涉及 ${count} 项）` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      {showBudget && (
        <section className="summary-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">预算</p>
              <h2>分类预算</h2>
            </div>
            <p>
              {moneyText(trip.budget.total)} · 含 {trip.budget.contingencyPercent}%
              机动金
            </p>
          </div>
          {trip.brief.budget.limit && (
            <p>预算上限：{moneyText(trip.brief.budget.limit)}</p>
          )}
          {trip.budget.withinLimit === false && (
            <p role="alert" className="inline-warning">
              当前估算超过预算上限
            </p>
          )}
          <div className="budget-grid">
            {categories.map((category) => {
              const items = trip.budget.items.filter(
                (item) => item.category === category,
              );
              const unknown = items.filter(
                (item) => item.cost.kind === "unknown",
              ).length;
              return (
                <div className="metric-card" key={category}>
                  <strong>{categoryLabels[category] ?? category}</strong>
                  <span>
                    {items.length} 项
                    {unknown ? ` · ${unknown} 项待确认` : " · 已有估算"}
                  </span>
                </div>
              );
            })}
          </div>
          <details className="disclosure-card">
            <summary>查看预算明细（{trip.budget.items.length} 项）</summary>
            <ul className="compact-list">
              {trip.budget.items.map((item) => (
                <li key={item.id}>
                  <strong>{item.title}</strong> · {moneyText(item.cost)} ·{" "}
                  {item.paymentStatus === "paid"
                    ? "已付款"
                    : item.paymentStatus === "unknown"
                      ? "待确认"
                      : "估算"}
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}

      <section className="summary-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">依据</p>
            <h2>关键事实与来源</h2>
          </div>
          <p>
            已核验 {verifiedClaims} · 待核验 {criticalClaims.length}
          </p>
        </div>
        <details className="disclosure-card">
          <summary>查看来源和技术核验记录（{trip.claims.length} 条）</summary>
          <div className="evidence-list">
            {trip.claims.map((claim) => (
              <details key={claim.id}>
                <summary>
                  {claimTitle(trip, claim)} · {fieldLabels[claim.field] ?? claim.field}
                  {" · "}
                  {evidenceLabels[claim.status]}
                  {claim.conflictEvidenceIds.length ? " · 来源冲突" : ""}
                </summary>
                {claim.value != null && <p>{String(claim.value)}</p>}
                {[...new Set([...claim.evidenceIds, ...claim.conflictEvidenceIds])].map(
                  (id) => {
                    const evidence = trip.evidence.find((item) => item.id === id);
                    if (!evidence) return <p key={id}>来源缺失，需复核</p>;
                    const link = safeLink(evidence.url);
                    return (
                      <p key={id} className="source-row">
                        {link ? (
                          <a href={link} target="_blank" rel="noreferrer">
                            {evidence.sourceName}
                          </a>
                        ) : (
                          evidence.sourceName
                        )}{" "}
                        · {evidenceLabels[evidence.status]} · {evidence.checkedAt}
                        {evidence.excerpt ? ` · ${evidence.excerpt}` : ""}
                      </p>
                    );
                  },
                )}
              </details>
            ))}
          </div>
        </details>
      </section>
    </section>
  );
}
