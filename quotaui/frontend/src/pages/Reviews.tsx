// Two-person review queue (§9.2). Operator/admin approve or reject pending,
// high-blast-radius changes; the initiator may not approve their own.
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { ErrorText } from "../components";
import type { Review } from "../types";

export function Reviews() {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setReviews((await api.listReviews()).reviews);
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (id: string, approve: boolean) => {
    setError(null);
    try {
      if (approve) await api.approveReview(id);
      else await api.rejectReview(id);
      await load();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <section>
      <h2>Pending reviews</h2>
      <ErrorText error={error} />
      {reviews.length === 0 && <p className="muted">no pending reviews</p>}
      {reviews.map((r) => (
        <div className="panel" key={r.id}>
          <p>
            <strong>{r.op.kind}</strong> — {r.reason}
          </p>
          <p className="muted">
            initiated by {r.initiator} at {r.createdAt}
          </p>
          <pre className="op">{JSON.stringify(r.op, null, 2)}</pre>
          <div className="actions">
            <button className="danger" onClick={() => decide(r.id, false)}>
              Reject
            </button>
            <button className="primary" onClick={() => decide(r.id, true)}>
              Approve &amp; apply
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
