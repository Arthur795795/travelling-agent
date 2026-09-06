export default function HomePage() {
  return (
    <main className="shell hero" id="main-content" tabIndex={-1}>
      <p className="eyebrow">城市自由行 · 旅行 Agent</p>
      <h1>
        让想去的地方，
        <br />
        成为走得通的行程。
      </h1>
      <p>
        从你的时间、同行者和偏好出发，把地点、交通与待确认事项整理到一条时间线上。
      </p>
      <div className="actions">
        <a className="button" href="/demo">
          体验北京四日案例
        </a>
        <a className="button secondary" href="/plan">
          规划我的旅行
        </a>
      </div>
      <div className="cards">
        <section>
          <h2>先体验固定案例</h2>
          <p>无需 Key。固定案例入口与真实生成分开，不产生模型调用。</p>
        </section>
        <section>
          <h2>带着自己的需求出发</h2>
          <p>
            自定义规划使用你自己的 DeepSeek Key（BYOK），仅在本次使用期间保留。
          </p>
        </section>
      </div>
      <p className="muted">
        北京、上海、重庆、西安、杭州 · 3–5 天 · 1–6 人 · 单主城市
      </p>
      <p>
        我们不代订、不支付，也不承诺实时余票、库存或房态。预订请在第三方平台重新确认。
      </p>
    </main>
  );
}
