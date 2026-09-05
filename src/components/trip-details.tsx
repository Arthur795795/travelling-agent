import type { Trip } from "../domain/schema.ts";
import {
  AI_LABEL,
  evidenceLabels,
  moneyText,
  safeLink,
  statusLabels,
} from "../trips/presentation.ts";
export function TripDetails({
  trip,
  showBudget = true,
}: {
  trip: Trip;
  showBudget?: boolean;
}) {
  const blocking = trip.alerts.filter((a) => a.severity === "blocking");
  const failed = trip.claims.filter(
    (c) => c.critical !== false && c.status !== "verified",
  );
  return (
    <section>
      <p>
        {AI_LABEL} · {trip.model ?? "deepseek-v4-pro"}
      </p>
      {trip.preset && (
        <p role="note">
          {trip.preset.notice} · 数据检查日期 {trip.preset.checkedAt} ·{" "}
          {trip.preset.humanReviewed ? "人工复核完成" : "人工出行核验待完成"}
        </p>
      )}
      <h2>行程状态</h2>
      <p>{statusLabels[trip.lifecycleStatus]}</p>
      {(blocking.length > 0 ||
        failed.length > 0 ||
        trip.lifecycleStatus === "blocked") && (
        <div role="alert">
          <h3>出发前必须解决</h3>
          {blocking.map((a) => (
            <p key={a.id}>{a.message}</p>
          ))}
          {failed.map((c) => (
            <p key={c.id}>
              {c.subjectId} · {c.field}：{evidenceLabels[c.status]}
            </p>
          ))}
        </div>
      )}
      {showBudget && (
        <>
          <h2>分类预算</h2>
          <p>
            总计：{moneyText(trip.budget.total)} · 机动金{" "}
            {trip.budget.contingencyPercent}%
          </p>
          {trip.brief.budget.limit && (
            <p>预算上限：{moneyText(trip.brief.budget.limit)}</p>
          )}
          {trip.budget.withinLimit === false && <p role="alert">预算超限</p>}
          <ul>
            {trip.budget.items.map((i) => (
              <li key={i.id}>
                {i.category} · {i.title}：{moneyText(i.cost)} ·{" "}
                {i.paymentStatus === "paid"
                  ? "已付款"
                  : i.paymentStatus === "unknown"
                    ? "未知"
                    : "估算"}
              </li>
            ))}
          </ul>
        </>
      )}
      <h2>关键事实与来源</h2>
      {trip.claims.map((c) => (
        <details key={c.id}>
          <summary>
            {c.subjectId} · {c.field} · {evidenceLabels[c.status]}
            {c.conflictEvidenceIds.length ? " · 存在来源冲突" : ""}
          </summary>
          {c.value != null && <p>{String(c.value)}</p>}
          {[...new Set([...c.evidenceIds, ...c.conflictEvidenceIds])].map(
            (id) => {
              const e = trip.evidence.find((e) => e.id === id);
              return e ? (
                <p key={id}>
                  {safeLink(e.url) ? (
                    <a href={safeLink(e.url)} target="_blank" rel="noreferrer">
                      {e.sourceName}
                    </a>
                  ) : (
                    e.sourceName
                  )}{" "}
                  · {evidenceLabels[e.status]} · 查询时间 {e.checkedAt}
                  {e.excerpt && <span> · {e.excerpt}</span>}
                </p>
              ) : (
                <p key={id}>来源缺失：需复核</p>
              );
            },
          )}
        </details>
      ))}
    </section>
  );
}
