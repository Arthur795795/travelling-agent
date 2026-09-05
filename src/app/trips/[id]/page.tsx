import TripWorkspace from "../../../components/trip-workspace.tsx";
export default async function TripPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <main className="shell">
      <TripWorkspace id={id} />
    </main>
  );
}
