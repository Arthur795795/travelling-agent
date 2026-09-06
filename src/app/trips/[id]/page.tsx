import TripWorkspace from "../../../components/trip-workspace.tsx";
import { decodePathSegment } from "../../../routing/path-segment.ts";
export default async function TripPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: encodedId } = await params;
  const id = decodePathSegment(encodedId);
  return (
    <main className="shell" id="main-content" tabIndex={-1}>
      <TripWorkspace id={id} />
    </main>
  );
}
