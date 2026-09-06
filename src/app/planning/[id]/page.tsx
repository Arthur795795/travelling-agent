import JobProgress from "../../../components/job-progress.tsx";
export default async function PlanningPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <main className="shell" id="main-content" tabIndex={-1}>
      <JobProgress id={id} />
    </main>
  );
}
