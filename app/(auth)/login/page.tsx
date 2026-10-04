import { login, signup } from "./actions";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string }>;
}) {
  const params = await searchParams;

  return (
    <main className="authPage">
      <section className="authCard">
        <div className="authBrand">
          <span className="brandMark">S</span>
          <div>
            <strong>SignalCore</strong>
            <small>Evidence → Action</small>
          </div>
        </div>

        <div>
          <p className="eyebrow">Internal workspace</p>
          <h1>Sign in</h1>
          <p className="muted">Access project intelligence, monitoring and sales workflows.</p>
        </div>

        {params.error ? <p className="formMessage formError">{params.error}</p> : null}
        {params.message ? <p className="formMessage formSuccess">{params.message}</p> : null}

        <form className="formPanel" action={login}>
          <label>
            Email
            <input name="email" type="email" autoComplete="email" required />
          </label>
          <label>
            Password
            <input name="password" type="password" autoComplete="current-password" minLength={8} required />
          </label>
          <div className="buttonRow">
            <button className="primaryButton" type="submit">Sign in</button>
            <button className="secondaryButton" formAction={signup}>Create account</button>
          </div>
        </form>
      </section>
    </main>
  );
}
