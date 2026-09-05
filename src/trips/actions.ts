import type { Trip } from "../domain/schema.ts";
import { safeLink } from "./presentation.ts";
export function tripActions(trip: Trip) {
  const result: {
    title: string;
    url: string;
    checkedAt: string;
    notice: string;
  }[] = [];
  for (const day of trip.days)
    for (const leg of day.legs) {
      const from = day.activities.find(
          (a) => a.place.id === leg.fromPlaceId,
        )?.place,
        to = day.activities.find((a) => a.place.id === leg.toPlaceId)?.place;
      let url = safeLink(leg.externalActionUrl);
      if (
        !url &&
        from?.longitude != null &&
        from.latitude != null &&
        to?.longitude != null &&
        to.latitude != null &&
        from.source === "amap" &&
        to.source === "amap"
      ) {
        const target = new URL("https://uri.amap.com/navigation");
        target.searchParams.set(
          "from",
          `${from.longitude},${from.latitude},${from.name}`,
        );
        target.searchParams.set(
          "to",
          `${to.longitude},${to.latitude},${to.name}`,
        );
        target.searchParams.set(
          "mode",
          leg.mode === "walk"
            ? "walk"
            : leg.mode === "public_transit"
              ? "bus"
              : "car",
        );
        target.searchParams.set("src", "travel-agent");
        target.searchParams.set("callnative", "0");
        url = target.href;
      }
      if (url)
        result.push({
          title: `${day.date} 在高德打开路线`,
          url,
          checkedAt: trip.updatedAt,
          notice: "依据行程坐标生成；以高德当前路线为准。",
        });
    }
  for (const e of trip.evidence.filter((e) => e.sourceType === "platform"))
    if (safeLink(e.url))
      result.push({
        title: e.sourceName,
        url: safeLink(e.url)!,
        checkedAt: e.checkedAt,
        notice: `${e.assertedValue ?? "平台搜索"}；第三方独立服务，无返佣。未读取实时库存，请在平台重新确认。`,
      });
  return result;
}
