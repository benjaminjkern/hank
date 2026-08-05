import { notFound } from "next/navigation";

import { getCurrentUser } from "./currentUser";

// Gate for admin-only surfaces (`/admin/*` pages and APIs). 404s rather than
// 403s so the routes don't advertise their existence to non-admin users.
export async function requireAdmin() {
  const user = await getCurrentUser();
  if (!user.isAdmin) {
    notFound();
  }
  return user;
}
