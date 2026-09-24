export function Unmapped({ title }: { title: string }) {
  return (
    <div className="card">
      <div className="kicker">Waiting for account link</div>
      <p>If you just connected from {title}, your account may take a few seconds to appear. Otherwise, set up your agent in the {title} web app first.</p>
    </div>
  );
}
