export function isOperator(email: string) {
  return (process.env.OPERATOR_EMAILS ?? "")
    .split(",")
    .some((entry) => entry.trim().toLowerCase() === email.trim().toLowerCase());
}

// Invitations extend this single policy when invitation acceptance ships.
export function signupAllowed(email: string) {
  return process.env.SIGNUP_OPEN === "true" || isOperator(email);
}
