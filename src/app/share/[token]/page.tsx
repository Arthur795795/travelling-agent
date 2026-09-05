import { notFound } from "next/navigation";
import { shareService } from "../../../sharing/runtime.ts";
import { TripTimeline } from "../../../components/trip-timeline.tsx";
import { TripDetails } from "../../../components/trip-details.tsx";
export const dynamic = "force-dynamic";
export const metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer" as const,
};
export default async function SharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const share = shareService().read((await params).token);
  if (!share) notFound();
  return (
    <main className="shell">
      <p>只读分享 · 到期时间 {share.expiresAt}</p>
      <TripDetails trip={share.trip} showBudget={share.fields.budget} />
      <TripTimeline trip={share.trip} />
    </main>
  );
}
