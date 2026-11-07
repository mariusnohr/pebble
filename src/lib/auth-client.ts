export async function authRequest(path: string, body?: Record<string, unknown>) {
  const response = await fetch(
    `/api/auth/${path}`,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : { cache: "no-store" },
  );
  const data = await response.json();
  return { response, data };
}

export async function securityRequest(path: string, body?: Record<string, unknown>) {
  const { response, data } = await authRequest(path, body);
  if (!response.ok) throw new Error(data.message ?? "Could not save your changes. Try again.");
  return data;
}
