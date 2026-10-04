"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

function value(formData: FormData, key: string) {
  const raw = formData.get(key);
  return typeof raw === "string" ? raw.trim() : "";
}

export async function login(formData: FormData) {
  const email = value(formData, "email");
  const password = value(formData, "password");

  if (!email || !password) {
    redirect("/login?error=Email%20and%20password%20are%20required");
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) redirect(`/login?error=${encodeURIComponent(error.message)}`);
  redirect("/");
}

export async function signup(formData: FormData) {
  const email = value(formData, "email");
  const password = value(formData, "password");

  if (!email || password.length < 8) {
    redirect("/login?error=Use%20a%20valid%20email%20and%20an%208%2B%20character%20password");
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({ email, password });

  if (error) redirect(`/login?error=${encodeURIComponent(error.message)}`);

  if (!data.session) {
    redirect("/login?message=Account%20created.%20Check%20your%20email%20to%20confirm%20the%20account.");
  }

  redirect("/");
}
