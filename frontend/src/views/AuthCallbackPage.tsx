import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { finishGoogleSignIn } from "../api/auth";

function errorMessage(code: string) {
  if (code.startsWith("account_at_")) {
    const branch = code.replace("account_at_", "");
    return `This email already has an account at ${branch}. Log in there instead.`;
  }
  return "Google sign-in failed. Please try again.";
}

export default function AuthCallbackPage() {
  const [error, setError] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const token = params.get("token");
    const refreshToken = params.get("refreshToken");
    const errorCode = params.get("error");

    if (token && refreshToken) {
      finishGoogleSignIn(token, refreshToken)
        .then(() => navigate("/", { replace: true }))
        .catch(() => setError(errorMessage("")));
    } else {
      setError(errorMessage(errorCode ?? ""));
    }
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center p-6 font-serif">
      {error ? (
        <p className="text-red-700" role="alert">{error}</p>
      ) : (
        <p>Signing you in...</p>
      )}
    </div>
  );
}