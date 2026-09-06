import PlanningForm from "../../components/planning-form.tsx";
export default function PlanPage() {
  return (
    <main className="shell" id="main-content" tabIndex={-1}>
      <p className="eyebrow">自定义规划 · BYOK</p>
      <h1>从你的旅行开始</h1>
      <PlanningForm />
    </main>
  );
}
