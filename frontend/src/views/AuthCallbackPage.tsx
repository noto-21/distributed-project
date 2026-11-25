import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
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

    // The page text stays as the fallback; the toast is what the user notices. A fixed id stops repeats.
    const fail = (text: string) => {
      setError(text);
      toast.error(text, { id: "google-sign-in" });
    };

    if (token && refreshToken) {
      finishGoogleSignIn(token, refreshToken)
        .then(() => {
          toast.success("Signed in with Google.", { id: "google-sign-in" });
          navigate("/", { replace: true });
        })
        .catch(() => fail(errorMessage("")));
    } else {
      fail(errorMessage(errorCode ?? ""));
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